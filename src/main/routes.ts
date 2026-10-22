// 兑换（swap）与跨链（bridge）。
// 主网：LI.FI 聚合器（EVM 全系 + Solana，可收款到 Tron）；测试网：Uniswap V3 与官方桥。
// 所有合约地址写死在白名单里，聚合器返回的交易必须指向白名单合约、收款人必须是自己，否则拦截。
import { randomUUID } from 'node:crypto'
import { VersionedTransaction } from '@solana/web3.js'
import { type Hex, encodeFunctionData, erc20Abi, formatUnits, parseAbi } from 'viem'
import type { RiskCheck, RouteCard } from '../shared/types'
import { evm, explainError, explainSolana, feeParams, publicClient, sendCall, shortErr } from './adapters/evm'
import { onSolana, solana } from './adapters/solana'
import type { Asset, ChainAdapter } from './adapters/types'
import { tron } from './adapters/tron'
import { type Network, explorerTx, summary } from './chains/registry'
import { type Signers, addresses, signers } from './keystore'
import { settings } from './settings'
import { progress } from './progress'

const ADAPTERS: Record<Network['family'], ChainAdapter> = { evm, solana, tron }
const TTL = 10 * 60 * 1000
const STABLES = ['USDT', 'USDC']

// ---------- 合约白名单（已在链上核对） ----------

const LIFI_API = 'https://li.quest/v1'
const LIFI_DIAMOND: Record<number, string> = { 324: '0x341e94069f53234fE6DabeF707aD424830525715' }
const LIFI_DIAMOND_DEFAULT = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE'
const LIFI_CHAIN: Record<string, number> = { 'solana:mainnet': 1151111081099710, 'tron:mainnet': 728126428 }
const NATIVE_TOKEN: Record<Network['family'], string> = {
  evm: '0x0000000000000000000000000000000000000000',
  solana: '11111111111111111111111111111111',
  tron: 'TRX'
}

// Uniswap V3 SwapRouter02 / QuoterV2（已在链上核对 factory 与 WETH9）
const UNI_DEFAULT = { router: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45', quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e' } as const
const UNISWAP: Record<string, { router: Hex; quoter: Hex; weth: Hex }> = {
  'evm:1': { ...UNI_DEFAULT, weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' },
  'evm:42161': { ...UNI_DEFAULT, weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' },
  'evm:10': { ...UNI_DEFAULT, weth: '0x4200000000000000000000000000000000000006' },
  'evm:137': { ...UNI_DEFAULT, weth: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270' },
  'evm:8453': { router: '0x2626664c2603336E57B271c5C0b26F421741e481', quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a', weth: '0x4200000000000000000000000000000000000006' },
  'evm:11155111': { router: '0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E', quoter: '0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3', weth: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14' },
  'evm:84532': { router: '0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4', quoter: '0xC5290058841028F1614F3A6F0F5816cAd0df5E27', weth: '0x4200000000000000000000000000000000000006' }
}

// 用户说的交易所 → LI.FI 的工具名（uniswap 是本钱包直连）
const DEX_KEYS: Record<string, string> = {
  uniswap: 'uniswap', uni: 'uniswap', '1inch': '1inch', okx: 'okx', kyber: 'kyberswap', kyberswap: 'kyberswap',
  sushi: 'sushiswap', sushiswap: 'sushiswap', openocean: 'openocean', jupiter: 'jupiter', jup: 'jupiter',
  dodo: 'dodo', bitget: 'bitget', dflow: 'dflow', titan: 'titan'
}
const VIA_AGGREGATOR = ['pancake', 'pancakeswap', '薄饼', 'raydium', 'orca', 'meteora', 'aerodrome', 'velodrome', 'curve', 'balancer']

function dexKey(name?: string | null): string | undefined {
  if (!name) return undefined
  const k = name.toLowerCase().replace(/\s+|交易所|dex|聚合器/g, '')
  if (DEX_KEYS[k]) return DEX_KEYS[k]
  if (VIA_AGGREGATOR.some((v) => k.includes(v))) {
    throw new Error(`${name} 暂不支持直连。不指定交易所时，聚合器会自动比价，并按需走 ${name} 的流动性池`)
  }
  throw new Error(`不认识的交易所「${name}」。可以指定：Uniswap、1inch、OKX、KyberSwap、SushiSwap、OpenOcean、DODO、Jupiter（Solana）`)
}

const ADDRESS_THIS: Hex = '0x0000000000000000000000000000000000000002' // SwapRouter02 约定：先留在路由合约里
const FEE_TIERS = [500, 3000, 10000] as const

// Sepolia 上通往各 L2 测试网的官方入口
const TESTNET_BRIDGES: Record<string, { kind: 'op' | 'arbitrum'; address: Hex; name: string; eta: string }> = {
  'evm:84532': { kind: 'op', address: '0xfd0Bf71F60660E2f608ed56e1659C450eB113120', name: 'Base 官方桥', eta: '约 1–3 分钟' },
  'evm:11155420': { kind: 'op', address: '0xFBb0621E0B23b5478B630BD55a5f21f67730B0F1', name: 'OP 官方桥', eta: '约 1–3 分钟' },
  'evm:421614': { kind: 'arbitrum', address: '0xaAe29B0366299461418F5324a79Afc425BE5ae21', name: 'Arbitrum 官方桥', eta: '约 10–15 分钟' }
}

const ROUTER_ABI = parseAbi([
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)',
  'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
  'function multicall(bytes[] data) payable returns (bytes[])'
])
const QUOTER_ABI = parseAbi([
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)'
])
const WETH_ABI = parseAbi(['function deposit() payable', 'function withdraw(uint256 wad)'])
const OP_BRIDGE_ABI = parseAbi(['function depositETH(uint32 _minGasLimit, bytes _extraData) payable'])
const ARB_INBOX_ABI = parseAbi(['function depositEth() payable returns (uint256)'])

// ---------- 计划 ----------

type Call = { to: Hex; data: Hex; value: bigint }

interface Plan {
  card: RouteCard
  from: Network
  to: Network
  approve?: { token: Hex; spender: Hex; amount: bigint }
  // 执行源链交易，返回哈希；签名前再确认一次
  exec: (s: Signers) => Promise<string>
  // 到账判断：同链看回执，跨链看聚合器状态或目标链余额
  track: (hash: string) => Promise<{ state: 'pending' | 'done' | 'failed'; destHash?: string; note?: string }>
  at: number
}

const plans = new Map<string, Plan>()
const sent = new Map<string, Plan & { hash: string }>()

export interface RouteRequest {
  dex?: string | null
  mode: 'swap' | 'bridge'
  from: Network
  to: Network
  fromAsset: Asset
  toAsset: Asset
  amount: bigint
}

function fmt(v: bigint, decimals: number): string {
  const s = formatUnits(v, decimals)
  const [i, f = ''] = s.split('.')
  let frac = f.slice(0, 6).replace(/0+$/, '')
  if (i === '0' && !frac && v !== 0n) frac = f.slice(0, (f.match(/^0*/)?.[0].length ?? 0) + 3).replace(/0+$/, '')
  return frac ? `${i}.${frac}` : i
}

function me(family: Network['family']): string {
  const a = addresses()
  if (!a) throw new Error('钱包已锁定，请先解锁')
  return a[family]
}

function tokenAddr(a: Asset, n: Network): string {
  return a.kind === 'native' ? NATIVE_TOKEN[n.family] : a.address
}

function baseCard(r: RouteRequest, provider: string, toAmount: bigint, min?: bigint): RouteCard {
  return {
    kind: 'route', id: randomUUID(), mode: r.mode, status: 'ready', provider,
    from: { network: summary(r.from), asset: r.fromAsset.symbol, amount: fmt(r.amount, r.fromAsset.decimals) },
    to: {
      network: summary(r.to), asset: r.toAsset.symbol, amount: fmt(toAmount, r.toAsset.decimals),
      min: min !== undefined ? fmt(min, r.toAsset.decimals) : undefined, address: me(r.to.family)
    },
    fees: [], steps: [], checks: [], simulation: { ok: true, detail: '' }
  }
}

async function receipt(n: Network, hash: string): Promise<'pending' | 'done' | 'failed'> {
  const s = await ADAPTERS[n.family].status(n, hash).catch(() => 'pending' as const)
  return s === 'success' ? 'done' : s
}

async function waitReceipt(n: Network, hash: Hex): Promise<void> {
  const r = await (await publicClient(n)).waitForTransactionReceipt({ hash, timeout: 180_000 })
  if (r.status !== 'success') throw new Error('授权交易失败')
}

// 通用检查：余额、手续费、主网开关、限额
async function commonChecks(r: RouteRequest, card: RouteCard, sourceFee: bigint, extraNative = 0n): Promise<void> {
  const adapter = ADAPTERS[r.from.family]
  const owner = me(r.from.family)
  const native: Asset = { kind: 'native', symbol: r.from.nativeSymbol, decimals: r.from.nativeDecimals }
  const [bal, nativeBal] = await Promise.all([
    adapter.balance(r.from, owner, r.fromAsset),
    r.fromAsset.kind === 'native' ? Promise.resolve(0n) : adapter.balance(r.from, owner, native)
  ])
  const nb = r.fromAsset.kind === 'native' ? bal : nativeBal
  if (r.amount > bal) card.checks.push({ level: 'danger', text: `余额不足：只有 ${fmt(bal, r.fromAsset.decimals)} ${r.fromAsset.symbol}` })
  const needNative = sourceFee + extraNative + (r.fromAsset.kind === 'native' ? r.amount : 0n)
  if (needNative > nb) card.checks.push({ level: 'danger', text: `${r.from.nativeSymbol} 不足以支付${r.fromAsset.kind === 'native' ? '金额和' : ''}手续费` })
  card.fees.push({ label: '网络费', value: `≤ ${fmt(sourceFee, r.from.nativeDecimals)} ${r.from.nativeSymbol}` })

  if (!r.from.isTestnet) {
    if (!settings().allowMainnet) card.checks.unshift({ level: 'danger', text: '主网交易未开启：在设置里打开「允许主网转账」后再试' })
    else card.checks.unshift({ level: 'warn', text: `${r.from.name} 主网，资产真实` })
    if (STABLES.includes(r.fromAsset.symbol) && r.amount > BigInt(settings().stableLimit) * 10n ** BigInt(r.fromAsset.decimals)) {
      card.checks.push({ level: 'danger', text: `超过单笔限额 ${settings().stableLimit} ${r.fromAsset.symbol}` })
    }
  } else {
    card.checks.unshift({ level: 'info', text: '测试网：价格和流动性不代表真实行情' })
  }
  for (const a of [r.fromAsset, r.toAsset]) {
    if (a.kind === 'token' && !a.listed) card.checks.push({ level: 'warn', text: `${a.symbol} 不在内置白名单，请确认合约地址可信` })
  }
  card.checks.push({ level: 'info', text: `到账地址：你在 ${r.to.name} 上的地址 ${card.to.address}` })
}

async function allowanceNeeded(n: Network, owner: string, token: Hex, spender: Hex, amount: bigint): Promise<boolean> {
  const c = await publicClient(n)
  const allowance = await c.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner as Hex, spender] })
  return allowance < amount
}

// 先模拟；需要授权时只能模拟授权本身，主交易在授权后、签名前再模拟
async function simulateEvm(n: Network, owner: string, call: Call, approve?: Plan['approve']): Promise<{ ok: boolean; detail: string; gas: bigint }> {
  progress('链上模拟交易')
  const c = await publicClient(n)
  try {
    if (approve) {
      const data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [approve.spender, approve.amount] })
      const g1 = await c.estimateGas({ account: owner as Hex, to: approve.token, data })
      return { ok: true, detail: '授权交易模拟通过；主交易将在授权确认后、签名前再模拟一次', gas: g1 + 300_000n }
    }
    await c.call({ account: owner as Hex, ...call })
    const gas = await c.estimateGas({ account: owner as Hex, ...call })
    return { ok: true, detail: `eth_call 模拟通过，预估 gas ${gas}`, gas }
  } catch (e) {
    return { ok: false, detail: `模拟失败：${explainError(e, { symbol: n.nativeSymbol, decimals: n.nativeDecimals })}`, gas: 300_000n }
  }
}

async function sendEvm(n: Network, s: Signers, call: Call, approve?: Plan['approve']): Promise<string> {
  const c = await publicClient(n)
  if (approve && (await allowanceNeeded(n, s.evm.address, approve.token, approve.spender, approve.amount))) {
    progress('发送授权交易，等待上链确认')
    // 只授权本次金额，不做无限授权
    const data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [approve.spender, approve.amount] })
    const gas = await c.estimateGas({ account: s.evm.address, to: approve.token, data })
    const h = await sendCall(n, s.evm.privateKey, { to: approve.token, data, value: 0n }, (gas * 12n) / 10n)
    await waitReceipt(n, h)
  }
  progress('签名前再次模拟')
  await c.call({ account: s.evm.address, ...call })
  const gas = await c.estimateGas({ account: s.evm.address, ...call })
  progress('签名并广播')
  return sendCall(n, s.evm.privateKey, call, (gas * 12n) / 10n)
}

// ---------- 测试网：Uniswap V3 / WETH 包装 ----------

// Uniswap V3 三个费率档位都报价，取最多的；没有池子返回 null
export async function quoteUniswap(n: Network, from: Asset, to: Asset, amount: bigint): Promise<{ fee: number; out: bigint } | null> {
  const u = UNISWAP[n.id]
  if (!u || n.family !== 'evm') return null
  const tin = from.kind === 'native' ? u.weth : (from.address as Hex)
  const tout = to.kind === 'native' ? u.weth : (to.address as Hex)
  if (tin.toLowerCase() === tout.toLowerCase()) return null
  const c = await publicClient(n)
  const quotes = await Promise.all(
    FEE_TIERS.map(async (fee) => {
      try {
        const { result } = await c.simulateContract({
          address: u.quoter, abi: QUOTER_ABI, functionName: 'quoteExactInputSingle',
          args: [{ tokenIn: tin, tokenOut: tout, amountIn: amount, fee, sqrtPriceLimitX96: 0n }]
        })
        return { fee, out: result[0] }
      } catch {
        return null // 该档位没有池子
      }
    })
  )
  let best: { fee: number; out: bigint } | null = null
  for (const q of quotes) if (q && q.out > 0n && (!best || q.out > best.out)) best = q
  return best
}

async function planUniswap(r: RouteRequest): Promise<Plan> {
  const u = UNISWAP[r.from.id]
  if (!u) throw new Error(`Uniswap 直连目前支持以太坊、Base、Arbitrum、OP、Polygon、Sepolia、Base Sepolia，${r.from.name} 暂不支持`)
  const owner = me('evm') as Hex
  const tin = r.fromAsset.kind === 'native' ? u.weth : (r.fromAsset.address as Hex)
  const tout = r.toAsset.kind === 'native' ? u.weth : (r.toAsset.address as Hex)
  const c = await publicClient(r.from)

  // ETH ↔ WETH 直接包装 / 解包，1:1
  if (tin.toLowerCase() === tout.toLowerCase()) {
    const wrap = r.fromAsset.kind === 'native'
    if (wrap === (r.toAsset.kind === 'native')) throw new Error('兑换前后是同一种资产')
    const call: Call = wrap
      ? { to: u.weth, data: encodeFunctionData({ abi: WETH_ABI, functionName: 'deposit' }), value: r.amount }
      : { to: u.weth, data: encodeFunctionData({ abi: WETH_ABI, functionName: 'withdraw', args: [r.amount] }), value: 0n }
    const card = baseCard(r, 'WETH 合约', r.amount)
    card.rate = '1 : 1'
    card.steps = [wrap ? '把 ETH 包装成 WETH' : '把 WETH 解包成 ETH']
    const sim = await simulateEvm(r.from, owner, call)
    card.simulation = { ok: sim.ok, detail: sim.detail }
    await commonChecks(r, card, sim.gas * (await feeParams(c)).perGas)
    return { card, from: r.from, to: r.to, exec: (s) => sendEvm(r.from, s, call), track: async (h) => ({ state: await receipt(r.from, h) }), at: Date.now() }
  }

  const best = await quoteUniswap(r.from, r.fromAsset, r.toAsset, r.amount)
  if (!best) throw new Error(`${r.from.name} 上没有 ${r.fromAsset.symbol} → ${r.toAsset.symbol} 的 Uniswap 流动性`)
  const slip = r.from.isTestnet ? 100n : 50n // 测试网 1%，主网 0.5%
  const min = (best.out * (10_000n - slip)) / 10_000n
  const swap = (recipient: Hex) =>
    encodeFunctionData({
      abi: ROUTER_ABI, functionName: 'exactInputSingle',
      args: [{ tokenIn: tin, tokenOut: tout, fee: best.fee, recipient, amountIn: r.amount, amountOutMinimum: min, sqrtPriceLimitX96: 0n }]
    })
  const call: Call =
    r.toAsset.kind === 'native'
      ? {
          to: u.router, value: 0n,
          data: encodeFunctionData({
            abi: ROUTER_ABI, functionName: 'multicall',
            args: [[swap(ADDRESS_THIS), encodeFunctionData({ abi: ROUTER_ABI, functionName: 'unwrapWETH9', args: [min, owner] })]]
          })
        }
      : { to: u.router, data: swap(owner), value: r.fromAsset.kind === 'native' ? r.amount : 0n }

  const approve = r.fromAsset.kind === 'token' && (await allowanceNeeded(r.from, owner, tin, u.router, r.amount))
    ? { token: tin, spender: u.router, amount: r.amount } : undefined
  const card = baseCard(r, `Uniswap V3（${best.fee / 10000}% 池）`, best.out, min)
  card.rate = `1 ${r.fromAsset.symbol} ≈ ${fmt((best.out * 10n ** BigInt(r.fromAsset.decimals)) / r.amount, r.toAsset.decimals)} ${r.toAsset.symbol}`
  card.steps = [...(approve ? [`授权 Uniswap 路由合约动用 ${card.from.amount} ${r.fromAsset.symbol}（仅本次金额）`] : []), '兑换']
  card.fees.push({ label: '池子费率', value: `${best.fee / 10000}%` }, { label: '滑点保护', value: `${Number(slip) / 100}%` })
  const sim = await simulateEvm(r.from, owner, call, approve)
  card.simulation = { ok: sim.ok, detail: sim.detail }
  await commonChecks(r, card, sim.gas * (await feeParams(c)).perGas)
  return { card, from: r.from, to: r.to, approve, exec: (s) => sendEvm(r.from, s, call, approve), track: async (h) => ({ state: await receipt(r.from, h) }), at: Date.now() }
}

// ---------- 测试网：官方桥 ----------

async function planTestnetBridge(r: RouteRequest): Promise<Plan> {
  const b = TESTNET_BRIDGES[r.to.id]
  if (r.from.id !== 'evm:11155111' || !b) {
    throw new Error('测试网跨链目前支持：Sepolia → Base Sepolia / OP Sepolia / Arbitrum Sepolia（ETH）。L2 提回 Sepolia 需要等 7 天，暂不提供')
  }
  if (r.fromAsset.kind !== 'native' || r.toAsset.kind !== 'native') throw new Error('测试网官方桥这里只支持跨 ETH')
  const owner = me('evm') as Hex
  const call: Call =
    b.kind === 'op'
      ? { to: b.address, data: encodeFunctionData({ abi: OP_BRIDGE_ABI, functionName: 'depositETH', args: [200_000, '0x'] }), value: r.amount }
      : { to: b.address, data: encodeFunctionData({ abi: ARB_INBOX_ABI, functionName: 'depositEth' }), value: r.amount }
  const card = baseCard(r, b.name, r.amount)
  card.rate = '1 : 1'
  card.duration = b.eta
  card.steps = [`在 Sepolia 存入 ${card.from.amount} ETH`, `${b.eta}后在 ${r.to.name} 自动到账`]
  const c = await publicClient(r.from)
  const sim = await simulateEvm(r.from, owner, call)
  card.simulation = { ok: sim.ok, detail: sim.detail }
  await commonChecks(r, card, sim.gas * (await feeParams(c)).perGas)

  const destNative: Asset = { kind: 'native', symbol: r.to.nativeSymbol, decimals: r.to.nativeDecimals }
  let before = 0n
  return {
    card, from: r.from, to: r.to,
    exec: async (s) => {
      before = await evm.balance(r.to, s.evm.address, destNative)
      return sendEvm(r.from, s, call)
    },
    // 官方桥没有统一的状态接口：源链确认后看目标链余额是否增加
    track: async (h) => {
      const src = await receipt(r.from, h)
      if (src !== 'done') return { state: src }
      const now = await evm.balance(r.to, owner, destNative)
      return now - before >= (r.amount * 99n) / 100n ? { state: 'done' } : { state: 'pending', note: `Sepolia 已确认，等待 ${r.to.name} 到账（${b.eta}）` }
    },
    at: Date.now()
  }
}

// ---------- 主网：LI.FI ----------

interface LifiQuote {
  tool: string
  toolDetails?: { name: string }
  action: { fromAddress: string; toAddress: string; fromChainId: number; toChainId: number; toToken: { address: string; symbol: string; decimals: number } }
  estimate: {
    toAmount: string; toAmountMin: string; approvalAddress?: string; executionDuration: number
    fromAmountUSD?: string; toAmountUSD?: string
    feeCosts?: { name: string; amountUSD: string; included?: boolean }[]
    gasCosts?: { amountUSD: string; amount: string }[]
  }
  transactionRequest: { to?: string; data: string; value?: string; chainId?: number; gasLimit?: string }
}

function lifiChain(n: Network): number {
  if (n.family === 'evm') return n.chainId!
  const id = LIFI_CHAIN[n.id]
  if (!id) throw new Error(`${n.name} 不支持聚合跨链`)
  return id
}

interface LifiOpts {
  allowExchanges?: string
  order?: 'FASTEST' | 'CHEAPEST'
}

async function lifiQuote(r: RouteRequest, opts: LifiOpts = {}): Promise<LifiQuote> {
  const q = new URLSearchParams({
    fromChain: String(lifiChain(r.from)), toChain: String(lifiChain(r.to)),
    fromToken: tokenAddr(r.fromAsset, r.from), toToken: tokenAddr(r.toAsset, r.to),
    fromAmount: r.amount.toString(), fromAddress: me(r.from.family), toAddress: me(r.to.family),
    slippage: '0.005', integrator: 'semantic-wallet',
    ...(opts.allowExchanges ? { allowExchanges: opts.allowExchanges } : {}),
    ...(opts.order ? { order: opts.order } : {})
  })
  const res = await fetch(`${LIFI_API}/quote?${q}`, { signal: AbortSignal.timeout(25_000) })
  const j = (await res.json()) as LifiQuote & { message?: string }
  if (!res.ok || j.message) throw new Error(`聚合器没有找到路线：${(j.message ?? res.statusText).slice(0, 160)}`)
  return j
}

// 同链兑换的多家报价（用于比价）
async function lifiAlternatives(r: RouteRequest): Promise<{ key: string; name: string; out: bigint }[]> {
  const res = await fetch(`${LIFI_API}/advanced/routes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(25_000),
    body: JSON.stringify({
      fromChainId: lifiChain(r.from), toChainId: lifiChain(r.to),
      fromTokenAddress: tokenAddr(r.fromAsset, r.from), toTokenAddress: tokenAddr(r.toAsset, r.to),
      fromAmount: r.amount.toString(), fromAddress: me(r.from.family), toAddress: me(r.to.family),
      options: { order: 'CHEAPEST', slippage: 0.005, integrator: 'semantic-wallet' }
    })
  })
  const j = (await res.json()) as { routes?: { toAmount: string; steps: { tool: string; toolDetails?: { name: string } }[] }[] }
  const seen = new Set<string>()
  return (j.routes ?? [])
    .filter((x) => x.steps.length === 1)
    .map((x) => ({ key: x.steps[0].tool, name: x.steps[0].toolDetails?.name ?? x.steps[0].tool, out: BigInt(x.toAmount) }))
    .filter((x) => !seen.has(x.key) && seen.add(x.key))
}

// 聚合器返回的交易逐项核对：链、收付款人、合约白名单、目标代币
function verifyQuote(r: RouteRequest, q: LifiQuote): RiskCheck[] {
  const checks: RiskCheck[] = []
  const eq = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase()
  if (!eq(q.action.fromAddress, me(r.from.family))) checks.push({ level: 'danger', text: '报价里的付款地址不是你的地址' })
  if (!eq(q.action.toAddress, me(r.to.family))) checks.push({ level: 'danger', text: '报价里的收款地址不是你的地址' })
  if (r.toAsset.kind === 'token' && !eq(q.action.toToken.address, r.toAsset.address)) checks.push({ level: 'danger', text: '报价里的目标代币与预期不符' })
  if (r.from.family === 'evm') {
    const diamond = LIFI_DIAMOND[r.from.chainId!] ?? LIFI_DIAMOND_DEFAULT
    if (!eq(q.transactionRequest.to, diamond)) checks.push({ level: 'danger', text: `交易目标 ${q.transactionRequest.to} 不是 LI.FI 官方合约` })
    if (q.estimate.approvalAddress && !eq(q.estimate.approvalAddress, diamond)) checks.push({ level: 'danger', text: '授权对象不是 LI.FI 官方合约' })
    if (q.transactionRequest.chainId && q.transactionRequest.chainId !== r.from.chainId) checks.push({ level: 'danger', text: '报价交易的链与源链不一致' })
  }
  // 价格损耗（按聚合器给的美元估值）
  const fromUsd = Number(q.estimate.fromAmountUSD ?? 0)
  const toUsd = Number(q.estimate.toAmountUSD ?? 0)
  if (fromUsd > 0 && toUsd > 0) {
    const loss = (1 - toUsd / fromUsd) * 100
    if (loss > 10) checks.push({ level: 'danger', text: `价格损耗 ${loss.toFixed(1)}%，过高已拦截` })
    else if (loss > 3) checks.push({ level: 'warn', text: `价格损耗 ${loss.toFixed(1)}%，偏高` })
  }
  return checks
}

function lifiCall(q: LifiQuote): Call {
  const t = q.transactionRequest
  return { to: t.to as Hex, data: t.data as Hex, value: t.value ? BigInt(t.value) : 0n }
}

async function planLifi(r: RouteRequest, opts: LifiOpts = {}): Promise<Plan> {
  if (r.from.family === 'tron') throw new Error('从 Tron 发起兑换 / 跨链暂不支持（可以跨链到 Tron 收款）')
  let q = await lifiQuote(r, opts)
  const toAmount = BigInt(q.estimate.toAmount)
  const min = BigInt(q.estimate.toAmountMin)
  const tool = q.toolDetails?.name ?? q.tool
  const card = baseCard(r, `LI.FI · ${tool}`, toAmount, min)
  card.rate = `1 ${r.fromAsset.symbol} ≈ ${fmt((toAmount * 10n ** BigInt(r.fromAsset.decimals)) / r.amount, r.toAsset.decimals)} ${r.toAsset.symbol}`
  if (r.mode === 'bridge') card.duration = q.estimate.executionDuration < 120 ? `约 ${Math.max(1, Math.round(q.estimate.executionDuration))} 秒` : `约 ${Math.round(q.estimate.executionDuration / 60)} 分钟`
  const feeUsd = (q.estimate.feeCosts ?? []).reduce((s, f) => s + Number(f.amountUSD || 0), 0)
  if (feeUsd) card.fees.push({ label: '路由费', value: `≈ $${feeUsd.toFixed(2)}（已含在到账金额里）` })
  card.fees.push({ label: '滑点保护', value: '0.5%' })
  card.checks.push(...verifyQuote(r, q))

  let approve: Plan['approve']
  let sourceFee = 0n
  if (r.from.family === 'evm') {
    const owner = me('evm') as Hex
    const call = lifiCall(q)
    if (r.fromAsset.kind === 'token' && q.estimate.approvalAddress && (await allowanceNeeded(r.from, owner, r.fromAsset.address as Hex, q.estimate.approvalAddress as Hex, r.amount))) {
      approve = { token: r.fromAsset.address as Hex, spender: q.estimate.approvalAddress as Hex, amount: r.amount }
    }
    const sim = await simulateEvm(r.from, owner, call, approve)
    card.simulation = { ok: sim.ok, detail: sim.detail }
    sourceFee = sim.gas * (await feeParams(await publicClient(r.from))).perGas
  } else {
    // Solana：聚合器给的是待签名的序列化交易，核对付款人后模拟
    const tx = VersionedTransaction.deserialize(Buffer.from(q.transactionRequest.data, 'base64'))
    if (tx.message.staticAccountKeys[0].toBase58() !== me('solana')) card.checks.push({ level: 'danger', text: '交易付款人不是你的 Solana 地址' })
    card.simulation = await onSolana(r.from, async (c) => {
      const sim = await c.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true })
      return sim.value.err ? { ok: false, detail: `模拟失败：${explainSolana(sim.value.err)}` } : { ok: true, detail: `simulateTransaction 通过，消耗 ${sim.value.unitsConsumed ?? '?'} CU` }
    })
    sourceFee = 10_000n
  }
  card.steps = [
    ...(approve ? [`授权 LI.FI 合约动用 ${card.from.amount} ${r.fromAsset.symbol}（仅本次金额）`] : []),
    r.mode === 'bridge' ? `通过 ${tool} 跨链到 ${r.to.name}` : `通过 ${tool} 兑换`
  ]
  if (!card.simulation.ok) card.checks.push({ level: 'danger', text: card.simulation.detail })
  await commonChecks(r, card, sourceFee)

  return {
    card, from: r.from, to: r.to, approve,
    // 报价有时效（Solana 交易里的区块哈希一两分钟就过期），签名前重新报价，到账下限不能变差
    exec: async (s) => {
      progress('重新报价，确认价格没变差')
      const fresh = await lifiQuote(r, opts)
      if (BigInt(fresh.estimate.toAmountMin) < (min * 99n) / 100n) throw new Error('报价变差了，请重新发起')
      const bad = verifyQuote(r, fresh).find((c) => c.level === 'danger')
      if (bad) throw new Error(bad.text)
      q = fresh
      if (r.from.family === 'evm') return sendEvm(r.from, s, lifiCall(q), approve)
      const tx = VersionedTransaction.deserialize(Buffer.from(q.transactionRequest.data, 'base64'))
      tx.sign([s.solana.keypair])
      return onSolana(r.from, (c) => c.sendTransaction(tx, { maxRetries: 3 }))
    },
    track: async (h) => {
      if (r.mode === 'swap' && r.from.id === r.to.id) return { state: await receipt(r.from, h) }
      try {
        const qs = new URLSearchParams({ txHash: h, fromChain: String(lifiChain(r.from)), toChain: String(lifiChain(r.to)), bridge: q.tool })
        const res = await fetch(`${LIFI_API}/status?${qs}`, { signal: AbortSignal.timeout(15_000) })
        const j = (await res.json()) as { status?: string; substatusMessage?: string; receiving?: { txHash?: string } }
        if (j.status === 'DONE') return { state: 'done', destHash: j.receiving?.txHash }
        if (j.status === 'FAILED') return { state: 'failed', note: j.substatusMessage }
        return { state: 'pending', note: j.substatusMessage ?? '跨链处理中…' }
      } catch {
        return { state: 'pending', note: '跨链处理中…' }
      }
    },
    at: Date.now()
  }
}

// ---------- 对外 ----------

export async function planRoute(r: RouteRequest): Promise<RouteCard> {
  if (r.amount <= 0n) throw new Error('数量必须大于 0')
  if (r.from.isTestnet !== r.to.isTestnet) throw new Error('测试网和主网之间不能兑换或跨链')
  if (r.mode === 'swap' && r.from.id !== r.to.id) r = { ...r, mode: 'bridge' }

  const dex = dexKey(r.dex)
  let plan: Plan
  if (r.from.isTestnet) {
    if (dex && dex !== 'uniswap') throw new Error('测试网只有 Uniswap 可用')
    plan = r.mode === 'swap' ? await planUniswap(r) : await planTestnetBridge(r)
  } else if (r.mode === 'bridge') {
    plan = await planLifi(r, { order: 'FASTEST' }) // 跨链优先速度
  } else if (dex === 'uniswap') {
    plan = await planUniswap(r)
  } else if (dex) {
    plan = await planLifi(r, { allowExchanges: dex })
  } else {
    // 不指定交易所：聚合器各家 + Uniswap 直连一起比价，选到手最多的
    progress('向各家交易所询价比价')
    const [alts, uni] = await Promise.all([
      lifiAlternatives(r).catch(() => []),
      quoteUniswap(r.from, r.fromAsset, r.toAsset, r.amount).catch(() => null)
    ])
    const all = [...alts, ...(uni ? [{ key: 'uniswap', name: 'Uniswap V3 直连', out: uni.out }] : [])].sort((a, b) => (b.out > a.out ? 1 : -1))
    const best = all[0]
    plan = !best ? await planLifi(r) : best.key === 'uniswap' ? await planUniswap(r) : await planLifi(r, { allowExchanges: best.key })
    if (all.length > 1) {
      plan.card.alternatives = all.slice(0, 5).map((a) => ({ name: a.name, amount: fmt(a.out, r.toAsset.decimals), chosen: a === best }))
    }
  }

  const card = plan.card
  if (card.checks.some((c) => c.level === 'danger') || !card.simulation.ok) card.status = 'blocked'
  else plans.set(card.id, plan)
  return card
}

export async function confirmRoute(id: string): Promise<RouteCard> {
  const p = plans.get(id)
  if (!p) throw new Error('这笔交易已失效，请重新发起')
  plans.delete(id)
  const card = p.card
  if (Date.now() - p.at > TTL) return Object.assign(card, { status: 'expired', error: '确认超时，请重新发起' })
  try {
    const hash = await p.exec(signers())
    Object.assign(card, { status: 'sent', hash, explorerUrl: explorerTx(p.from, hash), progress: '已广播，等待确认…' })
    sent.set(id, { ...p, hash })
  } catch (e) {
    Object.assign(card, { status: 'failed', error: explainError(e) })
  }
  return card
}

export function cancelRoute(id: string): void {
  plans.delete(id)
}

export async function routeStatus(id: string): Promise<RouteCard | undefined> {
  const p = sent.get(id)
  if (!p) return undefined
  const t = await p.track(p.hash).catch(() => ({ state: 'pending' as const, note: undefined, destHash: undefined }))
  const card = p.card
  if (t.state === 'done') {
    Object.assign(card, { status: 'confirmed', progress: undefined })
    if (t.destHash) Object.assign(card, { destHash: t.destHash, destExplorerUrl: explorerTx(p.to, t.destHash) })
    sent.delete(id)
  } else if (t.state === 'failed') {
    Object.assign(card, { status: 'failed', error: t.note ?? '交易失败' })
    sent.delete(id)
  } else if (t.note) {
    card.progress = t.note
  }
  return card
}

