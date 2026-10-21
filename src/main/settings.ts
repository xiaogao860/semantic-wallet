// 应用设置。LLM API Key 按接口域名分别保存，用系统钥匙串（Electron safeStorage）加密后落盘。
import { safeStorage } from 'electron'
import type { AppSettingsView, LlmProtocol, LlmSettingsInput, UiMode } from '../shared/types'
import type { LlmConfig } from './intent/llm'
import { readJson, writeJson } from './store'

const FILE = 'settings.json'

interface StoredSettings {
  uiMode: UiMode
  llm: { protocol: LlmProtocol; baseURL: string; model: string; apiKeyEnc?: string }
  apiKeys: Record<string, string> // 接口域名 → 加密后的 key
  defaultNetwork: string
  allowMainnet: boolean
  stableLimit: number // 主网稳定币单笔上限，超出直接拦截
}

const DEFAULTS: StoredSettings = {
  uiMode: 'compact',
  // 测试默认走 DeepSeek V4.1 Flash 的 Anthropic 兼容接口
  llm: { protocol: 'anthropic', baseURL: 'https://api.deepseek.com/anthropic', model: 'deepseek-flash' },
  apiKeys: {},
  defaultNetwork: 'evm:84532',
  allowMainnet: false,
  stableLimit: 1000
}

let current: StoredSettings = DEFAULTS

function hostOf(baseURL: string): string {
  return new URL(baseURL).host
}

export function loadSettings(): void {
  const s = readJson<Partial<StoredSettings>>(FILE, {})
  current = { ...DEFAULTS, ...s, llm: { ...DEFAULTS.llm, ...s.llm }, apiKeys: { ...s.apiKeys } }
  // 旧版本只存了一个 key，迁移到当前接口域名下
  const { apiKeyEnc, ...llm } = current.llm
  if (apiKeyEnc) {
    current.apiKeys[hostOf(llm.baseURL)] ??= apiKeyEnc
    current.llm = llm
  }
}

export function settings(): StoredSettings {
  return current
}

export function view(): AppSettingsView {
  const { protocol, baseURL, model } = current.llm
  return {
    uiMode: current.uiMode,
    llm: { protocol, baseURL, model, hasKey: !!current.apiKeys[hostOf(baseURL)] || !!envKey(protocol) },
    savedKeyHosts: Object.keys(current.apiKeys),
    defaultNetwork: current.defaultNetwork,
    allowMainnet: current.allowMainnet,
    stableLimit: current.stableLimit
  }
}

function envKey(p: LlmProtocol): string | undefined {
  return p === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY
}

function validate(input: LlmSettingsInput, requireModel = true): void {
  const url = new URL(input.baseURL)
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('LLM 接口地址必须是 https')
  }
  if (requireModel && !input.model.trim()) throw new Error('请选择模型')
}

// 把界面上的输入变成可调用的配置：没填新 key 时用该接口域名下已保存的 key
export async function resolveLlm(input: LlmSettingsInput, requireModel = true): Promise<LlmConfig> {
  validate(input, requireModel)
  const baseURL = input.baseURL.replace(/\/$/, '')
  const stored = current.apiKeys[hostOf(baseURL)]
  const apiKey =
    input.apiKey?.trim() ||
    (stored ? (await safeStorage.decryptStringAsync(Buffer.from(stored, 'base64'))).result : envKey(input.protocol))
  if (!apiKey) throw new Error('请粘贴 API Key')
  return { protocol: input.protocol, baseURL, model: input.model.trim(), apiKey }
}

export async function llmConfig(): Promise<LlmConfig> {
  try {
    return await resolveLlm(current.llm)
  } catch {
    throw new Error('还没有配置 LLM API Key，请在左下角「模型设置」里粘贴')
  }
}

export async function setLlm(input: LlmSettingsInput): Promise<void> {
  validate(input)
  const baseURL = input.baseURL.replace(/\/$/, '')
  const apiKeys = { ...current.apiKeys }
  if (input.apiKey?.trim()) {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error('系统钥匙串不可用，无法安全保存 API Key')
    apiKeys[hostOf(baseURL)] = (await safeStorage.encryptStringAsync(input.apiKey.trim())).toString('base64')
  }
  current = { ...current, apiKeys, llm: { protocol: input.protocol, baseURL, model: input.model.trim() } }
  writeJson(FILE, current)
}

export function setPrefs(p: Partial<Pick<StoredSettings, 'uiMode' | 'defaultNetwork' | 'allowMainnet' | 'stableLimit'>>): void {
  current = { ...current, ...p }
  writeJson(FILE, current)
}
