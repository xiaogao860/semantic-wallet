// 链注册表：EVM 来自 chainlist（缓存 24h，失败用内置种子），Solana / Tron 内置。
// 负责把用户说的"Base""币安链""波场测试网"解析成具体网络。
import type { ChainFamily, NetworkSummary } from '../../shared/types'
import { readJson, writeJson } from '../store'
import seed from './evm-seed.json'

export interface Network extends NetworkSummary {
  chainId?: number
  nativeDecimals: number
  explorer?: string
  rpcCandidates: string[]
  aliases: string[]
  tvl: number
  genesis?: string // Solana 用于校验 RPC 是否连到了正确的网络
}

interface RawChain {
  name: string
  chainId: number
  shortName?: string
  chainSlug?: string
  isTestnet?: boolean
  status?: string
  tvl?: number
  nativeCurrency: { symbol: string; decimals: number }
  rpc: ({ url: string; tracking?: string } | string)[]
  explorers?: { url: string }[]
}

const CHAINLIST_URL = 'https://chainlist.org/rpcs.json'
const CACHE_FILE = 'chainlist-cache.json'
const CACHE_TTL = 24 * 3600 * 1000
const MAX_CANDIDATES = 12

const EVM_ALIASES: Record<number, string[]> = {
  1: ['以太坊', '以太坊主网', 'eth', 'ethereum', 'mainnet', 'eth主网'],
  56: ['bsc', 'bnb', '币安', '币安链', '币安智能链', 'bnb chain', 'bnbchain'],
  137: ['polygon', 'matic', '马蹄', 'pol', '波利冈'],
  42161: ['arbitrum', 'arb', '阿比', 'arbitrum one'],
  10: ['optimism', 'op', 'op mainnet'],
  8453: ['base'],
  43114: ['avalanche', 'avax', '雪崩', 'avalanche c-chain'],
  324: ['zksync', 'zksync era'],
  59144: ['linea'],
  534352: ['scroll'],
  5000: ['mantle'],
  81457: ['blast'],
  100: ['gnosis', 'xdai'],
  250: ['fantom', 'ftm'],
  11155111: ['sepolia', '以太坊测试网', 'eth测试网', 'ethereum sepolia'],
  84532: ['base sepolia', 'base测试网', 'base testnet'],
  421614: ['arbitrum sepolia', 'arb测试网', 'arbitrum testnet'],
  11155420: ['op sepolia', 'optimism sepolia', 'op测试网'],
  97: ['bsc testnet', 'bsc测试网', '币安测试网', 'bnb testnet'],
  80002: ['amoy', 'polygon amoy', 'polygon测试网', '马蹄测试网'],
  43113: ['fuji', 'avalanche fuji', '雪崩测试网'],
  17000: ['holesky']
}

const NON_EVM: Network[] = [
  {
    id: 'solana:mainnet', family: 'solana', name: 'Solana', isTestnet: false, nativeSymbol: 'SOL', nativeDecimals: 9,
    explorer: 'https://solscan.io', tvl: 9e9,
    genesis: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
    aliases: ['solana', 'sol', '索拉纳', 'sol链', 'solana mainnet'],
    rpcCandidates: ['https://api.mainnet-beta.solana.com', 'https://solana-mainnet.gateway.tatum.io']
  },
  {
    id: 'solana:devnet', family: 'solana', name: 'Solana Devnet', isTestnet: true, nativeSymbol: 'SOL', nativeDecimals: 9,
    explorer: 'https://solscan.io', tvl: 0,
    genesis: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    aliases: ['solana devnet', 'devnet', 'sol测试网', 'solana测试网', '索拉纳测试网'],
    rpcCandidates: ['https://api.devnet.solana.com', 'https://solana-devnet.gateway.tatum.io']
  },
  {
    id: 'tron:mainnet', family: 'tron', name: 'Tron', isTestnet: false, nativeSymbol: 'TRX', nativeDecimals: 6,
    explorer: 'https://tronscan.org/#', tvl: 6e9,
    aliases: ['tron', 'trx', '波场', 'trc20', 'trc', '波场主网'],
    rpcCandidates: ['https://api.trongrid.io', 'https://api.tronstack.io']
  },
  {
    id: 'tron:nile', family: 'tron', name: 'Tron Nile', isTestnet: true, nativeSymbol: 'TRX', nativeDecimals: 6,
    explorer: 'https://nile.tronscan.org/#', tvl: 0,
    aliases: ['nile', 'tron nile', '波场测试网', 'tron测试网', 'trx测试网'],
    rpcCandidates: ['https://nile.trongrid.io', 'https://api.nileex.io']
  },
  {
    id: 'tron:shasta', family: 'tron', name: 'Tron Shasta', isTestnet: true, nativeSymbol: 'TRX', nativeDecimals: 6,
    explorer: 'https://shasta.tronscan.org/#', tvl: 0,
    aliases: ['shasta', 'tron shasta'],
    rpcCandidates: ['https://api.shasta.trongrid.io']
  }
]

let networks: Network[] = []
const byId = new Map<string, Network>()

function fromRaw(c: RawChain): Network {
  const urls = c.rpc
    .map((r) => (typeof r === 'string' ? { url: r, tracking: undefined } : r))
    .filter((r) => r.url.startsWith('https://') && !r.url.includes('${'))
    // 不追踪用户的 RPC 优先
    .sort((a, b) => rank(a.tracking) - rank(b.tracking))
    .map((r) => r.url)
  return {
    id: `evm:${c.chainId}`,
    family: 'evm',
    name: c.name,
    chainId: c.chainId,
    isTestnet: !!c.isTestnet,
    nativeSymbol: c.nativeCurrency.symbol,
    nativeDecimals: c.nativeCurrency.decimals,
    explorer: c.explorers?.[0]?.url?.replace(/\/$/, ''),
    rpcCandidates: [...new Set(urls)].slice(0, MAX_CANDIDATES),
    aliases: [...(EVM_ALIASES[c.chainId] ?? []), c.shortName, c.chainSlug, c.name]
      .filter((x): x is string => !!x)
      .map(norm),
    tvl: c.tvl ?? 0
  }
}

function rank(tracking?: string): number {
  return tracking === 'none' ? 0 : tracking === 'limited' ? 1 : tracking === 'yes' ? 3 : 2
}

function install(raw: RawChain[]): void {
  const evm = raw.filter((c) => c.status !== 'deprecated' && c.rpc?.length).map(fromRaw).filter((n) => n.rpcCandidates.length)
  networks = [...NON_EVM.map((n) => ({ ...n, aliases: n.aliases.map(norm) })), ...evm]
  byId.clear()
  for (const n of networks) byId.set(n.id, n)
}

export async function loadRegistry(): Promise<void> {
  install(seed as RawChain[])
  const cache = readJson<{ at: number; chains: RawChain[] } | null>(CACHE_FILE, null)
  if (cache && Date.now() - cache.at < CACHE_TTL) {
    install(cache.chains)
    return
  }
  try {
    const res = await fetch(CHAINLIST_URL, { signal: AbortSignal.timeout(10_000) })
    const chains = (await res.json()) as RawChain[]
    if (Array.isArray(chains) && chains.length > 100) {
      writeJson(CACHE_FILE, { at: Date.now(), chains })
      install(chains)
    }
  } catch {
    if (cache) install(cache.chains)
  }
}

export function getNetwork(id: string): Network {
  const n = byId.get(id)
  if (!n) throw new Error(`未知网络 ${id}`)
  return n
}

export function allNetworks(): Network[] {
  return networks
}

export function summary(n: Network): NetworkSummary {
  return { id: n.id, family: n.family, name: n.name, isTestnet: n.isTestnet, nativeSymbol: n.nativeSymbol }
}

export function norm(s: string): string {
  return s.toLowerCase().replace(/[\s_\-]+/g, ' ').trim()
}

export interface NetworkMatch {
  best?: Network
  candidates: Network[]
}

// 用户说法 → 网络。精确别名 > chainId > 前缀 > 包含；同分按 TVL；没提测试网时优先主网。
export function resolveNetwork(query: string, family?: ChainFamily): NetworkMatch {
  const q = norm(query)
  const wantsTestnet = /test|测试|sepolia|devnet|nile|shasta|amoy|fuji|holesky/.test(q)
  const pool = networks.filter((n) => !family || n.family === family)
  const idHit = pool.find((n) => n.id === query)
  if (idHit) return { best: idHit, candidates: [idHit] }

  const scored: { n: Network; s: number }[] = []
  for (const n of pool) {
    let s = 0
    if (n.aliases.includes(q)) s = 100
    else if (n.chainId !== undefined && String(n.chainId) === q) s = 95
    else if (n.aliases.some((a) => a.startsWith(q) && q.length >= 3)) s = 60
    else if (n.aliases.some((a) => a.includes(q) && q.length >= 3)) s = 40
    if (!s) continue
    if (n.isTestnet !== wantsTestnet) s -= 30
    scored.push({ n, s: s + Math.min(Math.log10(n.tvl + 1), 10) })
  }
  scored.sort((a, b) => b.s - a.s)
  const candidates = scored.slice(0, 5).map((x) => x.n)
  const top = scored[0]
  // 第一名明显领先才自动选，否则让用户挑
  const confident = top && (top.s >= 90 || !scored[1] || top.s - scored[1].s >= 15)
  return { best: confident ? top.n : undefined, candidates }
}

export function explorerTx(n: Network, hash: string): string | undefined {
  if (!n.explorer) return undefined
  if (n.family === 'solana') return `${n.explorer}/tx/${hash}${n.id === 'solana:devnet' ? '?cluster=devnet' : ''}`
  if (n.family === 'tron') return `${n.explorer}/transaction/${hash}`
  return `${n.explorer}/tx/${hash}`
}
