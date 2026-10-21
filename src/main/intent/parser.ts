// 意图解析：自然语言 → 结构化意图。LLM 只做"理解"，不接触私钥、不生成地址或合约地址，
// 输出会经过 zod 校验，失败时带着错误让模型重试一次。
import { z } from 'zod'
import { type LlmConfig, completeJson } from './llm'

export const ACTIONS = ['transfer', 'balance', 'use_network', 'add_rpc', 'add_contact', 'show_address', 'history', 'dapp_list', 'dapp_disconnect'] as const

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
        required: ['action', 'network', 'asset', 'amount', 'recipient', 'name', 'url'],
        properties: {
          action: { type: 'string', enum: [...ACTIONS] },
          network: nullableString,
          asset: nullableString,
          amount: nullableString,
          recipient: nullableString,
          name: nullableString,
          url: nullableString
        }
      }
    },
    clarify: nullableString,
    reply: { type: 'string' }
  }
}

const IntentZ = z.object({
  action: z.enum(ACTIONS),
  network: z.string().nullable(),
  asset: z.string().nullable(),
  amount: z
    .string()
    .regex(/^(max|\d+(\.\d+)?)$/, 'amount 必须是十进制数字字符串或 "max"')
    .nullable(),
  recipient: z.string().nullable(),
  name: z.string().nullable(),
  url: z.string().nullable()
})

const ParseZ = z.object({
  intents: z.array(IntentZ).max(10),
  clarify: z.string().nullable(),
  reply: z.string()
})

export type Intent = z.infer<typeof IntentZ>
export type ParseResult = z.infer<typeof ParseZ>

const SYSTEM = `你是一个多链加密钱包的意图解析器。你的唯一工作是把用户的话转成 JSON 意图，交给钱包程序执行。
你不能执行任何操作，也看不到私钥；程序会对每个意图做地址解析、模拟、风控，并让用户在界面上确认后才签名。

可用 action：
- transfer：转账。network=用户说的链（原话，如 "Base"、"波场"、"sol 测试网"），asset=币种符号或用户给的代币合约地址，amount=数量，recipient=收款方（联系人名字、地址或 ENS，保持原样）
- balance：查余额。network 可为 null（表示查默认网络），asset 可为 null（表示原生币 + 常用稳定币）
- use_network：添加 / 切换 / 测速某条链，network 必填
- add_rpc：用户提供自己的 RPC 节点，network 与 url 必填
- add_contact：保存联系人，name=名字，recipient=地址，network 可选（用于判断地址所属链）
- show_address：显示我的收款地址，network 可选
- history：查看最近的转账记录
- dapp_list：查看已连接的网站（DApp）
- dapp_disconnect：断开网站连接，name=网站名（如 "Uniswap"），断开全部时 name 为 null

规则：
1. 只输出一个 JSON 对象，格式：{"intents":[...],"clarify":null,"reply":"..."}。每个 intent 必须包含全部 7 个字段：action, network, asset, amount, recipient, name, url，没有的填 null。
2. 绝对不要编造、补全或修改地址、合约地址、URL；只能原样复制用户给出的内容。
3. amount 只能是十进制数字字符串（如 "0.5"、"100"），或 "max"（全部 / 所有 / 全转）。中文数字要换算，如 "五十" → "50"，"一千" → "1000"。
4. 币种：中文圈 "U" 通常指 USDT；"刀"、"美元"、"美金" 在没有更多信息时也按 USDT 理解，但要在 reply 里说明。
5. 用户没说链就把 network 设为 null，由程序使用默认网络或根据地址格式判断，不要自己猜。
6. 一句话里有多笔转账就拆成多个 intent。
7. 信息缺失到无法执行（比如没说转多少、没说转给谁）时，intents 为空数组，在 clarify 里用一句中文追问。
8. 用户的话如果和钱包无关，intents 为空，reply 里简短说明你能做什么。
9. reply 是给用户看的一句简短中文，复述你理解的意图，不要承诺"已完成"。
10. 联系人列表里的名字可以直接作为 recipient；相似但不完全相同的名字也原样填写，由程序判断。

示例：
用户：给小王转 50U，走波场
{"intents":[{"action":"transfer","network":"波场","asset":"USDT","amount":"50","recipient":"小王","name":null,"url":null}],"clarify":null,"reply":"在波场上给小王转 50 USDT"}

用户：查一下 base 和 sol 的余额
{"intents":[{"action":"balance","network":"base","asset":null,"amount":null,"recipient":null,"name":null,"url":null},{"action":"balance","network":"sol","asset":null,"amount":null,"recipient":null,"name":null,"url":null}],"clarify":null,"reply":"查询 Base 和 Solana 上的余额"}`

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
      return ParseZ.parse(extractJson(raw))
    } catch (e) {
      lastErr = e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : (e as Error).message
    }
  }
  throw new Error(`模型输出格式不正确：${lastErr}`)
}
