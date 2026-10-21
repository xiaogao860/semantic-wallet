import { useEffect, useState } from 'react'
import type { UiMode, WalletStatus } from '../../shared/types'
import { api } from './api'
import Chat from './Chat'
import Compact from './Compact'
import Onboarding from './Onboarding'
import Sidebar from './Sidebar'
import { wc } from './walletconnect'

export default function App() {
  const [status, setStatus] = useState<WalletStatus | null>(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<UiMode | null>(null)
  const [projectId, setProjectId] = useState('')

  useEffect(() => {
    void api.settings().then((s) => {
      setMode(s.uiMode)
      setProjectId(s.wcProjectId)
    })
    void api.status().then(setStatus)
    // 主进程闲置自动锁定后，界面跟着回到解锁页；设置里改了项目 ID 也跟着生效
    const t = setInterval(() => {
      void api.status().then(setStatus)
      void api.settings().then((s) => setProjectId(s.wcProjectId))
    }, 5_000)
    return () => clearInterval(t)
  }, [])

  const evm = status?.addresses?.evm
  useEffect(() => {
    if (evm && projectId) void wc.init(projectId, evm)
  }, [evm, projectId])

  if (!status || !mode) return <div className="center muted">加载中…</div>
  const switchMode = (m: UiMode) => void api.setMode(m).then((s) => setMode(s.uiMode))
  if (!status.exists) return <Onboarding onDone={setStatus} />

  if (!status.unlocked) {
    const unlock = async () => {
      setBusy(true)
      setError('')
      try {
        setStatus(await api.unlock(password))
        setPassword('')
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setBusy(false)
      }
    }
    return (
      <div className="center">
        <div className="panel narrow">
          <h1>语义钱包</h1>
          <p className="muted">输入密码解锁本地钱包</p>
          <input
            type="password"
            autoFocus
            placeholder="密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void unlock()}
          />
          {error && <p className="error">{error}</p>}
          <button className="primary" disabled={busy || !password} onClick={() => void unlock()}>
            {busy ? '解锁中…' : '解锁'}
          </button>
        </div>
      </div>
    )
  }

  const lock = () => void api.lock().then(setStatus)
  if (mode === 'compact') return <Compact status={status} onLock={lock} onExpand={() => switchMode('full')} />
  return (
    <div className="layout">
      <Sidebar status={status} onLock={lock} onCompact={() => switchMode('compact')} />
      <Chat />
    </div>
  )
}
