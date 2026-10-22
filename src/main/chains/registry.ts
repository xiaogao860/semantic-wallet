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

export interface RawChain {
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
  extraAliases?: string[] // 自定义网络：用户当时的叫法
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
    aliases: [...(EVM_ALIASES[c.chainId] ?? []), ...(c.extraAliases ?? []), c.shortName, c.chainSlug, c.name]
      .filter((x): x is string => !!x)
      .map(norm),
    tvl: c.tvl ?? 0
  }
}

function rank(tracking?: string): number {
  return tracking === 'none' ? 0 : tracking === 'limited' ? 1 : tracking === 'yes' ? 3 : 2
}

const CUSTOM_FILE = 'custom-networks.json'
const CHAINID_URL = 'https://chainid.network/chains.json'
let lastRaw: RawChain[] = []

// 用户添加过的网络（联网发现的陌生链）
function customChains(): RawChain[] {
  return readJson<RawChain[]>(CUSTOM_FILE, [])
}

function install(raw: RawChain[]): void {
  lastRaw = raw
  const known = new Set(raw.map((c) => c.chainId))
  const all = [...raw, ...customChains().filter((c) => !known.has(c.chainId))]
  const evm = all.filter((c) => c.status !== 'deprecated' && c.rpc?.length).map(fromRaw).filter((n) => n.rpcCandidates.length)
  networks = [...NON_EVM.map((n) => ({ ...n, aliases: n.aliases.map(norm) })), ...evm]
  byId.clear()
  aliasKeys = null
  for (const n of networks) byId.set(n.id, n)
  for (const [id, list] of Object.entries(readJson<Record<string, string[]>>(ALIAS_FILE, {}))) {
    const n = byId.get(id)
    if (n) n.aliases.push(...list.filter((a) => !n.aliases.includes(a)))
  }
}

const testnetName = (name: string) => /test|sepolia|devnet|goerli|holesky|amoy|fuji|testnet|测试/i.test(name)

// 强制刷新：chainlist + chainid.network 合并（陌生链可能刚收录），返回新增的网络数
export async function refreshRegistry(): Promise<number> {
  const before = networks.length
  const [chainlist, chainid] = await Promise.all([
    fetch(CHAINLIST_URL, { signal: AbortSignal.timeout(15_000) }).then((r) => r.json() as Promise<RawChain[]>).catch(() => null),
    fetch(CHAINID_URL, { signal: AbortSignal.timeout(15_000) }).then((r) => r.json() as Promise<RawChain[]>).catch(() => null)
  ])
  const base = Array.isArray(chainlist) && chainlist.length > 100 ? chainlist : lastRaw
  if (base === chainlist) writeJson(CACHE_FILE, { at: Date.now(), chains: chainlist })
  const known = new Set(base.map((c) => c.chainId))
  const extra = (Array.isArray(chainid) ? chainid : [])
    .filter((c) => !known.has(c.chainId))
    .map((c) => ({ ...c, isTestnet: c.isTestnet ?? testnetName(c.name) }))
  install([...base, ...extra])
  return networks.length - before
}

export function addCustomNetwork(c: RawChain): Network {
  const list = customChains().filter((x) => x.chainId !== c.chainId)
  writeJson(CUSTOM_FILE, [...list, c])
  install(lastRaw)
  return getNetwork(`evm:${c.chainId}`)
}

// 已知网络补一个叫法（用户的说法和 chainlist 名字对不上时），落盘，重启后还认识
const ALIAS_FILE = 'network-aliases.json'

export function addAlias(n: Network, alias: string): void {
  const a = norm(alias)
  if (n.aliases.includes(a)) return
  n.aliases.push(a)
  const saved = readJson<Record<string, string[]>>(ALIAS_FILE, {})
  writeJson(ALIAS_FILE, { ...saved, [n.id]: [...new Set([...(saved[n.id] ?? []), a])] })
}

export class UnknownNetworkError extends Error {
  constructor(public query: string) {
    super(`找不到叫「${query}」的网络`)
  }
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
  corrected?: boolean // 是靠拼写容错匹配上的
}

// 编辑距离（含相邻字母对调），用于拼写容错
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 0; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
    }
  }
  return d[a.length][b.length]
}

// 允许的错字数：越长的词越宽容；中文和太短的词不做容错
export function typoBudget(word: string): number {
  if (/[^a-z0-9]/.test(word)) return 0
  return word.length >= 7 ? 2 : word.length >= 5 ? 1 : 0
}

// 用户说法 → 网络。去掉空格后比对；"测试链/测试网络/testnet"统一成"测试网"，结尾的"链/网络/chain"去掉；
// 别名包含说法、说法包含别名都算命中。说了"测试"就绝不自动选主网，拿不准时把候选交给用户挑。
function key(s: string): string {
  return norm(s).replace(/ /g, '')
}

function variants(query: string): { all: string[]; exactOnly: string[]; core: string } {
  const k = key(query)
  const unified = k.replace(/测试链|测试网络|testnet/g, '测试网').replace(/主链|主网络|mainnet/g, '主网')
  const noGeneric = unified.replace(/(网络|链|chain|network)$/, '')
  const core = noGeneric.replace(/测试网|主网/g, '')
  // "arbitrum测试网" 也按英文写法 "arbitrum testnet / arbitrum sepolia" 去比，但只做完全相等的比对：
  // 合成出来的写法不能参与"包含"判断，否则"莫纳德sepolia"会因为包含 sepolia 误配到以太坊 Sepolia
  const english = /测试网/.test(unified) && core ? [`${core}testnet`, `${core}sepolia`] : []
  return { all: [...new Set([k, unified, noGeneric, core].filter((v) => v.length >= 2))], exactOnly: english, core }
}

const hasCjk = (s: string) => /[\u4e00-\u9fff]/.test(s)

let aliasKeys: Set<string> | null = null
function cleanRemainder(rest: string): boolean {
  const r = rest.replace(/测试网络|测试网|测试链|主网络|主网|主链|网络|链|chain|network|testnet|mainnet|的|上/g, '')
  if (!r) return true
  // 剩下的部分是别的网络名也算（如"以太坊sepolia"），但太短的英文名容易撞（"solace" = sol + ace）
  if (!hasCjk(r) && r.length < 4) return false
  if (!aliasKeys) aliasKeys = new Set(networks.flatMap((n) => n.aliases.map((a) => a.replace(/ /g, ''))))
  return aliasKeys.has(r)
}

export function resolveNetwork(query: string, family?: ChainFamily): NetworkMatch {
  const pool = networks.filter((n) => !family || n.family === family)
  const idHit = pool.find((n) => n.id === query)
  if (idHit) return { best: idHit, candidates: [idHit] }

  const { all, exactOnly, core } = variants(query)
  const wantsTestnet = /test|测试|sepolia|devnet|nile|shasta|amoy|fuji|holesky/.test(key(query))
  // 明确说了主网 / 测试网才按这个过滤；没说时，完全匹配到的叫法（含用户之前用过的叫法）直接认
  const explicitNet = wantsTestnet || /主网|主链|mainnet/.test(key(query))
  const scored: { n: Network; s: number; exact: boolean }[] = []
  for (const n of pool) {
    const aliases = n.aliases.map((a) => a.replace(/ /g, ''))
    let s = exactOnly.some((v) => aliases.includes(v)) ? 100 : 0
    for (const v of all) {
      if (aliases.includes(v)) s = Math.max(s, v === core && v !== all[0] ? 90 : 100)
      else if (n.chainId !== undefined && String(n.chainId) === v) s = Math.max(s, 95)
      else {
        if (v.length >= 3 && aliases.some((a) => a.startsWith(v))) s = Math.max(s, 60)
        if (v.length >= 3 && aliases.some((a) => a.includes(v))) s = Math.max(s, 40)
        // 说法里包含别名（如"以太坊sepolia"包含"sepolia"），但去掉别名后剩下的只能是泛称或别的网络名，
        // 否则 "qorvexa" 会因为包含 "vex" 误配、"以太坊经典" 会误配到以太坊
        const inside = aliases.filter((a) => a.length >= (hasCjk(a) ? 2 : 4) && v.includes(a) && cleanRemainder(v.replace(a, '')))
        if (inside.length) s = Math.max(s, 50 + Math.min(Math.max(...inside.map((a) => a.length)) * 2, 30))
      }
    }
    if (!s) continue
    const exact = s >= 100
    if (n.isTestnet !== wantsTestnet && (explicitNet || !exact)) s -= 60
    // 人工整理过别名的主流网络优先（chainlist 里还有大量已废弃的同名旧测试网）
    if (n.family !== 'evm' || EVM_ALIASES[n.chainId!]) s += 12
    scored.push({ n, s: s + Math.min(Math.log10(n.tvl + 1), 10), exact })
  }
  scored.sort((a, b) => b.s - a.s)
  const candidates = scored.slice(0, 5).map((x) => x.n)
  const top = scored[0]
  // 第一名明显领先、且测试网/主网属性对得上才自动选，否则让用户挑
  const netOk = top && (top.n.isTestnet === wantsTestnet || (!explicitNet && top.exact))
  const confident = top && netOk && (top.s >= 85 || !scored[1] || top.s - scored[1].s >= 15)
  if (confident || candidates.length) return { best: confident ? top.n : undefined, candidates }
  return fuzzyNetwork(core, wantsTestnet, explicitNet, pool)
}

// 拼写容错：只在主流网络（人工整理过别名的）里找，最接近的要唯一，才自动选
function fuzzyNetwork(core: string, wantsTestnet: boolean, explicitNet: boolean, pool: Network[]): NetworkMatch {
  const budget = typoBudget(core)
  if (!budget) return { candidates: [] }
  const hits: { n: Network; d: number }[] = []
  for (const n of pool) {
    if (n.family === 'evm' && !EVM_ALIASES[n.chainId!]) continue
    if (explicitNet && n.isTestnet !== wantsTestnet) continue
    // 别名里的 testnet / devnet / sepolia 等先去掉，拿"核心名"比（solnala测试网 → solana devnet）
    const names = n.aliases
      .flatMap((a) => [a.replace(/ /g, ''), a.replace(/ /g, '').replace(/testnet|devnet|sepolia|mainnet/g, '')])
      .filter((a) => !/[^a-z0-9]/.test(a) && a.length >= 4)
    if (!names.length) continue
    const d = Math.min(...names.map((a) => editDistance(core, a)))
    if (d <= budget) hits.push({ n, d })
  }
  // 没说测试网时，同等距离优先主网
  hits.sort((a, b) => a.d - b.d || Number(a.n.isTestnet) - Number(b.n.isTestnet))
  if (!hits.length) return { candidates: [] }
  const best = hits[0]
  const tie = hits.filter((h) => h.d === best.d && h.n.isTestnet === best.n.isTestnet).length > 1
  return { best: tie ? undefined : best.n, candidates: hits.slice(0, 5).map((h) => h.n), corrected: true }
}

export function explorerTx(n: Network, hash: string): string | undefined {
  if (!n.explorer) return undefined
  if (n.family === 'solana') return `${n.explorer}/tx/${hash}${n.id === 'solana:devnet' ? '?cluster=devnet' : ''}`
  if (n.family === 'tron') return `${n.explorer}/transaction/${hash}`
  return `${n.explorer}/tx/${hash}`
}
