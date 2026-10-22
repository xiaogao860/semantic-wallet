// 限价单：CoW Protocol。签一个 EIP-712 订单挂到 CoW 订单簿，价格到了由求解器链上成交，钱包关着也能成交。
// 只需在第一次卖某个代币时授权给 CoW 的 VaultRelayer（只授权本次金额）；卖原生币要先包装成 WETH。
import { randomUUID } from 'node:crypto'
import { type Hex, encodeFunctionData, erc20Abi, formatUnits, keccak256, parseAbi, parseUnits, stringToHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { LimitOrderCard, OrdersCard, RiskCheck } from '../shared/types'
import { evm, feeParams, publicClient, sendCall, shortErr } from './adapters/evm'
import type { Asset } from './adapters/types'
import { type Network, getNetwork, summary } from './chains/registry'
import { addresses, signers } from './keystore'
import { settings } from './settings'
import { TOKENS } from './tokens'
import { progress } from './progress'

// 本钱包网络 → CoW API 路径 / 浏览器路径（合约地址已在各链核对）
const COW: Record<string, { api: string; explorer: string }> = {
  'evm:1': { api: 'mainnet', explorer: '' },
  'evm:11155111': { api: 'sepolia', explorer: 'sepolia/' },
  'evm:8453': { api: 'base', explorer: 'base/' },
  'evm:42161': { api: 'arbitrum_one', explorer: 'arb1/' },
  'evm:137': { api: 'polygon', explorer: 'pol/' },
  'evm:100': { api: 'xdai', explorer: 'gc/' },
  'evm:43114': { api: 'avalanche', explorer: 'avax/' },
  'evm:56': { api: 'bnb', explorer: 'bnb/' }
}
const SETTLEMENT: Hex = '0x9008D19f58AAbD9eD0D60971565AA8510560ab41'
const VAULT_RELAYER: Hex = '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110'
const NATIVE_BUY: Hex = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
// 卖原生币需要的包装币（已核对）
const WRAPPED: Record<string, Hex> = {
  'evm:1': '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  'evm:11155111': '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
  'evm:8453': '0x4200000000000000000000000000000000000006',
  'evm:42161': '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  'evm:137': '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270'
}
const APP_DATA = JSON.stringify({ appCode: 'SemanticWallet', metadata: {}, version: '1.1.0' })
const APP_DATA_HASH = keccak256(stringToHex(APP_DATA))
const VALID_DAYS = 7
const WETH_ABI = parseAbi(['function deposit() payable'])

const ORDER_TYPES = {
  Order: [
    { name: 'sellToken', type: 'address' },
    { name: 'buyToken', type: 'address' },
    { name: 'receiver', type: 'address' },
    { name: 'sellAmount', type: 'uint256' },
    { name: 'buyAmount', type: 'uint256' },
    { name: 'validTo', type: 'uint32' },
    { name: 'appData', type: 'bytes32' },
    { name: 'feeAmount', type: 'uint256' },
    { name: 'kind', type: 'string' },
    { name: 'partiallyFillable', type: 'bool' },
    { name: 'sellTokenBalance', type: 'string' },
    { name: 'buyTokenBalance', type: 'string' }
  ]
} as const
const CANCEL_TYPES = { OrderCancellations: [{ name: 'orderUids', type: 'bytes[]' }] } as const

const domain = (n: Network) => ({ name: 'Gnosis Protocol', version: 'v2', chainId: n.chainId!, verifyingContract: SETTLEMENT })
const api = (n: Network) => `https://api.cow.fi/${COW[n.id].api}/api/v1`
const explorer = (n: Network, uid: string) => `https://explorer.cow.fi/${COW[n.id].explorer}orders/${uid}`

export function limitSupported(n: Network): boolean {
  return !!COW[n.id]
}

function fmt(v: bigint, d: number): string {
  const s = formatUnits(v, d)
  const [i, f = ''] = s.split('.')
  const frac = f.slice(0, 6).replace(/0+$/, '')
  return frac ? `${i}.${frac}` : i
}

function me(): Hex {
  const a = addresses()
  if (!a) throw new Error('钱包已锁定，请先解锁')
  return a.evm as Hex
}

async function cow<T>(n: Network, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${api(n)}${path}`, { ...init, headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(20_000) })
  const text = await res.text()
  const j = text ? JSON.parse(text) : null
  if (!res.ok) throw new Error(`CoW：${j?.description ?? j?.errorType ?? res.status}`)
  return j as T
}

// ---------- 下单 ----------

export interface LimitRequest {
  side: 'buy' | 'sell'
  network: Network
  token: Asset // 要买 / 卖的币
  quote: Asset // 计价币（付出或收到的）
  amount: bigint // buy：付出的计价币数量；sell：卖出的代币数量
  price: string // 1 个 token 值多少 quote
}

interface Plan {
  card: LimitOrderCard
  network: Network
  order: {
    sellToken: Hex; buyToken: Hex; receiver: Hex; sellAmount: bigint; buyAmount: bigint
    validTo: number; appData: Hex; feeAmount: bigint; kind: 'sell'; partiallyFillable: boolean
    sellTokenBalance: 'erc20'; buyTokenBalance: 'erc20'
  }
  wrap: bigint // 需要先包装的原生币数量
  at: number
}

const plans = new Map<string, Plan>()
const placed = new Map<string, { card: LimitOrderCard; network: Network }>()

export async function planLimit(r: LimitRequest): Promise<LimitOrderCard> {
  const n = r.network
  if (!limitSupported(n)) {
    throw new Error(`限价单目前支持以太坊、Base、Arbitrum、Polygon、BSC、Avalanche、Gnosis 和 Sepolia 测试网，${n.name} 暂不支持`)
  }
  const owner = me()
  const sellAsset = r.side === 'buy' ? r.quote : r.token
  const buyAsset = r.side === 'buy' ? r.token : r.quote
  if (sellAsset.kind === 'native' && !WRAPPED[n.id]) throw new Error(`${n.name} 上暂不支持卖出原生币的限价单，可以先换成稳定币`)
  const sellToken = sellAsset.kind === 'native' ? WRAPPED[n.id] : (sellAsset.address as Hex)
  const buyToken = buyAsset.kind === 'native' ? NATIVE_BUY : (buyAsset.address as Hex)

  // 价格换算：price 是 1 个 token 值多少 quote
  const priceRaw = parseUnits(r.price, r.quote.decimals)
  if (priceRaw <= 0n) throw new Error('价格必须大于 0')
  const sellAmount = r.amount
  const buyAmount = r.side === 'buy' ? (sellAmount * 10n ** BigInt(r.token.decimals)) / priceRaw : (sellAmount * priceRaw) / 10n ** BigInt(r.token.decimals)
  if (sellAmount <= 0n || buyAmount <= 0n) throw new Error('数量或价格太小，无法挂单')

  const validTo = Math.floor(Date.now() / 1000) + VALID_DAYS * 86_400
  const order = {
    sellToken, buyToken, receiver: owner, sellAmount, buyAmount, validTo, appData: APP_DATA_HASH,
    feeAmount: 0n, kind: 'sell' as const, partiallyFillable: false, sellTokenBalance: 'erc20' as const, buyTokenBalance: 'erc20' as const
  }

  const checks: RiskCheck[] = []
  if (!n.isTestnet && !settings().allowMainnet) checks.push({ level: 'danger', text: '主网交易未开启：在设置里打开「允许主网转账」后再试' })
  else if (n.isTestnet) checks.push({ level: 'info', text: '测试网：成交依赖测试网的求解器和流动性，可能很久不成交' })

  // 余额与 gas
  const c = await publicClient(n)
  const nativeBal = await c.getBalance({ address: owner })
  const wrap = sellAsset.kind === 'native' ? sellAmount : 0n
  const sellBal = sellAsset.kind === 'native'
    ? nativeBal + (await c.readContract({ address: sellToken, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }))
    : await c.readContract({ address: sellToken, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })
  if (sellBal < sellAmount) checks.push({ level: 'danger', text: `余额不足：只有 ${fmt(sellBal, sellAsset.decimals)} ${sellAsset.symbol}` })
  const allowance = await c.readContract({ address: sellToken, abi: erc20Abi, functionName: 'allowance', args: [owner, VAULT_RELAYER] })
  const needApprove = allowance < sellAmount
  const { perGas } = await feeParams(c)
  const gasNeed = ((wrap ? 60_000n : 0n) + (needApprove ? 70_000n : 0n)) * perGas * 2n
  if (gasNeed > 0n && nativeBal < gasNeed + wrap) checks.push({ level: 'danger', text: `${n.nativeSymbol} 不足以支付${wrap ? '包装和' : ''}授权的手续费` })

  // 现价：用同样的卖出数量向 CoW 询价
  progress('向 CoW 询问现价')
  let marketText: string | undefined
  try {
    const q = await cow<{ quote: { buyAmount: string } }>(n, '/quote', {
      method: 'POST',
      body: JSON.stringify({ sellToken, buyToken, from: owner, receiver: owner, kind: 'sell', sellAmountBeforeFee: sellAmount.toString(), signingScheme: 'eip712', appData: APP_DATA })
    })
    const marketBuy = BigInt(q.quote.buyAmount)
    if (marketBuy > 0n) {
      // 现价也换算成"1 个 token 值多少 quote"
      const market = r.side === 'buy'
        ? (sellAmount * 10n ** BigInt(r.token.decimals)) / marketBuy
        : (marketBuy * 10n ** BigInt(r.token.decimals)) / sellAmount
      marketText = `${fmt(market, r.quote.decimals)} ${r.quote.symbol}`
      const fills = marketBuy >= buyAmount
      const gap = Number(market - priceRaw) / Number(priceRaw)
      if (fills) checks.push({ level: 'info', text: '当前价格已经满足条件，挂单后很快就会成交' })
      else if (Math.abs(gap) > 0.5) checks.push({ level: 'warn', text: `限价离现价相差 ${(Math.abs(gap) * 100).toFixed(0)}%，可能长期不成交` })
    }
  } catch (e) {
    checks.push({ level: 'warn', text: `暂时拿不到现价（${shortErr(e)}），请自己确认价格` })
  }

  const priceText = `${r.side === 'buy' ? '≤' : '≥'} ${r.price} ${r.quote.symbol} / ${r.token.symbol}`
  const card: LimitOrderCard = {
    kind: 'limit', id: randomUUID(), status: 'ready', side: r.side, network: summary(n),
    sell: `${fmt(sellAmount, sellAsset.decimals)} ${sellAsset.symbol}`,
    buy: `${fmt(buyAmount, buyAsset.decimals)} ${buyAsset.symbol}`,
    price: priceText, market: marketText,
    validUntil: new Date(validTo * 1000).toLocaleString('zh-CN', { hour12: false }),
    steps: [
      ...(wrap ? [`把 ${fmt(wrap, 18)} ${n.nativeSymbol} 包装成 W${n.nativeSymbol}`] : []),
      ...(needApprove ? [`授权 CoW 动用 ${fmt(sellAmount, sellAsset.decimals)} ${sellAsset.kind === 'native' ? `W${n.nativeSymbol}` : sellAsset.symbol}（仅本次金额）`] : []),
      '签名挂单（不花 gas）'
    ],
    checks
  }
  if (checks.some((x) => x.level === 'danger')) card.status = 'blocked'
  else plans.set(card.id, { card, network: n, order, wrap, at: Date.now() })
  return card
}

export async function confirmLimit(id: string): Promise<LimitOrderCard> {
  const p = plans.get(id)
  if (!p) throw new Error('这个限价单已失效，请重新发起')
  plans.delete(id)
  const { card, network: n, order } = p
  if (Date.now() - p.at > 10 * 60 * 1000) return Object.assign(card, { status: 'expired', error: '确认超时，请重新发起' })
  try {
    const s = signers()
    const c = await publicClient(n)
    if (p.wrap > 0n) {
      progress(`包装 ${n.nativeSymbol}，等待上链确认`)
      const data = encodeFunctionData({ abi: WETH_ABI, functionName: 'deposit' })
      const h = await sendCall(n, s.evm.privateKey, { to: order.sellToken, data, value: p.wrap }, 80_000n)
      if ((await c.waitForTransactionReceipt({ hash: h, timeout: 180_000 })).status !== 'success') throw new Error('包装交易失败')
    }
    const allowance = await c.readContract({ address: order.sellToken, abi: erc20Abi, functionName: 'allowance', args: [s.evm.address, VAULT_RELAYER] })
    if (allowance < order.sellAmount) {
      progress('授权 CoW，等待上链确认')
      const data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [VAULT_RELAYER, order.sellAmount] })
      const gas = await c.estimateGas({ account: s.evm.address, to: order.sellToken, data })
      const h = await sendCall(n, s.evm.privateKey, { to: order.sellToken, data, value: 0n }, (gas * 12n) / 10n)
      if ((await c.waitForTransactionReceipt({ hash: h, timeout: 180_000 })).status !== 'success') throw new Error('授权交易失败')
    }
    progress('签名并提交订单')
    const signature = await privateKeyToAccount(s.evm.privateKey).signTypedData({ domain: domain(n), types: ORDER_TYPES, primaryType: 'Order', message: order })
    const uid = await cow<string>(n, '/orders', {
      method: 'POST',
      body: JSON.stringify({
        ...order, sellAmount: order.sellAmount.toString(), buyAmount: order.buyAmount.toString(), feeAmount: '0',
        appData: APP_DATA, appDataHash: APP_DATA_HASH, signingScheme: 'eip712', signature, from: s.evm.address
      })
    })
    Object.assign(card, { status: 'open', uid, explorerUrl: explorer(n, uid) })
    placed.set(id, { card, network: n })
  } catch (e) {
    Object.assign(card, { status: 'failed', error: shortErr(e) })
  }
  return card
}

export function cancelLimitPlan(id: string): void {
  plans.delete(id)
}

const STATUS: Record<string, LimitOrderCard['status']> = { open: 'open', fulfilled: 'filled', cancelled: 'cancelled', expired: 'expired' }

export async function limitStatus(id: string): Promise<LimitOrderCard | undefined> {
  const p = placed.get(id)
  if (!p?.card.uid) return p?.card
  try {
    const o = await cow<{ status: string }>(p.network, `/orders/${p.card.uid}`)
    p.card.status = STATUS[o.status] ?? p.card.status
    if (p.card.status !== 'open') placed.delete(id)
  } catch {
    // 查询失败下次再试
  }
  return p.card
}

// ---------- 查询 / 撤单 ----------

interface CowOrder {
  uid: string; status: string; sellToken: string; buyToken: string; sellAmount: string; buyAmount: string
  validTo: number; executedBuyAmount?: string; creationDate: string
}

const symbolCache = new Map<string, { symbol: string; decimals: number }>()

async function tokenLabel(n: Network, address: string): Promise<{ symbol: string; decimals: number }> {
  const a = address.toLowerCase()
  if (a === NATIVE_BUY.toLowerCase()) return { symbol: n.nativeSymbol, decimals: n.nativeDecimals }
  const key = `${n.id}:${a}`
  const cached = symbolCache.get(key)
  if (cached) return cached
  const listed = TOKENS[n.id]?.find((t) => t.address.toLowerCase() === a)
  const meta = listed ?? (await evm.tokenMeta(n, address).catch(() => ({ symbol: `${address.slice(0, 6)}…`, decimals: 18 })))
  symbolCache.set(key, meta)
  return meta
}

function envNetworks(): Network[] {
  const testnet = getNetwork(settings().defaultNetwork).isTestnet
  return Object.keys(COW).map(getNetwork).filter((n) => n.isTestnet === testnet)
}

async function openOrders(): Promise<{ n: Network; o: CowOrder }[]> {
  const owner = me()
  const lists = await Promise.all(
    envNetworks().map(async (n) => {
      const list = await cow<CowOrder[]>(n, `/account/${owner}/orders?limit=30`).catch(() => [])
      return list.map((o) => ({ n, o }))
    })
  )
  return lists.flat()
}

export async function listOrders(): Promise<OrdersCard> {
  const all = await openOrders()
  const rows = await Promise.all(
    all
      .sort((a, b) => Number(b.o.status === 'open') - Number(a.o.status === 'open') || b.o.creationDate.localeCompare(a.o.creationDate))
      .slice(0, 10)
      .map(async ({ n, o }) => {
        const [s, b] = await Promise.all([tokenLabel(n, o.sellToken), tokenLabel(n, o.buyToken)])
        return {
          uid: o.uid, networkId: n.id, network: n.name, status: STATUS[o.status] ?? 'open',
          text: `卖 ${fmt(BigInt(o.sellAmount), s.decimals)} ${s.symbol} → 至少 ${fmt(BigInt(o.buyAmount), b.decimals)} ${b.symbol}`,
          explorerUrl: explorer(n, o.uid)
        }
      })
  )
  return { kind: 'orders', orders: rows }
}

async function cancelUids(n: Network, uids: string[]): Promise<void> {
  const s = signers()
  const signature = await privateKeyToAccount(s.evm.privateKey).signTypedData({
    domain: domain(n), types: CANCEL_TYPES, primaryType: 'OrderCancellations', message: { orderUids: uids as Hex[] }
  })
  await cow(n, '/orders', { method: 'DELETE', body: JSON.stringify({ orderUids: uids, signature, signingScheme: 'eip712' }) })
}

export async function cancelOrder(networkId: string, uid: string): Promise<void> {
  await cancelUids(getNetwork(networkId), [uid])
}

// 对话里"撤销 ETH 的限价单"：按买卖币种匹配，target 为空时撤销全部
export async function cancelMatching(target: string | null): Promise<number> {
  const open = (await openOrders()).filter((x) => x.o.status === 'open')
  const t = target?.toUpperCase()
  let count = 0
  for (const n of new Set(open.map((x) => x.n))) {
    const mine = []
    for (const x of open.filter((y) => y.n === n)) {
      if (!t) mine.push(x.o.uid)
      else {
        const [s, b] = await Promise.all([tokenLabel(n, x.o.sellToken), tokenLabel(n, x.o.buyToken)])
        if ([s.symbol, b.symbol].some((sym) => sym.toUpperCase() === t || sym.toUpperCase() === `W${t}`)) mine.push(x.o.uid)
      }
    }
    if (mine.length) {
      await cancelUids(n, mine)
      count += mine.length
    }
  }
  return count
}

