import { useEffect, useState } from 'react'
import type { AppSettingsView, WalletStatus } from '../../shared/types'
import { type FeaturedNetwork, api } from './api'
import Settings from './Settings'

function short(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

function Address({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className="addr"
      title={value}
      onClick={() => {
        void navigator.clipboard.writeText(value)
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      }}
    >
      <span className="addr-label">{label}</span>
      <span className="mono">{copied ? '已复制' : short(value)}</span>
    </button>
  )
}

export default function Sidebar({ status, onLock, onCompact }: { status: WalletStatus; onLock: () => void; onCompact: () => void }) {
  const [nets, setNets] = useState<FeaturedNetwork[]>([])
  const [count, setCount] = useState(0)
  const [settings, setSettings] = useState<AppSettingsView | null>(null)
  const [probing, setProbing] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)

  const refresh = () => {
    void api.featured().then(setNets)
    void api.settings().then(setSettings)
  }

  useEffect(() => {
    refresh()
    void api.networkCount().then(setCount)
    const t = setInterval(refresh, 5000)
    return () => clearInterval(t)
  }, [])

  const doProbe = async (id: string) => {
    setProbing(id)
    try {
      await api.probe(id)
    } finally {
      setProbing(null)
      refresh()
    }
  }

  const a = status.addresses!
  return (
    <aside className="sidebar">
      <div className="brand">语义钱包</div>

      <section>
        <h3>我的地址</h3>
        <Address label="EVM" value={a.evm} />
        <Address label="Solana" value={a.solana} />
        <Address label="Tron" value={a.tron} />
      </section>

      <section className="grow">
        <h3>
          网络 <span className="muted small">已接入 {count} 条</span>
        </h3>
        {nets.map((n) => {
          const best = n.state?.ranked.find((r) => r.ok)
          const isDefault = settings?.defaultNetwork === n.id
          return (
            <div key={n.id} className={`net ${isDefault ? 'active' : ''}`}>
              <button className="net-name" title="设为默认网络" onClick={() => void api.setPrefs({ defaultNetwork: n.id }).then(setSettings)}>
                <span className={`dot ${n.state ? (n.state.selected.length ? 'ok' : 'bad') : ''}`} />
                <span className="label">{n.name}</span>
                {n.isTestnet && <span className="tag">测试网</span>}
              </button>
              <button className="net-probe" disabled={probing === n.id} onClick={() => void doProbe(n.id)} title="重新测速">
                {probing === n.id ? '…' : best ? `${best.latencyMs}ms` : '测速'}
              </button>
            </div>
          )
        })}
      </section>

      <section>
        <button
          className="ghost"
          onClick={async () => {
            // 打开前取最新设置，避免对话里刚切换的默认网络被旧值覆盖
            setSettings(await api.settings())
            setNets(await api.featured())
            setShowSettings(true)
          }}
        >
          模型设置 {settings && !settings.llm.hasKey && <span className="tag warn">未配置</span>}
        </button>
        <button className="ghost" onClick={onCompact}>切换到小窗模式</button>
        <button className="ghost" onClick={onLock}>锁定钱包</button>
      </section>

      {showSettings && settings && (
        <Settings
          initial={settings}
          networks={nets}
          onClose={() => {
            setShowSettings(false)
            refresh()
          }}
        />
      )}
    </aside>
  )
}
