// LLM 双协议适配：Anthropic Messages API 与 OpenAI Chat Completions API。
// 官方端点用严格结构化输出；兼容端点（如 DeepSeek）用 JSON 模式 + 本地 zod 校验兜底。
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type { LlmProtocol } from '../../shared/types'
import { proxyStatus } from '../proxy'

export interface LlmConfig {
  protocol: LlmProtocol
  baseURL: string
  model: string
  apiKey: string
}

const TIMEOUT_MS = 60_000

function host(baseURL: string): string {
  return new URL(baseURL).hostname
}

// 支持 effort / 服务端 fallbacks 的 Claude 新一代模型
function isModernClaude(model: string): boolean {
  return /^claude-(opus-5|sonnet-5-5|fable-5)/.test(model)
}

async function anthropicJson(cfg: LlmConfig, system: string, user: string, schema: Record<string, unknown>): Promise<string> {
  const client = new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseURL, timeout: TIMEOUT_MS })
  const official = host(cfg.baseURL) === 'api.anthropic.com'
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: user }]

  if (official && isModernClaude(cfg.model)) {
    const res = await client.beta.messages.create({
      model: cfg.model,
      max_tokens: 4096,
      system,
      messages,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema } }
    })
    if (res.stop_reason === 'refusal') throw new Error('模型拒绝了这条请求')
    return res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
  }

  const res = await client.messages.create({ model: cfg.model, max_tokens: 2048, system, messages })
  if (res.stop_reason === 'refusal') throw new Error('模型拒绝了这条请求')
  return res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
}

async function openaiJson(cfg: LlmConfig, system: string, user: string, schema: Record<string, unknown>): Promise<string> {
  const client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL, timeout: TIMEOUT_MS })
  const official = host(cfg.baseURL) === 'api.openai.com'
  const res = await client.chat.completions.create({
    model: cfg.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    response_format: official
      ? { type: 'json_schema', json_schema: { name: 'wallet_intents', strict: true, schema } }
      : { type: 'json_object' }
  })
  const msg = res.choices[0]?.message
  if (msg?.refusal) throw new Error(`模型拒绝了这条请求：${msg.refusal}`)
  return msg?.content ?? ''
}

export function completeJson(cfg: LlmConfig, system: string, user: string, schema: Record<string, unknown>): Promise<string> {
  return cfg.protocol === 'anthropic' ? anthropicJson(cfg, system, user, schema) : openaiJson(cfg, system, user, schema)
}

// 用于设置界面的模型下拉建议；兼容端点不支持时返回空列表
export async function listModels(cfg: LlmConfig): Promise<string[]> {
  const ids: string[] = []
  if (cfg.protocol === 'anthropic') {
    const client = new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseURL, timeout: 15_000 })
    for await (const m of client.models.list()) if (ids.push(m.id) >= 50) break
  } else {
    const client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL, timeout: 15_000 })
    for await (const m of client.models.list()) if (ids.push(m.id) >= 200) break
  }
  return ids
}

// 发一个最小请求验证 key / 地址 / 模型都可用
export async function testLlm(cfg: LlmConfig): Promise<{ ok: boolean; detail: string }> {
  try {
    const t0 = Date.now()
    const out = await completeJson(cfg, '只输出 JSON。', '输出 {"ok":true}', {
      type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } }
    })
    const ok = /"ok"\s*:\s*true/.test(out)
    return { ok, detail: ok ? `连接成功，响应 ${Date.now() - t0}ms` : `模型返回了意外内容：${out.slice(0, 80)}` }
  } catch (e) {
    return { ok: false, detail: describeLlmError(e, cfg.baseURL) }
  }
}

const NEEDS_PROXY = ['api.anthropic.com', 'api.openai.com']

export function describeLlmError(e: unknown, baseURL?: string): string {
  const blocked = baseURL && NEEDS_PROXY.includes(host(baseURL)) && !proxyStatus()
  if (blocked && (e instanceof Anthropic.APIConnectionError || e instanceof OpenAI.APIConnectionError)) {
    return '连不上模型接口：Claude / OpenAI 官方接口在国内需要开代理。当前没有检测到可用代理，可以打开代理，或换成 DeepSeek'
  }
  if (e instanceof Anthropic.AuthenticationError || e instanceof OpenAI.AuthenticationError) return 'API Key 无效'
  if (e instanceof Anthropic.NotFoundError || e instanceof OpenAI.NotFoundError) return '接口地址或模型名不存在'
  if (e instanceof Anthropic.RateLimitError || e instanceof OpenAI.RateLimitError) return '请求太频繁，稍后再试'
  if (e instanceof Anthropic.APIConnectionError || e instanceof OpenAI.APIConnectionError) return '连不上模型接口，检查网络或接口地址'
  if (e instanceof Anthropic.APIError || e instanceof OpenAI.APIError) return `模型接口报错 ${e.status ?? ''}：${e.message}`.slice(0, 200)
  return e instanceof Error ? e.message : String(e)
}
