// EVM 全系适配：任何 chainlist 里的链都能用，RPC 来自自动配置的前 3 名，fallback 自动切换。
import {
  type Chain,
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

async function feeParams(c: PublicClient): Promise<{ perGas: bigint; params: Record<string, bigint> }> {
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
      simulation = { ok: false, detail: `模拟失败：${shortErr(e)}` }
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
