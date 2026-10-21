// 编排层：意图 → 解析网络 / 资产 / 收款方 → 模拟 → 风控 → 待确认卡片 → 用户确认后签名广播。
// 确认卡片上的内容全部来自确定性代码，不来自 LLM 文本。
import { randomUUID } from 'node:crypto'
import { formatUnits, parseUnits } from 'viem'
import type { BalanceCard, Card, ChainFamily, ChatResponse, Contact, InfoCard, RiskCheck, TransferCard } from '../shared/types'
import { evm, resolveEns, shortErr } from './adapters/evm'
import { solana } from './adapters/solana'
import { tron } from './adapters/tron'
import type { Asset, ChainAdapter, TransferParams } from './adapters/types'
import { type Network, allNetworks, explorerTx, getNetwork, resolveNetwork, summary } from './chains/registry'
import { type Intent, parseIntent } from './intent/parser'
import { describeLlmError } from './intent/llm'
import { addresses, signers } from './keystore'
import { recipientChecks } from './risk'
import { planRoute } from './routes'
import { addCustomRpc, probe } from './rpc'
import { llmConfig, setPrefs, settings } from './settings'
import { readJson, writeJson } from './store'
import { listedByAddress, listedToken, TOKENS } from './tokens'

const ADAPTERS: Record<ChainFamily, ChainAdapter> = { evm, solana, tron }
const PENDING_TTL = 10 * 60 * 1000
const STABLES = ['USDT', 'USDC']

interface HistoryItem {
  at: number
  networkId: string
  hash: string
  from: string
  to: string
  toLabel?: string
  asset: string
  amount: string
  status: 'sent' | 'confirmed' | 'failed'
}

interface Pending {
  card: TransferCard
  params: TransferParams
  fee: bigint
  createdAt: number
}

const pending = new Map<string, Pending>()
const recent: { user: string; reply: string }[] = []
const verifiedDecimals = new Map<string, number>()

// ---------- 联系人 / 历史 ----------

export function contacts(): Contact[] {
  return readJson<Contact[]>('contacts.json', [])
}

export function saveContact(c: Contact): void {
  const list = contacts().filter((x) => !(x.name === c.name && x.family === c.family))
  list.push(c)
  writeJson('contacts.json', list)
}

export function removeContact(name: string, family: ChainFamily): void {
  writeJson('contacts.json', contacts().filter((x) => !(x.name === name && x.family === family)))
}

function history(): HistoryItem[] {
  return readJson<HistoryItem[]>('history.json', [])
}

function pushHistory(h: HistoryItem): void {
  writeJson('history.json', [h, ...history()].slice(0, 200))
}

function updateHistory(hash: string, status: HistoryItem['status']): void {
  writeJson('history.json', history().map((h) => (h.hash === hash ? { ...h, status } : h)))
}

// ---------- 工具 ----------

// 最多 6 位小数；很小的数（如 L2 手续费）保留 3 位有效数字，避免显示成 0
function fmt(v: bigint, decimals: number): string {
  const s = formatUnits(v, decimals)
  const [i, f = ''] = s.split('.')
  let frac = f.slice(0, 6).replace(/0+$/, '')
  if (i.replace('-', '') === '0' && !frac && v !== 0n) {
    const lead = f.match(/^0*/)![0].length
    frac = f.slice(0, lead + 3).replace(/0+$/, '')
  }
  return frac ? `${i}.${frac}` : i
}

function info(level: InfoCard['level'], text: string): InfoCard {
  return { kind: 'info', level, text }
}

function myAddress(family: ChainFamily): string {
  const a = addresses()
  if (!a) throw new Error('钱包已锁定')
  return a[family]
}

function familyOfAddress(s: string): ChainFamily | undefined {
  if (evm.isAddress(s) || /\.eth$/i.test(s)) return 'evm'
  if (tron.isAddress(s)) return 'tron'
  if (solana.isAddress(s)) return 'solana'
  return undefined
}

function pickNetwork(query: string | null, recipientHint?: string | null): Network {
  if (query) {
    const m = resolveNetwork(query)
    if (m.best) return m.best
    if (m.candidates.length) throw new Error(`「${query}」可能是：${m.candidates.map((c) => c.name).join(' / ')}，请说得更具体一点`)
    throw new Error(`找不到叫「${query}」的网络`)
  }
  const def = getNetwork(settings().defaultNetwork)
  const contact = recipientHint ? contacts().find((c) => c.name === recipientHint) : undefined
  const family = contact?.family ?? (recipientHint ? familyOfAddress(recipientHint) : undefined)
  if (!family || family === def.family) return def
  // 地址属于别的链：同测试 / 主网属性下选该链的默认网络
  const fallback = { solana: def.isTestnet ? 'solana:devnet' : 'solana:mainnet', tron: def.isTestnet ? 'tron:nile' : 'tron:mainnet', evm: def.isTestnet ? 'evm:11155111' : 'evm:1' }
  return getNetwork(fallback[family])
}

function nativeAsset(n: Network): Asset {
  return { kind: 'native', symbol: n.nativeSymbol, decimals: n.nativeDecimals }
}

async function resolveAsset(n: Network, query: string | null): Promise<Asset> {
  const adapter = ADAPTERS[n.family]
  if (!query || query.toUpperCase() === n.nativeSymbol.toUpperCase() || ['原生币', 'gas币', 'gas'].includes(query)) {
    return nativeAsset(n)
  }
  if (adapter.isAddress(query)) {
    const addr = adapter.normalizeAddress(query)
    const listed = listedByAddress(n.id, addr)
    if (listed) return { kind: 'token', ...listed, listed: true }
    const meta = await adapter.tokenMeta(n, addr)
    return { kind: 'token', symbol: meta.symbol, decimals: meta.decimals, address: addr, listed: false }
  }
  const t = listedToken(n.id, query)
  if (!t) throw new Error(`${n.name} 上没有内置的 ${query}，可以直接告诉我代币合约地址`)
  // 链上核对白名单 decimals，防止内置列表出错
  const key = `${n.id}:${t.address}`
  if (!verifiedDecimals.has(key)) {
    const meta = await adapter.tokenMeta(n, t.address)
    verifiedDecimals.set(key, meta.decimals)
  }
  if (verifiedDecimals.get(key) !== t.decimals) throw new Error(`${t.symbol} 合约链上 decimals 与内置列表不一致，已拒绝`)
  return { kind: 'token', ...t, listed: true }
}

async function resolveRecipient(n: Network, raw: string): Promise<{ address: string; label?: string; checks: RiskCheck[] }> {
  const adapter = ADAPTERS[n.family]
  const book = contacts()
  const byName = book.find((c) => c.name.toLowerCase() === raw.toLowerCase())
  if (byName) {
    if (byName.family !== n.family) throw new Error(`联系人「${byName.name}」存的是 ${byName.family} 地址，不能在 ${n.name} 上收款`)
    return { address: byName.address, label: byName.name, checks: [] }
  }
  if (adapter.isAddress(raw)) {
    const address = adapter.normalizeAddress(raw)
    const label = book.find((c) => c.family === n.family && c.address.toLowerCase() === address.toLowerCase())?.name
    return { address, label, checks: [] }
  }
  if (n.family === 'evm' && /\.eth$/i.test(raw)) {
    const address = await resolveEns(raw)
    if (!address) throw new Error(`ENS 名称 ${raw} 没有解析到地址`)
    return { address, label: raw, checks: [{ level: 'warn', text: `${raw} 通过 ENS 解析为 ${address}，请核对` }] }
  }
  const other = familyOfAddress(raw)
  if (other && other !== n.family) throw new Error(`这是 ${other} 格式的地址，不能在 ${n.name} 上收款`)
  const similar = book.filter((c) => c.name.includes(raw) || raw.includes(c.name)).map((c) => c.name)
  if (similar.length) throw new Error(`没找到联系人「${raw}」，你是指 ${similar.join(' / ')} 吗？`)
  throw new Error(`无法识别收款方「${raw}」：既不是联系人，也不是 ${n.name} 地址`)
}

// ---------- 意图执行 ----------

async function doTransfer(intent: Intent): Promise<Card> {
  if (!intent.recipient) throw new Error('没有说转给谁')
  if (!intent.amount) throw new Error('没有说转多少')
  const n = pickNetwork(intent.network, intent.recipient)
  const adapter = ADAPTERS[n.family]
  const asset = await resolveAsset(n, intent.asset)
  const to = await resolveRecipient(n, intent.recipient)
  const from = myAddress(n.family)
  const native = nativeAsset(n)

  const [assetBal, nativeBal] = await Promise.all([
    adapter.balance(n, from, asset),
    asset.kind === 'native' ? Promise.resolve(0n) : adapter.balance(n, from, native)
  ])
  const nativeBalance = asset.kind === 'native' ? assetBal : nativeBal

  const amount = intent.amount === 'max' ? await adapter.maxAmount({ network: n, from, to: to.address, asset }) : parseUnits(intent.amount, asset.decimals)
  if (amount <= 0n) throw new Error(intent.amount === 'max' ? `${asset.symbol} 余额不足，无法转出` : '转账数量必须大于 0')

  const params: TransferParams = { network: n, from, to: to.address, asset, amount }
  const prepared = await adapter.prepare(params)

  const checks: RiskCheck[] = [...to.checks, ...prepared.checks]
  if (!n.isTestnet) {
    if (!settings().allowMainnet) checks.unshift({ level: 'danger', text: '主网转账未开启：在设置里打开「允许主网转账」后再试' })
    else checks.unshift({ level: 'warn', text: `这是 ${n.name} 主网，资产真实` })
    if (STABLES.includes(asset.symbol) && amount > parseUnits(String(settings().stableLimit), asset.decimals)) {
      checks.push({ level: 'danger', text: `超过单笔限额 ${settings().stableLimit} ${asset.symbol}` })
    }
  } else {
    checks.unshift({ level: 'info', text: `测试网：${n.name}` })
  }
  if (asset.kind === 'token' && !asset.listed) checks.push({ level: 'warn', text: '不在内置白名单的代币，请确认合约地址可信' })
  if (amount > assetBal) checks.push({ level: 'danger', text: `余额不足：只有 ${fmt(assetBal, asset.decimals)} ${asset.symbol}` })
  const needNative = prepared.fee + (asset.kind === 'native' ? amount : 0n)
  if (needNative > nativeBalance) checks.push({ level: 'danger', text: `${n.nativeSymbol} 不足以支付${asset.kind === 'native' ? '金额和' : ''}手续费` })
  else if (amount <= assetBal && amount * 2n > assetBal) checks.push({ level: 'warn', text: '这笔超过该资产余额的一半' })
  if (!prepared.simulation.ok) checks.push({ level: 'danger', text: prepared.simulation.detail })

  const known = [
    ...contacts().filter((c) => c.family === n.family).map((c) => ({ address: c.address, label: c.name })),
    ...history().filter((h) => h.networkId.startsWith(`${n.family}:`)).map((h) => ({ address: h.to, label: h.toLabel ?? '历史收款地址' }))
  ]
  checks.push(...recipientChecks({ family: n.family, from, to: to.address, known }))

  const blocked = checks.some((c) => c.level === 'danger')
  const after = assetBal - amount - (asset.kind === 'native' ? prepared.fee : 0n)
  const card: TransferCard = {
    kind: 'transfer',
    id: randomUUID(),
    status: blocked ? 'blocked' : 'ready',
    network: summary(n),
    from,
    to: to.address,
    toLabel: to.label,
    asset: asset.symbol,
    amount: fmt(amount, asset.decimals),
    fee: fmt(prepared.fee, n.nativeDecimals),
    feeSymbol: n.nativeSymbol,
    balanceAfter: after >= 0n ? fmt(after, asset.decimals) : undefined,
    simulation: prepared.simulation,
    checks
  }
  if (!blocked) pending.set(card.id, { card, params, fee: prepared.fee, createdAt: Date.now() })
  return card
}

// 兑换 / 跨链：解析两端网络和资产后交给 routes
async function doRoute(intent: Intent): Promise<Card> {
  if (!intent.amount) throw new Error('没有说数量')
  const mode = intent.action === 'bridge' ? 'bridge' : 'swap'
  if (mode === 'bridge' && !intent.to_network) throw new Error('没有说跨到哪条链')
  if (mode === 'swap' && !intent.to_asset) throw new Error('没有说换成什么币')
  const from = pickNetwork(intent.network)
  const to = mode === 'bridge' ? pickNetwork(intent.to_network) : from
  const fromAsset = await resolveAsset(from, intent.asset)
  // 跨链没说目标币：同名币（原生币对原生币）
  const toQuery = intent.to_asset ?? (fromAsset.kind === 'native' ? to.nativeSymbol : fromAsset.symbol)
  const toAsset = await resolveAsset(to, toQuery)
  const owner = myAddress(from.family)
  const amount =
    intent.amount === 'max'
      ? await ADAPTERS[from.family].maxAmount({ network: from, from: owner, to: owner, asset: fromAsset })
      : parseUnits(intent.amount, fromAsset.decimals)
  return planRoute({ mode, from, to, fromAsset, toAsset, amount })
}

// 小窗顶部的余额：默认网络的原生币 + 白名单代币
export function defaultBalances(): Promise<BalanceCard> {
  const id = settings().defaultNetwork
  return doBalance({ action: 'balance', network: id, asset: null, amount: null, recipient: null, name: null, url: null, to_network: null, to_asset: null })
}

async function doBalance(intent: Intent): Promise<BalanceCard> {
  const n = pickNetwork(intent.network)
  const adapter = ADAPTERS[n.family]
  const owner = myAddress(n.family)
  const assets: Asset[] = intent.asset
    ? [await resolveAsset(n, intent.asset)]
    : [nativeAsset(n), ...(TOKENS[n.id] ?? []).map((t) => ({ kind: 'token' as const, ...t, listed: true }))]
  const rows = await Promise.all(
    assets.map(async (a) => {
      try {
        return { network: n.name, asset: a.symbol, amount: fmt(await adapter.balance(n, owner, a), a.decimals) }
      } catch (e) {
        return { network: n.name, asset: a.symbol, amount: '-', error: shortErr(e) }
      }
    })
  )
  return { kind: 'balances', rows }
}

async function doUseNetwork(intent: Intent): Promise<Card[]> {
  if (!intent.network) throw new Error('没有说是哪条链')
  const n = pickNetwork(intent.network)
  const state = await probe(n.id)
  if (!state.selected.length) return [info('danger', `${n.name} 的 ${state.ranked.length} 个候选节点都不可用`)]
  setPrefs({ defaultNetwork: n.id })
  return [{ kind: 'network', network: summary(n), state }, info('ok', `已切换默认网络为 ${n.name}，自动选用最快的 ${state.selected.length} 个节点`)]
}

async function doAddRpc(intent: Intent): Promise<Card> {
  if (!intent.network || !intent.url) throw new Error('需要链名和 RPC 地址')
  const n = pickNetwork(intent.network)
  const state = await addCustomRpc(n.id, intent.url)
  return { kind: 'network', network: summary(n), state }
}

function doAddContact(intent: Intent): Card {
  const name = intent.name?.trim()
  const address = intent.recipient?.trim()
  if (!name || !address) throw new Error('保存联系人需要名字和地址')
  const family = intent.network ? pickNetwork(intent.network).family : familyOfAddress(address)
  if (!family || /\.eth$/i.test(address)) throw new Error('无法识别地址格式（支持 EVM 0x 地址、Solana 地址、Tron T 开头地址）')
  const adapter = ADAPTERS[family]
  if (!adapter.isAddress(address)) throw new Error(`这不是有效的 ${family} 地址`)
  saveContact({ name, address: adapter.normalizeAddress(address), family })
  return info('ok', `已保存联系人「${name}」（${family}）：${adapter.normalizeAddress(address)}`)
}

function doShowAddress(intent: Intent): Card {
  const a = addresses()
  if (!a) throw new Error('钱包已锁定')
  if (intent.network) {
    const n = pickNetwork(intent.network)
    return info('info', `${n.name} 收款地址：${a[n.family]}`)
  }
  return info('info', `EVM（所有 EVM 链通用）：${a.evm}\nSolana：${a.solana}\nTron：${a.tron}`)
}

function doHistory(): Card {
  const items = history().slice(0, 8)
  if (!items.length) return info('info', '还没有转账记录')
  const lines = items.map((h) => {
    const t = new Date(h.at).toLocaleString('zh-CN', { hour12: false })
    const status = { sent: '已广播', confirmed: '已确认', failed: '失败' }[h.status]
    return `${t}  ${getNetwork(h.networkId).name}  ${h.amount} ${h.asset} → ${h.toLabel ?? `${h.to.slice(0, 8)}…`}  ${status}`
  })
  return info('info', lines.join('\n'))
}

export async function execute(intent: Intent): Promise<Card[]> {
  switch (intent.action) {
    case 'transfer': return [await doTransfer(intent)]
    case 'swap':
    case 'bridge': return [await doRoute(intent)]
    case 'balance': return [await doBalance(intent)]
    case 'use_network': return doUseNetwork(intent)
    case 'add_rpc': return [await doAddRpc(intent)]
    case 'add_contact': return [doAddContact(intent)]
    case 'show_address': return [doShowAddress(intent)]
    case 'history': return [doHistory()]
    // 网站连接由界面里的 WalletConnect 执行
    case 'dapp_list': return [{ kind: 'dapp_command', op: 'list', target: null }]
    case 'dapp_disconnect': return [{ kind: 'dapp_command', op: 'disconnect', target: intent.name }]
  }
}

export async function chat(text: string): Promise<ChatResponse> {
  let parsed
  try {
    parsed = await parseIntent(await llmConfig(), text, {
      defaultNetwork: getNetwork(settings().defaultNetwork).name,
      contacts: contacts().map((c) => c.name),
      recent
    })
  } catch (e) {
    return { reply: '', cards: [info('danger', describeLlmError(e, settings().llm.baseURL))] }
  }
  recent.push({ user: text, reply: parsed.clarify ?? parsed.reply })
  if (recent.length > 8) recent.shift()
  if (parsed.clarify) return { reply: parsed.clarify, cards: [] }

  const cards: Card[] = []
  for (const intent of parsed.intents) {
    try {
      cards.push(...(await execute(intent)))
    } catch (e) {
      cards.push(info('danger', shortErr(e)))
    }
  }
  return { reply: parsed.reply, cards }
}

// ---------- 确认 / 取消 / 状态 ----------

export async function confirm(id: string): Promise<TransferCard> {
  const p = pending.get(id)
  if (!p) throw new Error('这笔交易已失效，请重新发起')
  pending.delete(id)
  const card = p.card
  if (Date.now() - p.createdAt > PENDING_TTL) return Object.assign(card, { status: 'expired', error: '确认超时，请重新发起' })

  const adapter = ADAPTERS[p.params.network.family]
  const s = signers()
  // 签名前重新模拟：状态变了或手续费大涨就不签
  const again = await adapter.prepare(p.params)
  if (!again.simulation.ok) return Object.assign(card, { status: 'failed', error: again.simulation.detail })
  if (again.fee > (p.fee * 3n) / 2n + 1n) {
    return Object.assign(card, { status: 'expired', error: `手续费从 ${card.fee} 涨到 ${fmt(again.fee, p.params.network.nativeDecimals)} ${card.feeSymbol}，请重新确认` })
  }
  try {
    const hash = await adapter.send(p.params, s)
    Object.assign(card, { status: 'sent', hash, explorerUrl: explorerTx(p.params.network, hash) })
    pushHistory({
      at: Date.now(), networkId: p.params.network.id, hash, from: card.from, to: card.to, toLabel: card.toLabel,
      asset: card.asset, amount: card.amount, status: 'sent'
    })
    sent.set(id, card)
  } catch (e) {
    Object.assign(card, { status: 'failed', error: shortErr(e) })
  }
  return card
}

export function cancel(id: string): void {
  pending.delete(id)
}

const sent = new Map<string, TransferCard>()

export async function txStatus(id: string): Promise<TransferCard | undefined> {
  const card = sent.get(id)
  if (!card?.hash) return card
  const n = getNetwork(card.network.id)
  const st = await ADAPTERS[n.family].status(n, card.hash).catch(() => 'pending' as const)
  if (st === 'success') card.status = 'confirmed'
  if (st === 'failed') card.status = 'failed'
  if (st !== 'pending') {
    updateHistory(card.hash, st === 'success' ? 'confirmed' : 'failed')
    sent.delete(id)
  }
  return card
}

export function networkList() {
  return allNetworks()
}
