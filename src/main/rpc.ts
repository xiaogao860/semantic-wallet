// RPC 自动配置：并发探测候选节点 → 校验网络身份 → 剔除落后节点 → 按延迟排序选前 3。
// 结果缓存 10 分钟；用户自己加的 RPC 排在公共节点前面参与探测。
import type { NetworkRpcState, RpcHealth } from '../shared/types'
import { getNetwork, type Network } from './chains/registry'
import { readJson, writeJson } from './store'

const STATE_FILE = 'rpc-state.json'
const CUSTOM_FILE = 'rpc-custom.json'
const FRESH_MS = 10 * 60 * 1000
const PROBE_TIMEOUT = 6000
const MAX_PROBE = 10
const KEEP = 3
const LAG_TOLERANCE = { evm: 20, solana: 150, tron: 5 }

let states: Record<string, NetworkRpcState> = {}
let custom: Record<string, string[]> = {}
const inflight = new Map<string, Promise<NetworkRpcState>>()

export function loadRpcState(): void {
  states = readJson(STATE_FILE, {})
  custom = readJson(CUSTOM_FILE, {})
}

async function post(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(PROBE_TIMEOUT)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function rpc(url: string, method: string, params: unknown[] = []): Promise<any> {
  const j = await post(url, { jsonrpc: '2.0', id: 1, method, params })
  if (j.error) throw new Error(j.error.message ?? 'rpc error')
  return j.result
}

// 返回 [区块高度, 网络身份]
async function probeOne(n: Network, url: string): Promise<[number, string]> {
  if (n.family === 'evm') {
    const [cid, h] = await Promise.all([rpc(url, 'eth_chainId'), rpc(url, 'eth_blockNumber')])
    return [Number(BigInt(h)), String(Number(BigInt(cid)))]
  }
  if (n.family === 'solana') {
    const [g, slot] = await Promise.all([rpc(url, 'getGenesisHash'), rpc(url, 'getSlot')])
    return [slot, g]
  }
  const base = url.replace(/\/$/, '')
  const [now, genesis] = await Promise.all([
    post(`${base}/wallet/getnowblock`, {}),
    post(`${base}/wallet/getblockbynum`, { num: 0 })
  ])
  const h = now?.block_header?.raw_data?.number
  if (typeof h !== 'number') throw new Error('无效响应')
  return [h, genesis?.blockID ?? '']
}

function expectedIdentity(n: Network): string | undefined {
  if (n.family === 'evm') return String(n.chainId)
  if (n.family === 'solana') return n.genesis
  return undefined // Tron 用多数派创世块校验
}

export async function probe(networkId: string): Promise<NetworkRpcState> {
  const existing = inflight.get(networkId)
  if (existing) return existing
  const task = doProbe(networkId).finally(() => inflight.delete(networkId))
  inflight.set(networkId, task)
  return task
}

async function doProbe(networkId: string): Promise<NetworkRpcState> {
  const n = getNetwork(networkId)
  const urls = [...new Set([...(custom[networkId] ?? []), ...n.rpcCandidates])].slice(0, MAX_PROBE + (custom[networkId]?.length ?? 0))
  const results = await Promise.all(
    urls.map(async (url) => {
      const t0 = performance.now()
      try {
        const [height, identity] = await probeOne(n, url)
        return { url, ok: true, latencyMs: Math.round(performance.now() - t0), height, identity }
      } catch (e) {
        return { url, ok: false, latencyMs: PROBE_TIMEOUT, error: shortError(e), identity: '' }
      }
    })
  )

  // 网络身份校验：EVM 比对 chainId，Solana 比对创世哈希，Tron 取多数派创世块
  let expect = expectedIdentity(n)
  if (!expect) {
    const votes = new Map<string, number>()
    for (const r of results) if (r.ok && r.identity) votes.set(r.identity, (votes.get(r.identity) ?? 0) + 1)
    expect = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  }
  for (const r of results) {
    if (r.ok && expect && r.identity !== expect) Object.assign(r, { ok: false, error: '网络身份不符（chainId/创世块不匹配）' })
  }

  // 落后节点剔除：与健康节点的中位高度比较
  const heights = results.filter((r) => r.ok).map((r) => r.height!).sort((a, b) => a - b)
  const median = heights[Math.floor(heights.length / 2)]
  for (const r of results) {
    if (r.ok && median !== undefined && median - r.height! > LAG_TOLERANCE[n.family]) {
      Object.assign(r, { ok: false, error: `落后 ${median - r.height!} 块` })
    }
  }

  const ranked: RpcHealth[] = results
    .map(({ identity: _, ...r }) => r)
    .sort((a, b) => Number(b.ok) - Number(a.ok) || a.latencyMs - b.latencyMs)
  const state: NetworkRpcState = {
    networkId,
    checkedAt: Date.now(),
    ranked,
    selected: ranked.filter((r) => r.ok).slice(0, KEEP).map((r) => r.url)
  }
  states[networkId] = state
  writeJson(STATE_FILE, states)
  return state
}

function shortError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  if (/timeout|aborted/i.test(msg)) return '超时'
  return msg.slice(0, 60)
}

// 代理开关后网络路径变了：丢掉旧的测速结果，下次使用时重新探测
export function invalidateRpcState(): void {
  states = {}
  writeJson(STATE_FILE, states)
}

export function cachedState(networkId: string): NetworkRpcState | undefined {
  return states[networkId]
}

// 拿到可用 RPC 列表（已排序）。缓存过期时后台刷新；没有可用节点时同步探测。
export async function rpcsFor(networkId: string): Promise<string[]> {
  const s = states[networkId]
  if (s?.selected.length) {
    if (Date.now() - s.checkedAt > FRESH_MS) void probe(networkId)
    return s.selected
  }
  const fresh = await probe(networkId)
  if (!fresh.selected.length) throw new Error(`${getNetwork(networkId).name} 没有可用的 RPC 节点`)
  return fresh.selected
}

// 按排序依次尝试，节点出错自动切到下一个
export async function withRpc<T>(networkId: string, fn: (url: string) => Promise<T>): Promise<T> {
  const urls = await rpcsFor(networkId)
  let lastErr: unknown
  for (const url of urls) {
    try {
      return await fn(url)
    } catch (e) {
      lastErr = e
      if (!isTransportError(e)) throw e
    }
  }
  void probe(networkId)
  throw lastErr
}

function isTransportError(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e)
  return /fetch failed|timeout|aborted|ECONN|ENOTFOUND|socket|HTTP 5\d\d|429|rate limit|too many requests|503|502/i.test(msg)
}

export async function addCustomRpc(networkId: string, url: string): Promise<NetworkRpcState> {
  if (!/^https:\/\//.test(url)) throw new Error('只接受 https:// 开头的 RPC 地址')
  custom[networkId] = [...new Set([url, ...(custom[networkId] ?? [])])]
  writeJson(CUSTOM_FILE, custom)
  const state = await probe(networkId)
  const mine = state.ranked.find((r) => r.url === url)
  if (!mine?.ok) {
    custom[networkId] = custom[networkId].filter((u) => u !== url)
    writeJson(CUSTOM_FILE, custom)
    throw new Error(`这个 RPC 不可用：${mine?.error ?? '未知错误'}`)
  }
  return state
}
