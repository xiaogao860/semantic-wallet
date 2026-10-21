import { useEffect, useState } from 'react'
import type { DappInfo, DappProposalCard, DappRequestCard } from '../../shared/types'
import { type DappSession, WC_URI, wc } from './walletconnect'

const LEVEL_ICON = { ok: '✓', info: 'i', warn: '!', danger: '✕' }

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function DappHead({ dapp, right }: { dapp: DappInfo; right?: React.ReactNode }) {
  return (
    <div className="card-head">
      <div className="dapp">
        {dapp.icon ? <img src={dapp.icon} alt="" /> : <span className="dapp-ph">{dapp.name.slice(0, 1)}</span>}
        <div>
          <b>{dapp.name}</b>
          <div className="muted small">{hostOf(dapp.url)}</div>
        </div>
      </div>
      {right}
    </div>
  )
}

export function ProposalCard({ card: initial }: { card: DappProposalCard }) {
  const [card, setCard] = useState(initial)
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<void>, ok: DappProposalCard['status']) => {
    setBusy(true)
    try {
      await fn()
      setCard({ ...card, status: ok })
    } catch (e) {
      setCard({ ...card, status: 'failed', error: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }
  const danger = card.isScam || card.verified === 'INVALID'
  const status = { ready: '请求连接', approved: '已连接', rejected: '已拒绝', failed: '连接失败', expired: '已过期' }[card.status]
  return (
    <div className={`card dappcard ${danger ? 'blocked' : ''}`}>
      <DappHead dapp={card.dapp} right={<span className={`status ${card.status === 'ready' ? 'ready' : ''}`}>{status}</span>} />
      <ul className="checks">
        {card.isScam && (
          <li className="danger">
            <span className="icon">✕</span>WalletConnect 将这个网站标记为诈骗网站，强烈建议拒绝
          </li>
        )}
        {card.verified === 'INVALID' && (
          <li className="danger">
            <span className="icon">✕</span>网站实际域名与它声明的不一致，疑似仿冒
          </li>
        )}
        {card.verified === 'VALID' && (
          <li className="ok">
            <span className="icon">✓</span>域名已通过 WalletConnect 验证
          </li>
        )}
        {card.verified === 'UNKNOWN' && (
          <li className="info">
            <span className="icon">i</span>无法验证网站来源，请确认是你正在访问的网站
          </li>
        )}
        <li className="info">
          <span className="icon">i</span>
          将共享你的 EVM 地址，网站可以向你发起签名和交易请求（每次都要你确认）
        </li>
        {card.networks.length > 0 && (
          <li className="info">
            <span className="icon">i</span>
            网络：{card.networks.slice(0, 6).join('、')}
            {card.networks.length > 6 ? ` 等 ${card.networks.length} 条` : ''}
          </li>
        )}
        {card.unsupported.length > 0 && (
          <li className="warn">
            <span className="icon">!</span>网站要求的 {card.unsupported.join('、')} 暂不支持，连接可能失败
          </li>
        )}
      </ul>
      {card.error && <p className="error">{card.error}</p>}
      {card.status === 'ready' && (
        <div className="row">
          <button className="ghost" disabled={busy} onClick={() => void run(() => wc.rejectProposal(card.id), 'rejected')}>
            拒绝
          </button>
          <button className="primary" disabled={busy} onClick={() => void run(() => wc.approveProposal(card.id), 'approved')}>
            {busy ? '连接中…' : '连接'}
          </button>
        </div>
      )}
    </div>
  )
}

export function RequestCard({ card: initial }: { card: DappRequestCard }) {
  const [card, setCard] = useState(initial)
  const status = {
    ready: '待确认', blocked: '已拦截', sending: '签名中…', done: '已完成', rejected: '已拒绝', failed: '失败', expired: '已过期'
  }[card.status]

  const approve = async () => {
    setCard({ ...card, status: 'sending' })
    try {
      const r = await wc.approveRequest(card)
      setCard({ ...card, status: 'done', result: r.result, explorerUrl: r.explorerUrl })
    } catch (e) {
      setCard({ ...card, status: 'failed', error: (e as Error).message })
    }
  }
  const reject = async () => {
    setCard({ ...card, status: 'rejected' })
    await wc.rejectRequest(card).catch(() => undefined)
  }

  const isTx = card.method === 'eth_sendTransaction'
  return (
    <div className={`card transfer dappcard ${card.status}`}>
      <DappHead dapp={card.dapp} right={<span className={`status ${card.status}`}>{status}</span>} />
      <div className="dapp-title">
        {card.title}
        {card.network && <span className={`tag ${card.network.isTestnet ? '' : 'warn'}`}>{card.network.name}</span>}
      </div>
      {card.aiSummary && (
        <p className="ai">
          <span className="tag">AI 解读</span> {card.aiSummary}
        </p>
      )}
      <dl>
        {card.fields.map((f, i) => (
          <div key={i} className="contents">
            <dt>{f.label}</dt>
            <dd className={f.mono ? 'mono break' : 'break'}>{f.value}</dd>
          </div>
        ))}
        {card.simulation && (
          <>
            <dt>模拟</dt>
            <dd className={card.simulation.ok ? 'ok' : 'bad'}>{card.simulation.detail}</dd>
          </>
        )}
      </dl>
      <ul className="checks">
        {card.checks.map((c, i) => (
          <li key={i} className={c.level}>
            <span className="icon">{LEVEL_ICON[c.level]}</span>
            {c.text}
          </li>
        ))}
      </ul>
      {card.error && <p className="error">{card.error}</p>}
      {card.result && (
        <p className="small">
          {isTx ? '交易哈希：' : '签名：'}
          {card.explorerUrl ? (
            <a href={card.explorerUrl} target="_blank" rel="noreferrer" className="mono">
              {card.result.slice(0, 12)}…{card.result.slice(-8)}
            </a>
          ) : (
            <span className="mono">
              {card.result.slice(0, 12)}…{card.result.slice(-8)}
            </span>
          )}
        </p>
      )}
      {card.status === 'ready' && (
        <div className="row">
          <button className="ghost" onClick={() => void reject()}>
            拒绝
          </button>
          <button className="primary" onClick={() => void approve()}>
            {isTx ? '确认并发送' : '确认签名'}
          </button>
        </div>
      )}
    </div>
  )
}

// 已连接的网站 + 粘贴 WalletConnect 连接码
export function DappPanel({ compact = false }: { compact?: boolean }) {
  const [sessions, setSessions] = useState<DappSession[]>(wc.sessions())
  const [status, setStatus] = useState(wc.status)
  const [uri, setUri] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    const sync = () => {
      setSessions(wc.sessions())
      setStatus(wc.status)
    }
    sync()
    return wc.onChange(sync)
  }, [])

  const pair = async (text: string) => {
    const m = WC_URI.exec(text)
    if (!m) return setMsg({ ok: false, text: '这不是 WalletConnect 连接码（应以 wc: 开头）' })
    setMsg({ ok: true, text: '正在连接，稍后在对话里确认…' })
    setUri('')
    try {
      await wc.pair(m[0])
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message })
    }
  }

  return (
    <div className={`dapppanel ${compact ? 'compact-panel' : ''}`}>
      {status === 'off' && <p className="muted small">先在设置里填写 WalletConnect 项目 ID</p>}
      {status === 'error' && <p className="error small">WalletConnect 初始化失败：{wc.error}</p>}
      <input
        value={uri}
        placeholder="粘贴网站的 WalletConnect 连接码（wc:…）"
        onChange={(e) => setUri(e.target.value)}
        onPaste={(e) => {
          e.preventDefault()
          void pair(e.clipboardData.getData('text'))
        }}
        onKeyDown={(e) => e.key === 'Enter' && void pair(uri)}
      />
      {msg && <p className={`small ${msg.ok ? 'muted' : 'error'}`}>{msg.text}</p>}
      {sessions.length === 0 ? (
        <p className="muted small">还没有连接网站。在网站上点「连接钱包 → WalletConnect」，复制连接码粘贴到这里</p>
      ) : (
        sessions.map((s) => (
          <div key={s.topic} className="session">
            {s.dapp.icon ? <img src={s.dapp.icon} alt="" /> : <span className="dapp-ph">{s.dapp.name.slice(0, 1)}</span>}
            <div className="session-name">
              <b>{s.dapp.name}</b>
              <span className="muted small">{hostOf(s.dapp.url)}</span>
            </div>
            <button className="ghost small" onClick={() => void wc.disconnect(s.topic)}>
              断开
            </button>
          </div>
        ))
      )}
    </div>
  )
}
