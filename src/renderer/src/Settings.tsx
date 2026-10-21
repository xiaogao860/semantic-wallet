import { useEffect, useRef, useState } from 'react'
import type { AppSettingsView, LlmProtocol, LlmSettingsInput } from '../../shared/types'
import { type FeaturedNetwork, api } from './api'

type ProviderId = 'deepseek' | 'claude' | 'openai' | 'custom'

interface Provider {
  id: ProviderId
  name: string
  note: string
  keyUrl?: string
  keyHint: string
  protocol: LlmProtocol
  baseURL: string
  model: string
}

const PROVIDERS: Provider[] = [
  {
    id: 'deepseek', name: 'DeepSeek', note: 'V4.1 Flash · 推荐', keyHint: 'sk-…',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    protocol: 'anthropic', baseURL: 'https://api.deepseek.com/anthropic', model: 'deepseek-flash'
  },
  {
    id: 'claude', name: 'Claude', note: '官方接口', keyHint: 'sk-ant-…',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    protocol: 'anthropic', baseURL: 'https://api.anthropic.com', model: 'claude-opus-5-5'
  },
  {
    id: 'openai', name: 'OpenAI', note: '官方接口', keyHint: 'sk-proj-…',
    keyUrl: 'https://platform.openai.com/api-keys',
    protocol: 'openai', baseURL: 'https://api.openai.com/v1', model: ''
  },
  { id: 'custom', name: '自定义', note: '任意兼容接口', keyHint: 'API Key', protocol: 'openai', baseURL: '', model: '' }
]

// DeepSeek 两种协议格式对应的地址
const DEEPSEEK_URL: Record<LlmProtocol, string> = {
  anthropic: 'https://api.deepseek.com/anthropic',
  openai: 'https://api.deepseek.com'
}

function providerOf(baseURL: string): ProviderId {
  try {
    const host = new URL(baseURL).host
    if (host === 'api.deepseek.com') return 'deepseek'
    if (host === 'api.anthropic.com') return 'claude'
    if (host === 'api.openai.com') return 'openai'
  } catch {
    // 地址为空或格式不对
  }
  return 'custom'
}

// 按 key 前缀识别服务商
function detect(key: string): ProviderId | undefined {
  const k = key.trim()
  if (/^sk-ant-/.test(k)) return 'claude'
  if (/^sk-(proj|svcacct|admin)-/.test(k)) return 'openai'
  if (/^sk-[0-9a-f]{32}$/.test(k)) return 'deepseek'
  return undefined
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

type Status = { state: 'idle' | 'testing' | 'ok' | 'error' | 'pick'; text: string }

export default function Settings({ initial, networks, onClose }: { initial: AppSettingsView; networks: FeaturedNetwork[]; onClose: () => void }) {
  const [view, setView] = useState(initial)
  const [provider, setProvider] = useState<ProviderId>(providerOf(initial.llm.baseURL))
  const [protocol, setProtocol] = useState<LlmProtocol>(initial.llm.protocol)
  const [baseURL, setBaseURL] = useState(initial.llm.baseURL)
  const [model, setModel] = useState(initial.llm.model)
  const [key, setKey] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [status, setStatus] = useState<Status>(
    initial.llm.hasKey ? { state: 'ok', text: `已连接 ${PROVIDERS.find((p) => p.id === providerOf(initial.llm.baseURL))!.name} · ${initial.llm.model}` } : { state: 'idle', text: '' }
  )
  const [advanced, setAdvanced] = useState(providerOf(initial.llm.baseURL) === 'custom')
  const keyInput = useRef<HTMLInputElement>(null)
  // 连续粘贴 / 切换时只认最后一次请求的结果
  const reqId = useRef(0)

  const meta = PROVIDERS.find((p) => p.id === provider)!
  const hasSavedKey = (url: string) => view.savedKeyHosts.includes(hostOf(url))

  useEffect(() => {
    keyInput.current?.focus()
  }, [])

  const connect = async (input: LlmSettingsInput) => {
    const id = ++reqId.current
    const stale = () => id !== reqId.current
    if (!input.baseURL) {
      setAdvanced(true)
      return setStatus({ state: 'error', text: '请在「高级」里填写接口地址' })
    }
    if (!input.model) {
      // 没有默认模型的服务商：先拉模型列表让用户选
      setStatus({ state: 'testing', text: '正在获取模型列表…' })
      const { models: list, error } = await api.listModels(input).catch((e: Error) => ({ models: [], error: e.message }))
      if (stale()) return
      setModels(list)
      if (error) return setStatus({ state: 'error', text: error })
      setAdvanced(true)
      return setStatus({ state: 'pick', text: list.length ? '选一个模型后会自动连接' : '请在「高级」里填写模型名' })
    }
    setStatus({ state: 'testing', text: '正在连接…' })
    try {
      const r = await api.connectLlm(input)
      if (stale()) return
      setView(r.settings)
      if (r.ok) {
        setKey('')
        setStatus({ state: 'ok', text: `已连接 ${PROVIDERS.find((p) => p.id === providerOf(input.baseURL))!.name} · ${input.model}，${r.detail}` })
        void api
          .listModels({ ...input, apiKey: undefined })
          .then((r) => !stale() && setModels(r.models))
          .catch(() => undefined)
      } else {
        setStatus({ state: 'error', text: r.detail })
      }
    } catch (e) {
      if (!stale()) setStatus({ state: 'error', text: (e as Error).message })
    }
  }

  const current = (over: Partial<LlmSettingsInput> = {}): LlmSettingsInput => ({ protocol, baseURL, model, apiKey: key || undefined, ...over })

  // 选服务商：填好地址和模型；该服务商已有保存的 key 就直接连上
  const choose = (p: Provider, keyOverride?: string) => {
    reqId.current++
    setProvider(p.id)
    setModels([])
    if (p.id === 'custom') {
      setAdvanced(true)
      setStatus({ state: 'idle', text: '' })
      return
    }
    setProtocol(p.protocol)
    setBaseURL(p.baseURL)
    setModel(p.model)
    const input = { protocol: p.protocol, baseURL: p.baseURL, model: p.model, apiKey: keyOverride }
    if (keyOverride || hasSavedKey(p.baseURL)) void connect(input)
    else {
      setStatus({ state: 'idle', text: '' })
      keyInput.current?.focus()
    }
  }

  // 粘贴即连接：识别出别家的 key 会自动切换服务商
  const onPaste = (text: string) => {
    const k = text.trim()
    if (!k) return
    setKey(k)
    const found = detect(k)
    if (found && found !== provider) return choose(PROVIDERS.find((p) => p.id === found)!, k)
    void connect(current({ apiKey: k }))
  }

  const setDeepseekFormat = (p: LlmProtocol) => {
    setProtocol(p)
    setBaseURL(DEEPSEEK_URL[p])
    if (hasSavedKey(DEEPSEEK_URL[p])) void connect(current({ protocol: p, baseURL: DEEPSEEK_URL[p] }))
  }

  const savePref = async (p: Parameters<typeof api.setPrefs>[0]) => setView(await api.setPrefs(p))

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>模型</h2>
        <div className="providers">
          {PROVIDERS.map((p) => {
            const active = p.id === provider
            const saved = p.id !== 'custom' && (p.id === 'deepseek' ? hasSavedKey(DEEPSEEK_URL.anthropic) || hasSavedKey(DEEPSEEK_URL.openai) : hasSavedKey(p.baseURL))
            return (
              <button key={p.id} className={`provider ${active ? 'active' : ''}`} onClick={() => choose(p)}>
                <b>{p.name}</b>
                <span className="small muted">{p.note}</span>
                {saved && <span className="saved">已保存 Key</span>}
              </button>
            )
          })}
        </div>

        <div className="keyrow">
          <input
            ref={keyInput}
            type="password"
            className="keyinput"
            value={key}
            placeholder={hasSavedKey(baseURL) ? `已保存 ${meta.name} Key，粘贴新的可替换` : `粘贴 ${meta.name} API Key（${meta.keyHint}），自动识别并连接`}
            onChange={(e) => setKey(e.target.value)}
            onPaste={(e) => {
              e.preventDefault()
              onPaste(e.clipboardData.getData('text'))
            }}
            onKeyDown={(e) => e.key === 'Enter' && void connect(current())}
          />
          <button className="primary" disabled={status.state === 'testing'} onClick={() => void connect(current())}>
            {status.state === 'testing' ? '连接中…' : '连接'}
          </button>
        </div>
        <div className="keymeta">
          {status.text ? (
            <span className={`connstatus ${status.state}`}>
              {status.state === 'ok' ? '✓ ' : status.state === 'error' ? '✕ ' : ''}
              {status.text}
            </span>
          ) : (
            <span className="muted small">Key 用系统钥匙串加密保存在本机，只发给你选的接口</span>
          )}
          {meta.keyUrl && (
            <a href={meta.keyUrl} target="_blank" rel="noreferrer" className="small">
              获取 Key →
            </a>
          )}
        </div>

        <button className="ghost disclosure" onClick={() => setAdvanced(!advanced)}>
          {advanced ? '▾' : '▸'} 高级
        </button>
        {advanced && (
          <div className="advanced">
            {provider === 'deepseek' ? (
              <label>
                接口格式
                <div className="seg">
                  {(['anthropic', 'openai'] as const).map((p) => (
                    <button key={p} className={protocol === p ? 'active' : ''} onClick={() => setDeepseekFormat(p)}>
                      {p === 'anthropic' ? 'Anthropic 格式' : 'OpenAI 格式'}
                    </button>
                  ))}
                </div>
              </label>
            ) : (
              <label>
                协议
                <select value={protocol} onChange={(e) => setProtocol(e.target.value as LlmProtocol)}>
                  <option value="anthropic">Anthropic Messages API</option>
                  <option value="openai">OpenAI Chat Completions API</option>
                </select>
              </label>
            )}
            <label>
              接口地址
              <input value={baseURL} placeholder="https://…" onChange={(e) => setBaseURL(e.target.value)} />
            </label>
            <label>
              模型
              {models.length > 0 ? (
                <select
                  value={models.includes(model) ? model : ''}
                  onChange={(e) => {
                    setModel(e.target.value)
                    if (e.target.value) void connect(current({ model: e.target.value }))
                  }}
                >
                  {!models.includes(model) && <option value="">{model || '选择模型'}</option>}
                  {models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              ) : (
                <input value={model} placeholder="模型 ID" onChange={(e) => setModel(e.target.value)} />
              )}
            </label>
          </div>
        )}

        <h2>连接网站</h2>
        <label>
          WalletConnect 项目 ID
          <input
            defaultValue={view.wcProjectId}
            placeholder="在 cloud.reown.com 免费创建项目后获得"
            onBlur={(e) => void savePref({ wcProjectId: e.target.value.trim() })}
          />
        </label>
        <a href="https://cloud.reown.com" target="_blank" rel="noreferrer" className="small">
          获取项目 ID →
        </a>

        <h2>安全</h2>
        <label>
          默认网络
          <select value={view.defaultNetwork} onChange={(e) => void savePref({ defaultNetwork: e.target.value })}>
            {networks.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={view.allowMainnet} onChange={(e) => void savePref({ allowMainnet: e.target.checked })} />
          允许主网转账（关闭时主网只能查询）
        </label>
        <label>
          主网稳定币单笔上限
          <input
            defaultValue={String(view.stableLimit)}
            onBlur={(e) => void savePref({ stableLimit: Number(e.target.value.replace(/[^\d]/g, '')) || 1000 })}
          />
        </label>

        <div className="row">
          <button className="primary" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>
  )
}
