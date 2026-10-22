// 陌生链自适应：注册表里找不到的网络，先刷新注册表，再联网搜索 → 模型从网页提取参数 → RPC 实测验证 → 用户确认后添加。
// 网页和模型都可能出错，所以：RPC 地址必须原样出现在网页里，每个 RPC 返回的 chainId 必须和声称的一致。
import { randomUUID } from 'node:crypto'
import type { DiscoveryCard, RiskCheck } from '../shared/types'
import { type Network, type RawChain, addAlias, addCustomNetwork, allNetworks, refreshRegistry, resolveNetwork, summary } from './chains/registry'
import { completeJson } from './intent/llm'
import type { Intent } from './intent/parser'
import { probe } from './rpc'
import { llmConfig } from './settings'
import { pageText, webSearch } from './websearch'

const MAX_PAGES = 4

interface Extracted {
  found: boolean
  evm: boolean
  name: string | null
  chainId: number | null
  nativeSymbol: string | null
  nativeDecimals: number | null
  rpcUrls: string[]
  explorer: string | null
  isTestnet: boolean
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['found', 'evm', 'name', 'chainId', 'nativeSymbol', 'nativeDecimals', 'rpcUrls', 'explorer', 'isTestnet'],
  properties: {
    found: { type: 'boolean' },
    evm: { type: 'boolean' },
    name: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    chainId: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    nativeSymbol: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    nativeDecimals: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    rpcUrls: { type: 'array', items: { type: 'string' } },
    explorer: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    isTestnet: { type: 'boolean' }
  }
}

const SYSTEM = `你从网页资料里提取区块链网络的连接参数，只输出 JSON。
规则：
1. 只能使用资料里明确写出的信息，绝不编造或补全。资料里没有就填 null / 空数组，found=false。
2. rpcUrls 必须逐字复制资料里出现的 https RPC 地址，最多 6 个；带 API Key 占位符（如 \${API_KEY}、<key>）的不要。
3. evm=true 表示这是 EVM 兼容链（有以太坊式 chainId、支持 eth_ RPC）；否则 evm=false。
4. 用户要找的网络如果资料里同时有主网和测试网，按用户的说法选；用户没说测试网就选主网。
5. chainId 是十进制整数。`

interface Pending {
  card: DiscoveryCard
  raw: RawChain
  query: string
  followUp: Intent | null
  at: number
}

const pending = new Map<string, Pending>()

export type DiscoveryResult = { found: Network } | { card: DiscoveryCard }

async function rpcChainId(url: string): Promise<{ id: number; ms: number }> {
  const t0 = performance.now()
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    signal: AbortSignal.timeout(8_000)
  })
  const j = (await res.json()) as { result?: string }
  if (!j.result) throw new Error('无效响应')
  return { id: Number(BigInt(j.result)), ms: Math.round(performance.now() - t0) }
}

const byChainId = (id: number) => allNetworks().find((n) => n.family === 'evm' && n.chainId === id)

export async function discoverChain(query: string, followUp: Intent | null, rpcHint?: string): Promise<DiscoveryResult> {
  // 1. 刷新注册表：新链可能刚被 chainlist / chainid.network 收录
  await refreshRegistry().catch(() => 0)
  const again = resolveNetwork(query)
  if (again.best) return { found: again.best }

  // 2. 用户直接给了 RPC：先问它是哪条链
  let hintId: number | undefined
  if (rpcHint) {
    hintId = (await rpcChainId(rpcHint).catch(() => undefined))?.id
    const known = hintId !== undefined ? byChainId(hintId) : undefined
    if (known) {
      addAlias(known, query)
      return { found: known }
    }
  }

  // 3. 联网搜索并读网页
  const q = hintId !== undefined ? `chain ID ${hintId} ${query} EVM RPC` : `${query} blockchain network chain ID RPC URL`
  const results = await webSearch(q)
  if (!results.length) throw new Error(`联网搜索「${query}」没有结果，请确认网络名称，或直接提供它的 RPC 地址`)
  const pages = await Promise.all(results.slice(0, MAX_PAGES).map(async (r) => ({ ...r, text: await pageText(r.url).catch(() => '') })))
  const corpus = [
    ...results.map((r) => `【搜索结果】${r.title}\n${r.url}\n${r.snippet}`),
    ...pages.filter((p) => p.text).map((p) => `【网页】${p.url}\n${p.text}`)
  ].join('\n\n')

  // 4. 模型从资料里提取参数
  const raw = await completeJson(
    await llmConfig(), SYSTEM,
    `用户要找的网络：${query}${hintId !== undefined ? `（RPC 返回的 chainId 是 ${hintId}）` : ''}\n\n资料：\n${corpus}`, SCHEMA
  )
  const start = raw.indexOf('{')
  const x = JSON.parse(raw.slice(start, raw.lastIndexOf('}') + 1)) as Extracted
  if (!x.found || !x.chainId) throw new Error(`联网搜索没能确认「${query}」的网络参数，请直接提供它的 RPC 地址`)
  if (!x.evm) throw new Error(`「${x.name ?? query}」不是 EVM 兼容链，钱包暂时无法自动适配`)
  if (hintId !== undefined && x.chainId !== hintId) throw new Error(`网页资料里的 chainId（${x.chainId}）和你给的 RPC（${hintId}）不一致，已停止`)

  const known = byChainId(x.chainId)
  if (known) {
    addAlias(known, query)
    return { found: known }
  }

  // 5. 验证 RPC：必须原样出现在资料里（防止模型编造），且 chainId 一致
  const lower = corpus.toLowerCase()
  const candidates = [...new Set([...(rpcHint ? [rpcHint] : []), ...x.rpcUrls])]
    .map((u) => u.trim().replace(/\/$/, ''))
    .filter((u) => u.startsWith('https://') && !/[${}<>]/.test(u))
  const rpcs = await Promise.all(
    candidates.slice(0, 8).map(async (url) => {
      if (url !== rpcHint && !lower.includes(url.toLowerCase())) return { url, ok: false, error: '资料里没有这个地址，已忽略' }
      try {
        const r = await rpcChainId(url)
        return r.id === x.chainId ? { url, ok: true, latencyMs: r.ms } : { url, ok: false, error: `chainId 是 ${r.id}，不一致` }
      } catch (e) {
        return { url, ok: false, error: (e as Error).message.slice(0, 40) }
      }
    })
  )
  const okRpcs = rpcs.filter((r) => r.ok)
  const sources = [...new Set(pages.filter((p) => p.text).map((p) => p.url))].slice(0, 4)
  const symbol = (x.nativeSymbol ?? 'ETH').toUpperCase().slice(0, 12)
  const name = x.name ?? query

  const checks: RiskCheck[] = [
    { level: 'warn', text: '这是联网搜索发现的网络，参数来自第三方网页。请到官方文档核对 chainId 和 RPC 后再添加' },
    okRpcs.length
      ? { level: 'ok', text: `${okRpcs.length} 个 RPC 实测返回 chainId ${x.chainId}，与资料一致` }
      : { level: 'danger', text: '没有一个 RPC 能连上并返回正确的 chainId，无法添加' },
    { level: 'info', text: '添加后可以查余额、转账、按合约地址操作代币；这条链上的兑换和跨链取决于聚合器是否支持' }
  ]
  if (!x.explorer) checks.push({ level: 'info', text: '没找到区块浏览器，交易记录里不会有浏览器链接' })

  const card: DiscoveryCard = {
    kind: 'discovery', id: randomUUID(), status: okRpcs.length ? 'ready' : 'blocked',
    name, chainId: x.chainId, nativeSymbol: symbol, isTestnet: x.isTestnet, explorer: x.explorer ?? undefined,
    rpcs, sources, checks, followUp: followUp ? '添加后会继续执行你刚才的指令' : undefined
  }
  if (okRpcs.length) {
    const rawChain: RawChain = {
      name, chainId: x.chainId, shortName: name.toLowerCase().replace(/\s+/g, '-'), isTestnet: x.isTestnet,
      nativeCurrency: { symbol, decimals: x.nativeDecimals ?? 18 },
      rpc: okRpcs.sort((a, b) => (a.latencyMs ?? 0) - (b.latencyMs ?? 0)).map((r) => ({ url: r.url })),
      explorers: x.explorer?.startsWith('https://') ? [{ url: x.explorer }] : [],
      extraAliases: [query]
    }
    pending.set(card.id, { card, raw: rawChain, query, followUp, at: Date.now() })
  }
  return { card }
}

export async function confirmDiscovery(id: string): Promise<{ network: ReturnType<typeof summary>; followUp: Intent | null }> {
  const p = pending.get(id)
  if (!p) throw new Error('这个网络发现结果已失效，请重新说一次')
  pending.delete(id)
  const n = addCustomNetwork(p.raw)
  await probe(n.id).catch(() => undefined)
  return { network: summary(n), followUp: p.followUp }
}

export function cancelDiscovery(id: string): void {
  pending.delete(id)
}
