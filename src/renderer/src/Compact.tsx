import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppSettingsView, BalanceCard, WalletStatus } from '../../shared/types'
import { type FeaturedNetwork, api } from './api'
import Chat from './Chat'
import { DappPanel } from './DappCards'
import Settings from './Settings'
import { wc } from './walletconnect'

function short(a: string): string {
  return `${a.slice(0, 5)}…${a.slice(-4)}`
}

export default function Compact({ status, onLock, onExpand }: { status: WalletStatus; onLock: () => void; onExpand: () => void }) {
  const [settings, setSettings] = useState<AppSettingsView | null>(null)
  const [nets, setNets] = useState<FeaturedNetwork[]>([])
  const [balances, setBalances] = useState<BalanceCard | null>(null)
  const [loadingBal, setLoadingBal] = useState(false)
  const [copied, setCopied] = useState(false)
  const [menu, setMenu] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showDapps, setShowDapps] = useState(false)
  const [dappCount, setDappCount] = useState(wc.sessions().length)
  const menuRef = useRef<HTMLDivElement>(null)

  const network = nets.find((n) => n.id === settings?.defaultNetwork)
  const address = network ? status.addresses![network.family] : status.addresses!.evm

  const refresh = useCallback(async () => {
    const [s, n] = await Promise.all([api.settings(), api.featured()])
    setSettings(s)
    setNets(n)
  }, [])

  const loadBalances = useCallback(async () => {
    setLoadingBal(true)
    try {
      setBalances(await api.defaultBalances())
    } catch {
      setBalances(null)
    } finally {
      setLoadingBal(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), 5000)
    return () => clearInterval(t)
  }, [refresh])

  // 切换网络后、以及每 30 秒刷新余额
  useEffect(() => {
    if (!settings?.defaultNetwork) return
    void loadBalances()
    const t = setInterval(() => void loadBalances(), 30_000)
    return () => clearInterval(t)
  }, [settings?.defaultNetwork, loadBalances])

  useEffect(() => wc.onChange(() => setDappCount(wc.sessions().length)), [])

  useEffect(() => {
    if (!menu) return
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menu])

  const [main, ...tokens] = balances?.rows ?? []

  return (
    <div className="compact">
      <header className="c-head">
        <select
          className="c-net"
          value={settings?.defaultNetwork ?? ''}
          onChange={async (e) => {
            setBalances(null)
            setSettings(await api.setPrefs({ defaultNetwork: e.target.value }))
          }}
        >
          {nets.map((n) => (
            <option key={n.id} value={n.id}>
              {n.isTestnet ? `${n.name.replace(/\s*testnet$/i, '')}（测试网）` : n.name}
            </option>
          ))}
        </select>
        <button className={`c-icon c-link ${dappCount ? 'on' : ''}`} onClick={() => setShowDapps(true)} title="连接网站">
          ⛓{dappCount > 0 && <span className="c-badge">{dappCount}</span>}
        </button>
        <div className="c-menu" ref={menuRef}>
          <button className="c-icon" onClick={() => setMenu(!menu)} title="菜单">
            ⋯
          </button>
          {menu && (
            <div className="c-dropdown">
              <button
                onClick={async () => {
                  setMenu(false)
                  await refresh()
                  setShowSettings(true)
                }}
              >
                模型与安全设置
              </button>
              <button onClick={onExpand}>切换到完整模式</button>
              <button onClick={onLock}>锁定钱包</button>
            </div>
          )}
        </div>
      </header>

      <section className="c-account">
        <button
          className="c-addr mono"
          title={address}
          onClick={() => {
            void navigator.clipboard.writeText(address)
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          }}
        >
          {copied ? '已复制地址' : short(address)} <span className="muted">⧉</span>
        </button>
        <div className="c-balance">
          {main ? (
            <>
              <span className="num">{main.amount}</span> <span className="unit">{main.asset}</span>
            </>
          ) : (
            <span className="muted small">{loadingBal ? '读取余额…' : '—'}</span>
          )}
        </div>
        {tokens.length > 0 && (
          <div className="c-tokens">
            {tokens.map((t) => (
              <span key={t.asset}>
                {t.amount} {t.asset}
              </span>
            ))}
          </div>
        )}
        {settings && !settings.llm.hasKey && (
          <button className="c-warn" onClick={() => setShowSettings(true)}>
            还没连接模型，点这里粘贴 API Key
          </button>
        )}
      </section>

      <Chat compact onSettled={() => void loadBalances()} />

      {showDapps && (
        <div className="modal-bg" onClick={() => setShowDapps(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>连接网站</h2>
            <DappPanel compact />
            <div className="row">
              <button className="primary" onClick={() => setShowDapps(false)}>
                完成
              </button>
            </div>
          </div>
        </div>
      )}

      {showSettings && settings && (
        <Settings
          initial={settings}
          networks={nets}
          onClose={() => {
            setShowSettings(false)
            void refresh()
          }}
        />
      )}
    </div>
  )
}
