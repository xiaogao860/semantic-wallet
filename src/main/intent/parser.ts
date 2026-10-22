// 意图解析：自然语言 → 结构化意图。LLM 只做"理解"，不接触私钥、不生成地址或合约地址，
// 输出会经过 zod 校验，失败时带着错误让模型重试一次。
import { z } from 'zod'
import { type LlmConfig, completeJson } from './llm'

export const ACTIONS = [
  'transfer', 'swap', 'bridge', 'sweep', 'buy', 'sell', 'price', 'token_check', 'orders', 'cancel_order',
  'balance', 'use_network', 'add_rpc', 'add_contact', 'show_address', 'history', 'dapp_list', 'dapp_disconnect'
] as const

const FIELDS = ['network', 'asset', 'amount', 'recipient', 'name', 'url', 'to_network', 'to_asset', 'amount_unit', 'price', 'dex'] as const

const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] }

export const INTENT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['intents', 'clarify', 'reply'],
  properties: {
    intents: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['action', ...FIELDS],
        properties: {
          action: { type: 'string', enum: [...ACTIONS] },
          ...Object.fromEntries(FIELDS.map((f) => [f, nullableString])),
          amount_unit: { anyOf: [{ type: 'string', enum: ['token', 'pay', 'usd', 'percent'] }, { type: 'null' }] }
        }
      }
    },
    clarify: nullableString,
    reply: { type: 'string' }
  }
}

const num = /^\d+(\.\d+)?$/
const IntentZ = z.object({
  action: z.enum(ACTIONS),
  network: z.string().nullable(),
  asset: z.string().nullable(),
  amount: z.string().regex(/^(max|\d+(\.\d+)?)$/, 'amount 必须是十进制数字字符串或 "max"').nullable(),
  recipient: z.string().nullable(),
  name: z.string().nullable(),
  url: z.string().nullable(),
  to_network: z.string().nullable(),
  to_asset: z.string().nullable(),
  amount_unit: z.enum(['token', 'pay', 'usd', 'percent']).nullable(),
  price: z.string().regex(num, 'price 必须是十进制数字字符串').nullable(),
  dex: z.string().nullable()
})

const ParseZ = z.object({
  intents: z.array(IntentZ).max(10),
  clarify: z.string().nullable(),
  reply: z.string()
})

export type Intent = z.infer<typeof IntentZ>
export type ParseResult = z.infer<typeof ParseZ>

// 模型偶尔会漏字段：先补 null 再校验
function withDefaults(raw: unknown): unknown {
  const r = raw as { intents?: Record<string, unknown>[] }
  if (r && Array.isArray(r.intents)) {
    r.intents = r.intents.map((i) => ({ ...Object.fromEntries(FIELDS.map((f) => [f, null])), ...i }))
  }
  return r
}

// 示例里只写有值的字段，其余自动补 null，保证示例和格式要求一致
function ex(user: string, intents: Partial<Record<'action' | (typeof FIELDS)[number], string>>[], reply: string, clarify: string | null = null): string {
  const full = intents.map((i) => ({ action: i.action, ...Object.fromEntries(FIELDS.map((f) => [f, i[f] ?? null])) }))
  return `用户：${user}\n${JSON.stringify({ intents: full, clarify, reply })}`
}

const SYSTEM = `你是一个多链加密钱包的意图解析器。你的唯一工作是把用户的话转成 JSON 意图，交给钱包程序执行。
你不能执行任何操作，也看不到私钥；程序会对每个意图做地址解析、模拟、风控，并让用户在界面上确认后才签名。

可用 action：
- transfer：转账。network=用户说的链（原话，如 "Base"、"波场"、"sol 测试网"），asset=币种符号或用户给的代币合约地址，amount=数量，recipient=收款方（联系人名字、地址或 ENS，保持原样）
- swap：同一条链上把一种币换成另一种（用户同时说清了卖什么、换成什么）。network=链，asset=卖出的币，amount=卖出数量，to_asset=换成的币，dex=指定的交易所（没说就 null）
- buy：买入某个币（"买 100U 的 ETH""买 0.1 ETH""在 Uniswap 上买 PEPE"）。asset=要买的币（符号、名字或合约地址），amount+amount_unit：按美元金额用 usd，要买到多少个用 token，"用 X 个某币去买"用 pay（数量指付出的币），按余额比例用 percent；to_asset=用什么币付（没说就 null，程序自动选稳定币），dex=指定交易所，price=限价（"跌到 3000 再买"），没有就 null
- sell：卖出某个币（"卖掉一半 SOL""把 PEPE 全卖了""ETH 涨到 4000 卖 0.5 个"）。asset=要卖的币，amount+amount_unit（全部用 amount="max"），to_asset=换成什么（没说就 null，表示 USDC），dex、price 同上
- price：查价格（"ETH 现在多少钱"）。asset=币，network 可选
- token_check：检查代币安全（"PEPE 安全吗""查一下这个合约 0x..."）。asset=币名或合约地址，network 可选
- orders：查看挂着的限价单
- cancel_order：撤销限价单，asset=哪个币的单（全部撤销时为 null）
- bridge：跨链。network=从哪条链，to_network=到哪条链（必填），asset=转出的币，amount=数量，to_asset=到账的币（没说就 null，表示同一种币）
- sweep：把多种资产一次性全部换成某个币（"把我的资产全部换成 USDC"）。to_asset=目标币，network=只扫某条链时填，to_network=要集中到某条链时填。程序会自己查余额，不需要追问币种
- balance：查余额。network 可为 null（查默认网络），asset 可为 null（原生币 + 常用稳定币）
- use_network：添加 / 切换 / 测速某条链，network 必填
- add_rpc：用户提供自己的 RPC 节点，network 与 url 必填
- add_contact：保存联系人，name=名字，recipient=地址，network 可选
- show_address：显示我的收款地址，network 可选
- history：查看最近的转账记录
- dapp_list：查看已连接的网站（DApp）
- dapp_disconnect：断开网站连接，name=网站名，断开全部时 name 为 null

规则：
1. 只输出一个 JSON 对象，格式：{"intents":[...],"clarify":null,"reply":"..."}。每个 intent 必须包含全部字段：action, ${FIELDS.join(', ')}，没有的填 null。
2. 绝对不要编造、补全或修改地址、合约地址、URL；只能原样复制用户给出的内容。
3. amount 只能是十进制数字字符串（如 "0.5"、"100"），或 "max"（全部 / 所有）。中文数字要换算，"一半" → amount "50" + amount_unit "percent"。price 也只能是数字字符串。
4. 币种：中文圈 "U" 通常指 USDT；但 "100U 的 ETH" 这种说金额的，用 amount "100" + amount_unit "usd"，to_asset 为 null。
5. 用户没说链就把 network 设为 null，由程序判断，不要自己猜。
6. 一句话里有多笔操作就拆成多个 intent。
7. 信息缺失到无法执行（比如没说转多少、没说转给谁）时，intents 为空数组，在 clarify 里用一句中文追问。"全部""所有""一半"不算缺失。
8. 用户的话如果和钱包无关，intents 为空，reply 里简短说明你能做什么。
9. reply 是给用户看的一句简短中文，复述你理解的意图，不要承诺"已完成"。
10. 联系人列表里的名字可以直接作为 recipient；相似但不完全相同的名字也原样填写，由程序判断。

示例：
${[
  ex('给小王转 50U，走波场', [{ action: 'transfer', network: '波场', asset: 'USDT', amount: '50', recipient: '小王' }], '在波场上给小王转 50 USDT'),
  ex('买 100U 的 ETH', [{ action: 'buy', asset: 'ETH', amount: '100', amount_unit: 'usd' }], '用 100 美元的稳定币买入 ETH'),
  ex('在 Uniswap 上用 0.05 ETH 买 PEPE', [{ action: 'buy', asset: 'PEPE', amount: '0.05', amount_unit: 'pay', to_asset: 'ETH', dex: 'Uniswap' }], '在 Uniswap 上用 0.05 ETH 买入 PEPE'),
  ex('买 0.1 个 ETH', [{ action: 'buy', asset: 'ETH', amount: '0.1', amount_unit: 'token' }], '买入 0.1 ETH'),
  ex('卖掉一半 SOL', [{ action: 'sell', asset: 'SOL', amount: '50', amount_unit: 'percent' }], '卖出一半 SOL 换成 USDC'),
  ex('ETH 跌到 3000 的时候用 500U 买入', [{ action: 'buy', asset: 'ETH', amount: '500', amount_unit: 'usd', price: '3000' }], '挂限价单：ETH 跌到 3000 时用 500 美元买入'),
  ex('PEPE 安全吗', [{ action: 'token_check', asset: 'PEPE' }], '检查 PEPE 的合约安全'),
  ex('把我的资产全部转成 USDC', [{ action: 'sweep', to_asset: 'USDC' }], '把各条链上的资产全部兑换成 USDC，我先列出每一笔给你确认'),
  ex('把 Arbitrum 上的 USDC 全部跨到 Solana', [{ action: 'bridge', network: 'Arbitrum', asset: 'USDC', amount: 'max', to_network: 'Solana' }], '把 Arbitrum 上的全部 USDC 跨链到 Solana'),
  ex('查一下 base 和 sol 的余额', [{ action: 'balance', network: 'base' }, { action: 'balance', network: 'sol' }], '查询 Base 和 Solana 上的余额')
].join('\n\n')}`

export interface ParseContext {
  defaultNetwork: string
  contacts: string[]
  recent: { user: string; reply: string }[]
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenced ? fenced[1] : text
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型没有返回 JSON')
  return JSON.parse(body.slice(start, end + 1))
}

function buildUser(text: string, ctx: ParseContext, repair?: string): string {
  const recent = ctx.recent.slice(-4).map((r) => `用户：${r.user}\n助手：${r.reply}`).join('\n')
  return [
    '<context>',
    `默认网络：${ctx.defaultNetwork}`,
    `联系人：${ctx.contacts.length ? ctx.contacts.join('、') : '（无）'}`,
    recent ? `最近对话：\n${recent}` : '',
    '</context>',
    `<user_message>${text}</user_message>`,
    repair ? `\n上一次输出无法解析：${repair}\n请严格按格式重新输出完整 JSON。` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

export async function parseIntent(cfg: LlmConfig, text: string, ctx: ParseContext): Promise<ParseResult> {
  let lastErr = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await completeJson(cfg, SYSTEM, buildUser(text, ctx, attempt ? lastErr : undefined), INTENT_JSON_SCHEMA)
    try {
      return ParseZ.parse(withDefaults(extractJson(raw)))
    } catch (e) {
      lastErr = e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : (e as Error).message
    }
  }
  throw new Error(`模型输出格式不正确：${lastErr}`)
}
