// 网站请求（WalletConnect）的解码、风控与签名。
// 界面进程只负责收发；请求内容在这里独立解码，卡片上展示的是解码结果，签名也只在这里做。
import { randomUUID } from 'node:crypto'
import {
  type Hex,
  decodeFunctionData,
  erc20Abi,
  formatUnits,
  hexToString,
  isAddress,
  isHex,
  parseAbi,
  parseAbiItem
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { DappField, DappRequestCard, DappRequestInput, RiskCheck } from '../shared/types'
import { evm, explainError, feeParams, publicClient, sendCall, shortErr } from './adapters/evm'
import { type Network, allNetworks, explorerTx, getNetwork, summary } from './chains/registry'
import { completeJson } from './intent/llm'
import { addresses, signers } from './keystore'
import { llmConfig, settings } from './settings'
import { listedByAddress } from './tokens'

const TTL = 10 * 60 * 1000
const UNLIMITED = 2n ** 255n
const EXTRA_ABI = parseAbi([
  'function setApprovalForAll(address operator, bool approved)',
  'function increaseAllowance(address spender, uint256 addedValue)'
])

type Payload =
  | { type: 'message'; message: string | { raw: Hex } }
  | { type: 'typed'; data: TypedData }
  | { type: 'tx'; network: Network; call: { to?: Hex; data?: Hex; value: bigint }; gas: bigint }

interface TypedData {
  domain: Record<string, unknown>
  types: Record<string, { name: string; type: string }[]>
  primaryType: string
  message: Record<string, unknown>
}

const pending = new Map<string, { card: DappRequestCard; payload: Payload; at: number }>()

// ---------- 工具 ----------

function myEvm(): string {
  const a = addresses()
  if (!a) throw new Error('钱包已锁定，请先解锁')
  return a.evm
}

function sameAddr(a: unknown, b: string): boolean {
  return typeof a === 'string' && a.toLowerCase() === b.toLowerCase()
}

function short(a: string): string {
  return `${a.slice(0, 8)}…${a.slice(-6)}`
}

function networkOf(caip: string): Network {
  const m = /^eip155:(\d+)$/.exec(caip)
  if (!m) throw new Error(`暂不支持 ${caip} 上的请求`)
  return getNetwork(`evm:${m[1]}`)
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function readable(hex: Hex): string | null {
  try {
    const s = hexToString(hex)
    return /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/.test(s) ? s : null
  } catch {
    return null
  }
}

async function tokenOf(n: Network, address: string): Promise<{ symbol: string; decimals: number } | null> {
  const listed = listedByAddress(n.id, address)
  if (listed) return listed
  try {
    return await Promise.race([
      evm.tokenMeta(n, address),
      new Promise<null>((r) => setTimeout(() => r(null), 5000))
    ])
  } catch {
    return null
  }
}

function amountText(v: bigint, token: { symbol: string; decimals: number } | null): string {
  if (v >= UNLIMITED) return `无限额 ${token?.symbol ?? '代币'}`
  if (!token) return `${v.toString()}（最小单位）`
  return `${formatUnits(v, token.decimals)} ${token.symbol}`
}

function originChecks(input: DappRequestInput): RiskCheck[] {
  const checks: RiskCheck[] = []
  if (input.isScam) checks.push({ level: 'danger', text: 'WalletConnect 将这个网站标记为诈骗网站' })
  else if (input.verified === 'INVALID') checks.push({ level: 'danger', text: '网站实际域名与它声明的不一致，疑似仿冒' })
  else if (input.verified !== 'VALID') checks.push({ level: 'info', text: `无法验证网站来源，请确认你正在访问 ${hostOf(input.dapp.url)}` })
  return checks
}

// 4byte 签名库：把未知合约调用的函数选择器翻译成函数签名
async function lookupSelector(selector: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.openchain.xyz/signature-database/v1/lookup?function=${selector}&filter=true`, {
      signal: AbortSignal.timeout(4000)
    })
    const j = (await res.json()) as { result?: { function?: Record<string, { name: string }[]> } }
    return j.result?.function?.[selector]?.[0]?.name ?? null
  } catch {
    return null
  }
}

function argText(v: unknown): string {
  const s = typeof v === 'bigint' ? v.toString() : JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))
  return s.length > 120 ? `${s.slice(0, 117)}…` : s
}

// 大模型只读解码后的事实，给一句人话解释；失败不影响流程
async function aiExplain(facts: string): Promise<string | undefined> {
  try {
    const out = await Promise.race([
      completeJson(
        await llmConfig(),
        '你是钱包里的交易解读助手。根据给出的合约调用信息，用一句中文说明这笔调用大概在做什么、用户可能失去或得到什么。不确定就直说不确定，不要编造。只输出 JSON：{"summary":"..."}',
        facts,
        { type: 'object', additionalProperties: false, required: ['summary'], properties: { summary: { type: 'string' } } }
      ),
      new Promise<string>((_, rej) => setTimeout(() => rej(new Error('timeout')), 12_000))
    ])
    const m = /"summary"\s*:\s*"([^"]+)"/.exec(out)
    return m?.[1]
  } catch {
    return undefined
  }
}

// ---------- 各类请求 ----------

function personalSign(input: DappRequestInput, me: string) {
  const [a, b] = (input.params as string[]) ?? []
  // 规范是 [message, address]，有的网站会反过来
  const swapped = isAddress(a ?? '') && !isAddress(b ?? '')
  const msg = swapped ? b : a
  const addr = swapped ? a : b
  const checks: RiskCheck[] = []
  if (!sameAddr(addr, me)) checks.push({ level: 'danger', text: '请求签名的地址不是本钱包地址' })

  const text = isHex(msg) ? readable(msg) : msg
  const fields: DappField[] = [{ label: '签名内容', value: text ?? msg, mono: !text }]
  if (text && /wants you to sign in with your Ethereum account/.test(text)) {
    const domain = text.split(' wants you')[0].trim()
    if (domain !== hostOf(input.dapp.url)) {
      checks.push({ level: 'danger', text: `登录签名里的域名「${domain}」和当前网站「${hostOf(input.dapp.url)}」不一致，疑似钓鱼` })
    } else {
      checks.push({ level: 'ok', text: '以太坊登录签名（SIWE）：只证明你拥有这个地址，不会花钱' })
    }
  } else {
    checks.push({ level: 'info', text: '消息签名不会直接转移资产，但请确认内容可信' })
  }
  const message = isHex(msg) ? { raw: msg as Hex } : (msg ?? '')
  return { title: '签名消息', fields, checks, payload: { type: 'message', message } as Payload }
}

async function typedSign(input: DappRequestInput, me: string, n: Network) {
  const params = (input.params as unknown[]) ?? []
  const addr = params.find((p) => typeof p === 'string' && isAddress(p)) as string | undefined
  const raw = params.find((p) => p !== addr)
  const data = (typeof raw === 'string' ? JSON.parse(raw) : raw) as TypedData
  const checks: RiskCheck[] = []
  if (!sameAddr(addr, me)) checks.push({ level: 'danger', text: '请求签名的地址不是本钱包地址' })

  const d = data.domain ?? {}
  const msg = data.message ?? {}
  const fields: DappField[] = [
    { label: '签名对象', value: String(d.name ?? '未命名') },
    { label: '类型', value: data.primaryType }
  ]
  if (d.verifyingContract) fields.push({ label: '合约', value: String(d.verifyingContract), mono: true })
  if (d.chainId !== undefined && Number(d.chainId) !== n.chainId) {
    checks.push({ level: 'danger', text: `签名里的链（chainId ${d.chainId}）和当前网络 ${n.name} 不一致` })
  }

  let title = '结构化签名'
  const deadline = (v: unknown) => (v ? new Date(Number(v) * 1000).toLocaleString('zh-CN', { hour12: false }) : '无')
  if (data.primaryType === 'Permit' && msg.spender !== undefined) {
    // EIP-2612 代币离线授权
    title = '代币离线授权（Permit）'
    const token = d.verifyingContract ? await tokenOf(n, String(d.verifyingContract)) : null
    const value = BigInt(String(msg.value ?? 0))
    fields.push({ label: '被授权方', value: String(msg.spender), mono: true }, { label: '额度', value: amountText(value, token) }, { label: '有效期至', value: deadline(msg.deadline) })
    checks.push({ level: value >= UNLIMITED ? 'danger' : 'warn', text: `签名后，${short(String(msg.spender))} 可以不经你再次确认，直接转走最多 ${amountText(value, token)}。钓鱼网站最常用这种签名` })
  } else if (String(d.name) === 'Permit2') {
    title = 'Permit2 代币授权'
    const details = (msg.details ?? msg.permitted) as Record<string, unknown> | Record<string, unknown>[] | undefined
    const list = Array.isArray(details) ? details : details ? [details] : []
    for (const it of list) {
      const token = it.token ? await tokenOf(n, String(it.token)) : null
      fields.push({ label: '额度', value: amountText(BigInt(String(it.amount ?? 0)), token) })
    }
    if (msg.spender) fields.push({ label: '被授权方', value: String(msg.spender), mono: true })
    checks.push({ level: 'warn', text: '签名后对方可以通过 Permit2 合约转走上面列出的代币额度，请确认是你信任的协议（如 Uniswap）' })
  } else if (String(d.name) === 'Seaport') {
    title = 'NFT 挂单签名'
    checks.push({ level: 'warn', text: '这是 Seaport 挂单签名：成交后会按签名里的价格卖出你的 NFT，请核对价格' })
  } else {
    checks.push({ level: 'info', text: '结构化签名本身不花 gas，但可能被用于授权或下单，请确认网站可信' })
  }
  fields.push({ label: '原始内容', value: argText(msg), mono: true })
  return { title, fields, checks, payload: { type: 'typed', data } as Payload }
}

async function sendTx(input: DappRequestInput, me: string, n: Network) {
  const tx = ((input.params as unknown[]) ?? [])[0] as Record<string, string | undefined>
  const checks: RiskCheck[] = []
  if (!sameAddr(tx?.from, me)) checks.push({ level: 'danger', text: '交易发送地址不是本钱包地址' })
  if (!n.isTestnet && !settings().allowMainnet) checks.push({ level: 'danger', text: '主网交易未开启：在设置里打开「允许主网转账」后再试' })
  else if (!n.isTestnet) checks.push({ level: 'warn', text: `这是 ${n.name} 主网，资产真实` })

  const to = tx?.to as Hex | undefined
  const data = (tx?.data ?? tx?.input) as Hex | undefined
  const value = tx?.value ? BigInt(tx.value) : 0n
  const fields: DappField[] = []
  let title = '合约交互'
  let unknownFacts: string | null = null

  if (!to) {
    title = '部署合约'
    checks.push({ level: 'warn', text: '这笔交易会部署一个新合约' })
  } else if (!data || data === '0x') {
    title = `转账 ${n.nativeSymbol}`
    fields.push({ label: '收款', value: to, mono: true })
  } else {
    fields.push({ label: '合约', value: to, mono: true })
    try {
      const { functionName, args } = decodeFunctionData({ abi: [...erc20Abi, ...EXTRA_ABI], data })
      const token = await tokenOf(n, to)
      const a = args as readonly unknown[]
      if (functionName === 'transfer') {
        title = '转出代币'
        fields.push({ label: '收款', value: String(a[0]), mono: true }, { label: '数量', value: amountText(a[1] as bigint, token) })
      } else if (functionName === 'approve' || functionName === 'increaseAllowance') {
        title = '代币授权'
        const v = a[1] as bigint
        fields.push({ label: '被授权方', value: String(a[0]), mono: true }, { label: '额度', value: amountText(v, token) })
        checks.push(
          v >= UNLIMITED
            ? { level: 'warn', text: `无限额授权：${short(String(a[0]))} 以后可以随时转走你全部的 ${token?.symbol ?? '该代币'}。只在信任的协议上这样做` }
            : { level: 'info', text: `授权 ${short(String(a[0]))} 动用 ${amountText(v, token)}` }
        )
      } else if (functionName === 'setApprovalForAll') {
        title = 'NFT 全部授权'
        fields.push({ label: '被授权方', value: String(a[0]), mono: true }, { label: '授权', value: a[1] ? '允许转走该合约下你的全部 NFT' : '取消授权' })
        if (a[1]) checks.push({ level: 'warn', text: `${short(String(a[0]))} 将可以转走你在这个合约下的所有 NFT，常见于钓鱼` })
      } else if (functionName === 'transferFrom') {
        title = '代币转移'
        fields.push({ label: '从', value: String(a[0]), mono: true }, { label: '到', value: String(a[1]), mono: true }, { label: '数量', value: amountText(a[2] as bigint, token) })
      } else {
        fields.push({ label: '函数', value: functionName })
      }
    } catch {
      const selector = data.slice(0, 10)
      const sig = await lookupSelector(selector)
      fields.push({ label: '函数', value: sig ?? `未知（${selector}）`, mono: !sig })
      if (sig) {
        try {
          const item = parseAbiItem(`function ${sig}`)
          const { args } = decodeFunctionData({ abi: [item], data })
          ;(args ?? []).forEach((v, i) => fields.push({ label: `参数 ${i + 1}`, value: argText(v), mono: true }))
        } catch {
          // 参数解不开就只显示函数名
        }
      }
      unknownFacts = `网站：${input.dapp.name}（${hostOf(input.dapp.url)}）\n网络：${n.name}\n合约：${to}\n函数：${sig ?? selector}\n附带原生币：${formatUnits(value, n.nativeDecimals)} ${n.nativeSymbol}\n参数：${fields.filter((f) => f.label.startsWith('参数')).map((f) => f.value).join(', ') || '无法解码'}`
    }
  }
  if (value > 0n) fields.push({ label: `附带 ${n.nativeSymbol}`, value: formatUnits(value, n.nativeDecimals) })

  // 模拟 + 手续费
  const c = await publicClient(n)
  const call = { to, data: data && data !== '0x' ? data : undefined, value }
  let gas = 0n
  let simulation = { ok: true, detail: '' }
  try {
    await c.call({ account: me as Hex, ...call })
    gas = ((await c.estimateGas({ account: me as Hex, ...call })) * 120n) / 100n
    const { perGas } = await feeParams(c)
    const fee = gas * perGas
    fields.push({ label: '手续费', value: `≤ ${formatUnits(fee, n.nativeDecimals)} ${n.nativeSymbol}` })
    const bal = await c.getBalance({ address: me as Hex })
    if (bal < fee + value) checks.push({ level: 'danger', text: `${n.nativeSymbol} 余额不足以支付金额和手续费` })
    simulation.detail = `eth_call 模拟通过，预估 gas ${gas}`
  } catch (e) {
    simulation = { ok: false, detail: `模拟失败：${explainError(e, { symbol: n.nativeSymbol, decimals: n.nativeDecimals })}` }
    checks.push({ level: 'danger', text: simulation.detail })
  }

  const aiSummary = unknownFacts ? await aiExplain(unknownFacts) : undefined
  return { title, fields, checks, simulation, aiSummary, payload: { type: 'tx', network: n, call, gas } as Payload }
}

// ---------- 对外 ----------

export function chainsInfo(caips: string[]): { supported: { caip: string; name: string }[]; unsupported: string[] } {
  const known = new Set(allNetworks().filter((n) => n.family === 'evm').map((n) => `eip155:${n.chainId}`))
  const supported: { caip: string; name: string }[] = []
  const unsupported: string[] = []
  for (const caip of [...new Set(caips)]) {
    if (known.has(caip)) supported.push({ caip, name: networkOf(caip).name })
    else unsupported.push(caip)
  }
  return { supported, unsupported }
}

export async function analyze(input: DappRequestInput): Promise<DappRequestCard> {
  const me = myEvm()
  const base: DappRequestCard = {
    kind: 'dapp_request', id: randomUUID(), wcId: input.wcId, topic: input.topic, dapp: input.dapp,
    method: input.method, title: input.method, fields: [], checks: originChecks(input), status: 'ready'
  }
  let n: Network | undefined
  try {
    n = networkOf(input.chainId)
    base.network = summary(n)
  } catch (e) {
    base.checks.push({ level: 'danger', text: (e as Error).message })
  }

  let r: Awaited<ReturnType<typeof sendTx>> | Awaited<ReturnType<typeof typedSign>> | ReturnType<typeof personalSign> | null = null
  try {
    if (input.method === 'personal_sign') r = personalSign(input, me)
    else if (input.method === 'eth_sign') {
      base.title = '危险签名（eth_sign）'
      base.checks.push({ level: 'danger', text: 'eth_sign 可以签下任意交易，几乎只被钓鱼网站使用，已直接拒绝' })
    } else if (/^eth_signTypedData(_v3|_v4)?$/.test(input.method) && n) r = await typedSign(input, me, n)
    else if (input.method === 'eth_sendTransaction' && n) r = await sendTx(input, me, n)
    else if (n) base.checks.push({ level: 'danger', text: `暂不支持 ${input.method} 请求` })
  } catch (e) {
    base.checks.push({ level: 'danger', text: `无法解析请求：${shortErr(e)}` })
  }

  if (r) {
    base.title = r.title
    base.fields = r.fields
    base.checks.push(...r.checks)
    if ('simulation' in r) base.simulation = r.simulation
    if ('aiSummary' in r) base.aiSummary = r.aiSummary
  }
  if (!r || base.checks.some((c) => c.level === 'danger')) base.status = 'blocked'
  else pending.set(base.id, { card: base, payload: r.payload, at: Date.now() })
  return base
}

export async function execute(id: string): Promise<{ result: string; explorerUrl?: string }> {
  const p = pending.get(id)
  if (!p) throw new Error('这个请求已失效')
  pending.delete(id)
  if (Date.now() - p.at > TTL) throw new Error('确认超时，请在网站上重新发起')
  const s = signers()
  const account = privateKeyToAccount(s.evm.privateKey)
  const pl = p.payload

  if (pl.type === 'message') return { result: await account.signMessage({ message: pl.message }) }
  if (pl.type === 'typed') {
    const { EIP712Domain: _, ...types } = pl.data.types
    return {
      result: await account.signTypedData({
        domain: pl.data.domain, types, primaryType: pl.data.primaryType, message: pl.data.message
      } as unknown as Parameters<typeof account.signTypedData>[0])
    }
  }
  // 发送前再模拟一次，状态变了就不发
  const c = await publicClient(pl.network)
  await c.call({ account: s.evm.address, ...pl.call })
  const hash = await sendCall(pl.network, s.evm.privateKey, pl.call, pl.gas)
  return { result: hash, explorerUrl: explorerTx(pl.network, hash) }
}

export function reject(id: string): void {
  pending.delete(id)
}
