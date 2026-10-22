// EVM 全系适配：任何 chainlist 里的链都能用，RPC 来自自动配置的前 3 名，fallback 自动切换。
import {
  type Chain,
  formatUnits,
  type PublicClient,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  erc20Abi,
  fallback,
  getAddress,
  http,
  isAddress
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import * as knownChains from 'viem/chains'
import { normalize } from 'viem/ens'
import type { RiskCheck } from '../../shared/types'
import { type Network, getNetwork } from '../chains/registry'
import { rpcsFor } from '../rpc'
import type { Asset, ChainAdapter, TransferParams } from './types'

const GAS_BUFFER = 120n // 估算 gas 上浮 20%

const viemChains = new Map<number, Chain>()
for (const c of Object.values(knownChains) as Chain[]) {
  if (c && typeof c === 'object' && 'id' in c && !viemChains.has(c.id)) viemChains.set(c.id, c)
}

function chainOf(n: Network, urls: string[]): Chain {
  const base = viemChains.get(n.chainId!)
  return defineChain({
    ...(base ?? {}),
    id: n.chainId!,
    name: n.name,
    nativeCurrency: { name: n.nativeSymbol, symbol: n.nativeSymbol, decimals: n.nativeDecimals },
    rpcUrls: { default: { http: urls } }
  })
}

const clients = new Map<string, { key: string; client: PublicClient }>()

async function transportFor(n: Network) {
  const urls = await rpcsFor(n.id)
  return { urls, transport: fallback(urls.map((u) => http(u, { timeout: 10_000, retryCount: 0 })), { retryCount: 1 }) }
}

export async function publicClient(n: Network): Promise<PublicClient> {
  const { urls, transport } = await transportFor(n)
  const key = urls.join('|')
  const hit = clients.get(n.id)
  if (hit?.key === key) return hit.client
  const client = createPublicClient({ chain: chainOf(n, urls), transport }) as PublicClient
  clients.set(n.id, { key, client })
  return client
}

export async function feeParams(c: PublicClient): Promise<{ perGas: bigint; params: Record<string, bigint> }> {
  try {
    const f = await c.estimateFeesPerGas()
    if (f.maxFeePerGas) {
      return { perGas: f.maxFeePerGas, params: { maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas! } }
    }
  } catch {
    // 不支持 EIP-1559 的链走 legacy
  }
  const gasPrice = await c.getGasPrice()
  return { perGas: gasPrice, params: { gasPrice } }
}

function callOf(p: TransferParams): { to: `0x${string}`; value: bigint; data?: `0x${string}` } {
  if (p.asset.kind === 'native') return { to: p.to as `0x${string}`, value: p.amount }
  return {
    to: p.asset.address as `0x${string}`,
    value: 0n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [p.to as `0x${string}`, p.amount] })
  }
}

export function shortErr(e: unknown): string {
  const any = e as { shortMessage?: string; details?: string; message?: string }
  const head = (any.shortMessage ?? any.message ?? String(e)).split('\n')[0]
  // viem 的 shortMessage 常是笼统的 "Transaction creation failed."，节点给的 details 才说明原因
  const detail = any.details && !head.includes(any.details) ? `（${any.details}）` : ''
  return `${head}${detail}`.slice(0, 200)
}

// 网站发来的任意交易：按我们自己的手续费估算发送
export async function sendCall(
  n: Network,
  privateKey: `0x${string}`,
  call: { to?: `0x${string}`; data?: `0x${string}`; value: bigint },
  gas: bigint
): Promise<`0x${string}`> {
  const { urls, transport } = await transportFor(n)
  const wallet = createWalletClient({ account: privateKeyToAccount(privateKey), chain: chainOf(n, urls), transport })
  const { params } = await feeParams(await publicClient(n))
  return wallet.sendTransaction({ ...call, gas, ...params } as Parameters<typeof wallet.sendTransaction>[0])
}

// 把节点 / viem 的英文报错翻译成看得懂的话；认不出来的保留原文
export function explainError(e: unknown, native?: { symbol: string; decimals: number }): string {
  const raw = shortErr(e)
  const any = e as { shortMessage?: string; details?: string; message?: string }
  const full = `${any.shortMessage ?? ''} ${any.details ?? ''} ${any.message ?? ''}` // 未截断的原文，用来取金额
  const m = full.toLowerCase() || raw.toLowerCase()
  if (/insufficient funds|exceeds the balance of the account|outoffunds|out of funds|lack of funds/.test(m)) {
    const hw = /have (\d+) want (\d+)/.exec(full)
    const amt = (v: string) => {
      const x = Number(formatUnits(BigInt(v), native!.decimals))
      return x === 0 ? '0' : x.toPrecision(4).replace(/\.?0+$/, '')
    }
    const amounts = hw && native ? `：需要约 ${amt(hw[2])} ${native.symbol}，现有 ${amt(hw[1])} ${native.symbol}` : ''
    return `${native?.symbol ?? '原生币'}余额不够支付这笔交易的金额和手续费（gas）${amounts}`
  }
  if (/transfer amount exceeds balance|burn amount exceeds balance|insufficient balance|exceeds balance/.test(m)) return '代币余额不足'
  if (/allowance/.test(m)) return '代币授权额度不足，需要先授权'
  if (/nonce too low|replacement transaction underpriced|already known/.test(m)) return '有一笔交易还在处理中，稍后再试'
  if (/max fee per gas less than block base fee|fee too low|underpriced/.test(m)) return '手续费出价低于网络当前要求，稍后重试'
  if (/intrinsic gas too low|out of gas/.test(m)) return 'gas 不够，交易执行不完'
  if (/timeout|timed out|fetch failed|econn|socket/.test(m)) return '节点没有响应，稍后再试或换个节点'
  if (/too little received|insufficient_output_amount|insufficient output amount|slippage|price impact too high/.test(m)) return '价格变动超过了滑点保护，稍后重新报价再试'
  if (/transaction too old|expired|deadline/.test(m)) return '交易已过期，请重新发起'
  if (/execution reverted|reverted/.test(m)) {
    const reason = /reverted(?: with reason(?: string)?)?[:\s]+["']?([^"')（]{3,80})/i.exec(full)?.[1]?.trim().replace(/\.$/, '')
    return `合约拒绝执行${reason && !/unknown reason/i.test(reason) ? `：${reason}` : '（常见原因：余额不足、价格变动超过滑点、参数不对）'}`
  }
  return raw
}

// Solana 程序报错：常见的错误码翻译成中文
export function explainSolana(err: unknown, lastLog = ''): string {
  const s = JSON.stringify(err)
  if (/InsufficientFundsForFee/.test(s)) return 'SOL 余额不够支付手续费'
  if (/InsufficientFundsForRent/.test(s)) return 'SOL 余额不够支付账户租金（新账户至少要留一点 SOL）'
  if (/AccountNotFound/.test(s)) return '付款账户在链上不存在（还没有收到过 SOL）'
  if (/"Custom":1\b/.test(s)) return '代币余额不足'
  if (/InvalidArgument|InvalidAccountData/.test(s)) return '账户状态不支持这个操作（例如付款账户带有数据）'
  if (/BlockhashNotFound/.test(s)) return '交易过期了，请重新发起'
  if (/"Custom":6001|SlippageToleranceExceeded/.test(s)) return '价格变动超过滑点保护'
  return `${s}${lastLog ? ` ${lastLog}` : ''}`.slice(0, 200)
}

export async function resolveEns(name: string): Promise<string | null> {
  const c = await publicClient(getNetwork('evm:1'))
  return c.getEnsAddress({ name: normalize(name) })
}

export const evm: ChainAdapter = {
  isAddress: (s) => isAddress(s, { strict: false }),
  normalizeAddress: (s) => getAddress(s),

  async balance(n, owner, asset) {
    const c = await publicClient(n)
    if (asset.kind === 'native') return c.getBalance({ address: owner as `0x${string}` })
    return c.readContract({ address: asset.address as `0x${string}`, abi: erc20Abi, functionName: 'balanceOf', args: [owner as `0x${string}`] })
  },

  async tokenMeta(n, address) {
    const c = await publicClient(n)
    const [symbol, decimals] = await Promise.all([
      c.readContract({ address: address as `0x${string}`, abi: erc20Abi, functionName: 'symbol' }),
      c.readContract({ address: address as `0x${string}`, abi: erc20Abi, functionName: 'decimals' })
    ])
    return { symbol, decimals }
  },

  async prepare(p) {
    const c = await publicClient(p.network)
    const from = p.from as `0x${string}`
    const call = callOf(p)
    const checks: RiskCheck[] = []

    const code = await c.getCode({ address: p.to as `0x${string}` }).catch(() => undefined)
    if (code && code !== '0x') checks.push({ level: 'warn', text: '收款地址是合约，请确认对方合约能接收这笔资产' })

    const { perGas } = await feeParams(c)
    let gas: bigint
    let simulation = { ok: true, detail: '' }
    try {
      if (p.asset.kind === 'token') {
        const { result } = await c.simulateContract({
          address: p.asset.address as `0x${string}`, abi: erc20Abi, functionName: 'transfer',
          args: [p.to as `0x${string}`, p.amount], account: from
        })
        if (!result) throw new Error('代币合约返回 false')
      }
      gas = await c.estimateGas({ account: from, ...call })
      simulation.detail = `eth_call 模拟通过，预估 gas ${gas}`
    } catch (e) {
      gas = p.asset.kind === 'native' ? 21_000n : 65_000n
      simulation = { ok: false, detail: `模拟失败：${explainError(e, { symbol: p.network.nativeSymbol, decimals: p.network.nativeDecimals })}` }
    }
    return { fee: ((gas * GAS_BUFFER) / 100n) * perGas, simulation, checks }
  },

  async send(p, s) {
    const { urls, transport } = await transportFor(p.network)
    const wallet = createWalletClient({ account: privateKeyToAccount(s.evm.privateKey), chain: chainOf(p.network, urls), transport })
    const c = await publicClient(p.network)
    const call = callOf(p)
    const gas = await c.estimateGas({ account: s.evm.address, ...call })
    const { params } = await feeParams(c)
    return wallet.sendTransaction({ ...call, gas: (gas * GAS_BUFFER) / 100n, ...params } as Parameters<typeof wallet.sendTransaction>[0])
  },

  async status(n, hash) {
    const c = await publicClient(n)
    try {
      const r = await c.getTransactionReceipt({ hash: hash as `0x${string}` })
      return r.status === 'success' ? 'success' : 'failed'
    } catch {
      return 'pending'
    }
  },

  async maxAmount(p) {
    const bal = await evm.balance(p.network, p.from, p.asset)
    if (p.asset.kind === 'token') return bal
    const c = await publicClient(p.network)
    const { perGas } = await feeParams(c)
    // 额外留 50% 余量，覆盖 L2 的 L1 数据费
    const reserve = (21_000n * GAS_BUFFER * perGas * 3n) / 200n
    return bal > reserve ? bal - reserve : 0n
  }
}

export type { Asset }
