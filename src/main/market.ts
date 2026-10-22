// 行情与代币信息：价格（LI.FI）、按名字搜代币（DexScreener）、合约安全检测（GoPlus）。
// 这些都是第三方数据，只用于展示和风控提示；交易本身仍以链上模拟和报价校验为准。
import type { RiskCheck } from '../shared/types'
import type { Asset } from './adapters/types'
import { type Network, editDistance, getNetwork, typoBudget } from './chains/registry'
import { proxyStatus } from './proxy'
import { progress } from './progress'

const LIFI_API = 'https://li.quest/v1'
const LIFI_CHAIN: Record<string, number> = { 'solana:mainnet': 1151111081099710, 'tron:mainnet': 728126428 }
const NATIVE_TOKEN: Record<Network['family'], string> = {
  evm: '0x0000000000000000000000000000000000000000',
  solana: '11111111111111111111111111111111',
  tron: 'TRX'
}

// DexScreener 的链名 → 本钱包网络
const DS_CHAIN: Record<string, string> = {
  ethereum: 'evm:1', base: 'evm:8453', arbitrum: 'evm:42161', optimism: 'evm:10', polygon: 'evm:137',
  bsc: 'evm:56', avalanche: 'evm:43114', solana: 'solana:mainnet'
}

async function getJson<T>(url: string, timeout = 15_000): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as T
}

export function lifiChainId(n: Network): number | undefined {
  return n.family === 'evm' ? n.chainId : LIFI_CHAIN[n.id]
}

// 美元价格（主网）。测试网没有真实价格，返回 null
export async function priceUsd(n: Network, asset: Asset): Promise<number | null> {
  if (n.isTestnet) return null
  const chain = lifiChainId(n)
  if (!chain) return null
  try {
    const token = asset.kind === 'native' ? NATIVE_TOKEN[n.family] : asset.address
    const j = await getJson<{ priceUSD?: string }>(`${LIFI_API}/token?chain=${chain}&token=${token}`)
    const p = Number(j.priceUSD)
    return Number.isFinite(p) && p > 0 ? p : null
  } catch {
    return null
  }
}

export interface TokenHit {
  network: Network
  address: string
  symbol: string
  name: string
  priceUsd?: number
  change24h?: number
  liquidityUsd: number
  volume24h: number
  createdAt?: number
  dex: string
}

interface DsPair {
  chainId: string
  dexId: string
  baseToken: { address: string; name: string; symbol: string }
  priceUsd?: string
  priceChange?: { h24?: number }
  liquidity?: { usd?: number }
  volume?: { h24?: number }
  pairCreatedAt?: number
}

// 同一个代币的多个交易对合并：流动性、成交量累加，取最早的创建时间
function collect(pairs: DsPair[], accept: (p: DsPair) => boolean): TokenHit[] {
  const map = new Map<string, TokenHit>()
  for (const p of pairs) {
    const nid = DS_CHAIN[p.chainId]
    if (!nid || !accept(p)) continue
    const key = `${nid}:${p.baseToken.address.toLowerCase()}`
    const hit = map.get(key)
    const liq = p.liquidity?.usd ?? 0
    if (!hit) {
      map.set(key, {
        network: getNetwork(nid), address: p.baseToken.address, symbol: p.baseToken.symbol, name: p.baseToken.name,
        priceUsd: p.priceUsd ? Number(p.priceUsd) : undefined, change24h: p.priceChange?.h24,
        liquidityUsd: liq, volume24h: p.volume?.h24 ?? 0, createdAt: p.pairCreatedAt, dex: p.dexId
      })
    } else {
      // 价格和涨跌取流动性最大的交易对
      if (liq > hit.liquidityUsd) Object.assign(hit, { priceUsd: p.priceUsd ? Number(p.priceUsd) : hit.priceUsd, change24h: p.priceChange?.h24, dex: p.dexId })
      hit.liquidityUsd += liq
      hit.volume24h += p.volume?.h24 ?? 0
      if (p.pairCreatedAt && (!hit.createdAt || p.pairCreatedAt < hit.createdAt)) hit.createdAt = p.pairCreatedAt
    }
  }
  return [...map.values()].sort((a, b) => b.liquidityUsd - a.liquidityUsd)
}

// 按名字 / 符号搜代币，只返回符号或名字真的对得上的，按流动性排序
export async function searchTokens(query: string, networkId?: string): Promise<TokenHit[]> {
  progress(`搜索代币「${query}」`)
  const q = query.trim().toLowerCase()
  const j = await getJson<{ pairs?: DsPair[] }>(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query.trim())}`)
  return collect(j.pairs ?? [], (p) => {
    if (networkId && DS_CHAIN[p.chainId] !== networkId) return false
    return p.baseToken.symbol.toLowerCase() === q || p.baseToken.name.toLowerCase() === q
  })
}

// 只有合约地址、不知道在哪条链：按流动性找最可能的那条
export async function findToken(address: string): Promise<TokenHit[]> {
  const j = await getJson<{ pairs?: DsPair[] }>(`https://api.dexscreener.com/latest/dex/tokens/${address}`)
  return collect(j.pairs ?? [], (p) => p.baseToken.address.toLowerCase() === address.toLowerCase())
}

export async function tokenInfo(n: Network, address: string): Promise<TokenHit | null> {
  try {
    const j = await getJson<{ pairs?: DsPair[] }>(`https://api.dexscreener.com/latest/dex/tokens/${address}`)
    return collect(j.pairs ?? [], (p) => DS_CHAIN[p.chainId] === n.id && p.baseToken.address.toLowerCase() === address.toLowerCase())[0] ?? null
  } catch {
    return null
  }
}

// ---------- 合约安全（GoPlus） ----------

interface GoPlusEvm {
  is_honeypot?: string; cannot_sell_all?: string; buy_tax?: string; sell_tax?: string; is_open_source?: string
  owner_change_balance?: string; hidden_owner?: string; is_mintable?: string; is_proxy?: string
  transfer_pausable?: string; holder_count?: string; holders?: { percent: string; is_contract?: number; tag?: string }[]
  trust_list?: string
}

interface GoPlusSol {
  mintable?: { status: string }; freezable?: { status: string }; balance_mutable_authority?: { status: string }
  non_transferable?: string; transfer_fee?: { current_fee_rate?: { fee_rate?: string } }; holder_count?: string
  holders?: { percent: string }[]; trusted_token?: number
}

const pct = (v?: string) => (v ? Number(v) * 100 : 0)

export interface SecurityReport {
  checks: RiskCheck[]
  facts: { label: string; value: string }[]
}

export async function security(n: Network, address: string, hit?: TokenHit | null): Promise<SecurityReport> {
  progress('检测合约安全（蜜罐、税率、持仓）')
  const checks: RiskCheck[] = []
  const facts: { label: string; value: string }[] = []
  try {
    if (n.family === 'evm') {
      const j = await getJson<{ result?: Record<string, GoPlusEvm> }>(`https://api.gopluslabs.io/api/v1/token_security/${n.chainId}?contract_addresses=${address}`)
      const r = j.result?.[address.toLowerCase()]
      if (!r) throw new Error('无数据')
      if (r.is_honeypot === '1') checks.push({ level: 'danger', text: '蜜罐：买入后无法卖出' })
      if (r.cannot_sell_all === '1') checks.push({ level: 'danger', text: '不能一次卖出全部持仓' })
      const buy = pct(r.buy_tax)
      const sell = pct(r.sell_tax)
      if (sell > 10 || buy > 10) checks.push({ level: 'danger', text: `交易税过高：买 ${buy.toFixed(1)}% / 卖 ${sell.toFixed(1)}%` })
      else if (sell > 3 || buy > 3) checks.push({ level: 'warn', text: `有交易税：买 ${buy.toFixed(1)}% / 卖 ${sell.toFixed(1)}%` })
      facts.push({ label: '买卖税', value: `${buy.toFixed(1)}% / ${sell.toFixed(1)}%` })
      if (r.owner_change_balance === '1') checks.push({ level: 'danger', text: '合约所有者可以直接修改用户余额' })
      if (r.is_open_source === '0') checks.push({ level: 'warn', text: '合约代码未开源' })
      if (r.hidden_owner === '1') checks.push({ level: 'warn', text: '存在隐藏的所有者权限' })
      if (r.is_mintable === '1') checks.push({ level: 'warn', text: '可以增发' })
      if (r.transfer_pausable === '1') checks.push({ level: 'warn', text: '所有者可以暂停转账' })
      if (r.is_proxy === '1') checks.push({ level: 'info', text: '可升级合约，规则可能被修改' })
      const top = (r.holders ?? []).filter((h) => !h.is_contract).slice(0, 10).reduce((s, h) => s + Number(h.percent), 0) * 100
      if (r.holder_count) facts.push({ label: '持有人', value: Number(r.holder_count).toLocaleString() })
      if (top) facts.push({ label: '前 10 大个人持仓', value: `${top.toFixed(1)}%` })
      if (top > 50) checks.push({ level: 'warn', text: `持仓高度集中：前 10 个地址持有 ${top.toFixed(0)}%` })
    } else if (n.family === 'solana') {
      const j = await getJson<{ result?: Record<string, GoPlusSol> }>(`https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${address}`)
      const r = j.result?.[address] ?? Object.values(j.result ?? {})[0]
      if (!r) throw new Error('无数据')
      if (r.balance_mutable_authority?.status === '1') checks.push({ level: 'danger', text: '存在可修改用户余额的权限' })
      if (r.non_transferable === '1') checks.push({ level: 'danger', text: '代币不可转让' })
      if (r.mintable?.status === '1') checks.push({ level: 'warn', text: '可以增发' })
      if (r.freezable?.status === '1') checks.push({ level: 'warn', text: '持有人账户可被冻结' })
      const fee = Number(r.transfer_fee?.current_fee_rate?.fee_rate ?? 0)
      if (fee > 0) checks.push({ level: fee > 500 ? 'danger' : 'warn', text: `转账手续费 ${(fee / 100).toFixed(2)}%` })
      const top = (r.holders ?? []).slice(0, 10).reduce((s, h) => s + Number(h.percent), 0) * 100
      if (r.holder_count) facts.push({ label: '持有人', value: Number(r.holder_count).toLocaleString() })
      if (top) facts.push({ label: '前 10 大持仓', value: `${top.toFixed(1)}%` })
      if (top > 60) checks.push({ level: 'warn', text: `持仓高度集中：前 10 个地址持有 ${top.toFixed(0)}%` })
    }
  } catch (e) {
    checks.push({ level: 'warn', text: `合约安全检测暂不可用（${(e as Error).message}），请自行确认` })
  }

  if (hit) {
    facts.push({ label: '流动性', value: `$${Math.round(hit.liquidityUsd).toLocaleString()}` }, { label: '24h 成交', value: `$${Math.round(hit.volume24h).toLocaleString()}` })
    if (hit.liquidityUsd < 1_000) checks.push({ level: 'danger', text: `流动性只有 $${Math.round(hit.liquidityUsd)}，买入后很可能卖不出去` })
    else if (hit.liquidityUsd < 50_000) checks.push({ level: 'warn', text: `流动性较低（$${Math.round(hit.liquidityUsd).toLocaleString()}），大额交易滑点会很大` })
    if (hit.createdAt) {
      const days = (Date.now() - hit.createdAt) / 86_400_000
      facts.push({ label: '上线', value: days < 1 ? `${Math.max(1, Math.round(days * 24))} 小时前` : `${Math.round(days)} 天前` })
      if (days < 1) checks.push({ level: 'warn', text: '上线不到 24 小时的新币，风险很高' })
    }
  }
  if (!checks.some((c) => c.level !== 'info')) checks.push({ level: 'ok', text: '未发现明显的合约风险' })
  return { checks, facts }
}

// ---------- 主流币行情：不依赖链上代币搜索 ----------

interface Major {
  symbol: string
  name: string
  coingecko: string
  lifi?: { chain: number; token: string }
}

const MAJORS: Major[] = [
  { symbol: 'BTC', name: '比特币', coingecko: 'bitcoin', lifi: { chain: 20000000000001, token: 'bitcoin' } },
  { symbol: 'ETH', name: '以太坊', coingecko: 'ethereum', lifi: { chain: 1, token: NATIVE_TOKEN.evm } },
  { symbol: 'SOL', name: 'Solana', coingecko: 'solana', lifi: { chain: 1151111081099710, token: NATIVE_TOKEN.solana } },
  { symbol: 'BNB', name: 'BNB', coingecko: 'binancecoin', lifi: { chain: 56, token: NATIVE_TOKEN.evm } },
  { symbol: 'TRX', name: '波场', coingecko: 'tron', lifi: { chain: 728126428, token: 'TRX' } },
  { symbol: 'POL', name: 'Polygon', coingecko: 'polygon-ecosystem-token', lifi: { chain: 137, token: NATIVE_TOKEN.evm } },
  { symbol: 'AVAX', name: 'Avalanche', coingecko: 'avalanche-2', lifi: { chain: 43114, token: NATIVE_TOKEN.evm } },
  { symbol: 'DOGE', name: '狗狗币', coingecko: 'dogecoin' },
  { symbol: 'XRP', name: '瑞波币', coingecko: 'ripple' },
  { symbol: 'TON', name: 'Toncoin', coingecko: 'the-open-network' },
  { symbol: 'ADA', name: '艾达币', coingecko: 'cardano' },
  { symbol: 'LTC', name: '莱特币', coingecko: 'litecoin' },
  { symbol: 'LINK', name: 'Chainlink', coingecko: 'chainlink' }
]

const MAJOR_ALIASES: Record<string, string> = {
  比特币: 'BTC', 大饼: 'BTC', XBT: 'BTC', BITCOIN: 'BTC',
  以太坊: 'ETH', 以太: 'ETH', 姨太: 'ETH', ETHEREUM: 'ETH',
  索拉纳: 'SOL', 币安币: 'BNB', 波场: 'TRX', MATIC: 'POL', 马蹄: 'POL', 雪崩: 'AVAX',
  狗狗币: 'DOGE', 狗币: 'DOGE', 瑞波: 'XRP', 瑞波币: 'XRP', 莱特币: 'LTC', 艾达币: 'ADA'
}

const MAJOR_NAMES: Record<string, string> = {
  bitcoin: 'BTC', ethereum: 'ETH', solana: 'SOL', binance: 'BNB', tron: 'TRX', polygon: 'POL', avalanche: 'AVAX',
  dogecoin: 'DOGE', ripple: 'XRP', toncoin: 'TON', cardano: 'ADA', litecoin: 'LTC', chainlink: 'LINK'
}

export function majorOf(query: string): Major | undefined {
  const q = query.trim().toUpperCase()
  const sym = MAJOR_ALIASES[q] ?? MAJOR_ALIASES[query.trim()] ?? MAJOR_NAMES[query.trim().toLowerCase()] ?? q
  const exact = MAJORS.find((m) => m.symbol === sym)
  if (exact) return exact
  // 英文全名的拼写容错（如 bitcion、dogcoin），最接近的要唯一
  const w = query.trim().toLowerCase()
  const budget = typoBudget(w)
  if (!budget) return undefined
  const hits = Object.entries(MAJOR_NAMES).map(([name, s]) => ({ s, d: editDistance(w, name) })).filter((h) => h.d <= budget).sort((a, b) => a.d - b.d)
  if (!hits.length || (hits[1] && hits[1].d === hits[0].d)) return undefined
  return MAJORS.find((m) => m.symbol === hits[0].s)
}

const majorCache = new Map<string, { at: number; v: { price: number; change24h?: number } }>()

// 依次尝试：CoinGecko（需代理）→ Gate.io（国内可直连）→ LI.FI；60 秒缓存，避免免费接口限流
export async function majorPrice(m: Major): Promise<{ price: number; change24h?: number } | null> {
  const hit = majorCache.get(m.symbol)
  if (hit && Date.now() - hit.at < 60_000) return hit.v
  const sources: (() => Promise<{ price: number; change24h?: number } | null>)[] = [
    async () => {
      const j = await getJson<Record<string, { usd?: number; usd_24h_change?: number }>>(
        `https://api.coingecko.com/api/v3/simple/price?ids=${m.coingecko}&vs_currencies=usd&include_24hr_change=true`, 6_000
      )
      const r = j[m.coingecko]
      return r?.usd ? { price: r.usd, change24h: r.usd_24h_change } : null
    },
    async () => {
      const j = await getJson<{ last?: string; change_percentage?: string }[]>(`https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${m.symbol}_USDT`, 6_000)
      const p = Number(j[0]?.last)
      return p > 0 ? { price: p, change24h: j[0]?.change_percentage ? Number(j[0].change_percentage) : undefined } : null
    },
    async () => {
      if (!m.lifi) return null
      const j = await getJson<{ priceUSD?: string }>(`${LIFI_API}/token?chain=${m.lifi.chain}&token=${m.lifi.token}`)
      const p = Number(j.priceUSD)
      return p > 0 ? { price: p } : null
    }
  ]
  // 没开代理时 CoinGecko 连不上，先试国内能直连的 Gate.io，省掉一次超时等待
  const order = proxyStatus() ? sources : [sources[1], sources[0], sources[2]]
  for (const src of order) {
    const v = await src().catch(() => null)
    if (v) {
      majorCache.set(m.symbol, { at: Date.now(), v })
      return v
    }
  }
  return null
}
