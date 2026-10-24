import { useEffect, useState } from 'react'
import type { BalanceCard, Card, DiscoveryCard, NetworkCard, RouteCard, TokenChoiceCard, TransferCard } from '../../shared/types'
import { api } from './api'
import { ProposalCard, RequestCard } from './DappCards'
import { Busy, Spinner } from './Motion'
import { LimitCard, OrdersList, TokenReport } from './TradeCards'

const LEVEL_ICON = { ok: '✓', info: 'i', warn: '!', danger: '✕' }

const STATUS_TEXT: Record<TransferCard['status'], string> = {
  ready: '待确认',
  blocked: '已拦截',
  sending: '签名广播中…',
  sent: '已广播，等待上链…',
  confirmed: '已上链',
  failed: '失败',
  cancelled: '已取消',
  expired: '已失效'
}

function Transfer({ card: initial, onSettled }: { card: TransferCard; onSettled?: () => void }) {
  const [card, setCard] = useState(initial)

  useEffect(() => {
    if (card.status === 'confirmed' || card.status === 'failed') onSettled?.()
  }, [card.status])

  useEffect(() => {
    if (card.status !== 'sent') return
    const t = setInterval(async () => {
      const next = await api.txStatus(card.id).catch(() => undefined)
      if (next) setCard({ ...next })
    }, 3000)
    return () => clearInterval(t)
  }, [card.status, card.id])

  const confirm = async () => {
    setCard({ ...card, status: 'sending' })
    try {
      setCard(await api.confirm(card.id))
    } catch (e) {
      setCard({ ...card, status: 'failed', error: (e as Error).message })
    }
  }

  const cancel = () => {
    void api.cancel(card.id)
    setCard({ ...card, status: 'cancelled' })
  }

  return (
    <div className={`card transfer ${card.status}`}>
      <div className="card-head">
        <span className={`tag ${card.network.isTestnet ? '' : 'warn'}`}>{card.network.name}</span>
        <span className={`status ${card.status}`}>{STATUS_TEXT[card.status]}</span>
      </div>
      <div className="amount">
        {card.amount} <span>{card.asset}</span>
      </div>
      <dl>
        <dt>收款</dt>
        <dd>
          {card.toLabel && <b>{card.toLabel} </b>}
          <span className="mono break">{card.to}</span>
        </dd>
        <dt>付款</dt>
        <dd className="mono break">{card.from}</dd>
        <dt>手续费</dt>
        <dd>{card.fee === '0' ? '0（使用账户免费资源）' : `≤ ${card.fee} ${card.feeSymbol}`}</dd>
        {card.balanceAfter !== undefined && (
          <>
            <dt>转后余额</dt>
            <dd>
              {card.balanceAfter} {card.asset}
            </dd>
          </>
        )}
        <dt>模拟</dt>
        <dd className={card.simulation.ok ? 'ok' : 'bad'}>{card.simulation.detail}</dd>
      </dl>
      <ul className="checks">
        {card.checks.map((c, i) => (
          <li key={i} className={c.level}>
            <span className="icon">{LEVEL_ICON[c.level]}</span>
            {c.text}
          </li>
        ))}
      </ul>
      {card.status === 'sending' && <Busy label="签名并广播" />}
      {card.error && <p className="error">{card.error}</p>}
      {card.hash && (
        <p className="small">
          交易哈希：
          {card.explorerUrl ? (
            <a href={card.explorerUrl} target="_blank" rel="noreferrer" className="mono">
              {card.hash.slice(0, 12)}…{card.hash.slice(-8)}
            </a>
          ) : (
            <span className="mono">{card.hash}</span>
          )}
        </p>
      )}
      {card.status === 'ready' && (
        <div className="row">
          <button className="ghost" onClick={cancel}>
            取消
          </button>
          <button className="primary" onClick={() => void confirm()}>
            确认并签名
          </button>
        </div>
      )}
    </div>
  )
}

const ROUTE_STATUS: Record<RouteCard['status'], string> = {
  ready: '待确认', blocked: '已拦截', sending: '签名并发送中…', sent: '处理中…', confirmed: '已完成', failed: '失败', cancelled: '已取消', expired: '已失效'
}

function Route({ card: initial, onSettled }: { card: RouteCard; onSettled?: () => void }) {
  const [card, setCard] = useState(initial)

  useEffect(() => {
    if (card.status !== 'sent') return
    const t = setInterval(async () => {
      const next = await api.routeStatus(card.id).catch(() => undefined)
      if (next) setCard({ ...next })
    }, 4000)
    return () => clearInterval(t)
  }, [card.status, card.id])

  useEffect(() => {
    if (card.status === 'confirmed' || card.status === 'failed') onSettled?.()
  }, [card.status])

  const confirm = async () => {
    setCard({ ...card, status: 'sending' })
    try {
      setCard(await api.routeConfirm(card.id))
    } catch (e) {
      setCard({ ...card, status: 'failed', error: (e as Error).message })
    }
  }

  const bridge = card.mode === 'bridge'
  return (
    <div className={`card transfer route ${card.status}`}>
      <div className="card-head">
        <span className="tag">{bridge ? '跨链' : '兑换'} · {card.provider}</span>
        <span className={`status ${card.status}`}>{ROUTE_STATUS[card.status]}</span>
      </div>
      <div className="legs">
        <div className="leg">
          <span className="muted small">{card.from.network.name}</span>
          <b>
            {card.from.amount} <span>{card.from.asset}</span>
          </b>
        </div>
        <span className="arrow">→</span>
        <div className="leg">
          <span className="muted small">{card.to.network.name}</span>
          <b>
            ≈{card.to.amount} <span>{card.to.asset}</span>
          </b>
        </div>
      </div>
      <dl>
        {card.rate && (
          <>
            <dt>汇率</dt>
            <dd>{card.rate}</dd>
          </>
        )}
        {card.alternatives && (
          <>
            <dt>比价</dt>
            <dd>
              <table className="alts">
                <tbody>
                  {card.alternatives.map((a) => (
                    <tr key={a.name} className={a.chosen ? 'chosen' : ''}>
                      <td>{a.chosen ? '✓ ' : ''}{a.name}</td>
                      <td className="num">{a.amount} {card.to.asset}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </dd>
          </>
        )}
        {card.to.min && (
          <>
            <dt>最少到账</dt>
            <dd>
              {card.to.min} {card.to.asset}
            </dd>
          </>
        )}
        {card.duration && (
          <>
            <dt>预计用时</dt>
            <dd>{card.duration}</dd>
          </>
        )}
        {card.fees.map((f) => (
          <div key={f.label} className="contents">
            <dt>{f.label}</dt>
            <dd>{f.value}</dd>
          </div>
        ))}
        <dt>步骤</dt>
        <dd>{card.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}</dd>
        <dt>模拟</dt>
        <dd className={card.simulation.ok ? 'ok' : 'bad'}>{card.simulation.detail}</dd>
      </dl>
      <ul className="checks">
        {card.checks.map((c, i) => (
          <li key={i} className={c.level}>
            <span className="icon">{LEVEL_ICON[c.level]}</span>
            {c.text}
          </li>
        ))}
      </ul>
      {card.status === 'sending' && <Busy label="签名并发送" />}
      {card.progress && card.status === 'sent' && (
        <p className="busy">
          <span className="pulse-dot" />
          {card.progress}
        </p>
      )}
      {card.error && <p className="error">{card.error}</p>}
      {card.hash && (
        <p className="small">
          {bridge ? '源链交易：' : '交易哈希：'}
          <a href={card.explorerUrl} target="_blank" rel="noreferrer" className="mono">
            {card.hash.slice(0, 12)}…{card.hash.slice(-8)}
          </a>
          {card.destHash && (
            <>
              <br />
              到账交易：
              <a href={card.destExplorerUrl} target="_blank" rel="noreferrer" className="mono">
                {card.destHash.slice(0, 12)}…{card.destHash.slice(-8)}
              </a>
            </>
          )}
        </p>
      )}
      {card.status === 'ready' && (
        <div className="row">
          <button
            className="ghost"
            onClick={() => {
              void api.routeCancel(card.id)
              setCard({ ...card, status: 'cancelled' })
            }}
          >
            取消
          </button>
          <button className="primary" onClick={() => void confirm()}>
            {card.steps.length > 1 ? `确认并签名（${card.steps.length} 步）` : '确认并签名'}
          </button>
        </div>
      )}
    </div>
  )
}

function Discovery({ card: initial, onSettled }: { card: DiscoveryCard; onSettled?: () => void }) {
  const [card, setCard] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [after, setAfter] = useState<Card[]>([])
  const add = async () => {
    setBusy(true)
    try {
      const r = await api.discoveryConfirm(card.id)
      setCard({ ...card, status: 'added' })
      setAfter(r.cards)
      onSettled?.()
    } catch (e) {
      setCard({ ...card, status: 'failed', error: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }
  const status = { ready: '待确认', blocked: '无法添加', added: '已添加', cancelled: '已取消', failed: '失败' }[card.status]
  return (
    <>
      <div className={`card transfer discovery ${card.status === 'added' ? 'confirmed' : card.status}`}>
        <div className="card-head">
          <span className="tag">发现新网络{card.isTestnet ? ' · 测试网' : ''}</span>
          <span className={`status ${card.status === 'added' ? 'confirmed' : card.status}`}>{status}</span>
        </div>
        <div className="amount">
          {card.name} <span>chainId {card.chainId}</span>
        </div>
        <dl>
          <dt>原生币</dt>
          <dd>{card.nativeSymbol}</dd>
          {card.explorer && (
            <>
              <dt>浏览器</dt>
              <dd className="break">{card.explorer}</dd>
            </>
          )}
          <dt>RPC</dt>
          <dd>
            {card.rpcs.map((r) => (
              <div key={r.url} className={`rpc ${r.ok ? 'ok' : 'bad'}`}>
                {r.ok ? '✓' : '✕'} <span className="mono">{r.url.replace(/^https:\/\//, '')}</span>
                <span className="muted small"> {r.ok ? `${r.latencyMs}ms` : r.error}</span>
              </div>
            ))}
          </dd>
          <dt>来源</dt>
          <dd>
            {card.sources.map((s) => (
              <div key={s}>
                <a href={s} target="_blank" rel="noreferrer" className="small break">
                  {s.replace(/^https?:\/\//, '').slice(0, 60)}
                </a>
              </div>
            ))}
          </dd>
        </dl>
        <ul className="checks">
          {card.checks.map((c, i) => (
            <li key={i} className={c.level}>
              <span className="icon">{LEVEL_ICON[c.level]}</span>
              {c.text}
            </li>
          ))}
        </ul>
        {card.followUp && card.status === 'ready' && <p className="small muted">{card.followUp}</p>}
        {card.error && <p className="error">{card.error}</p>}
        {card.status === 'ready' && (
          <div className="row">
            <button
              className="ghost"
              onClick={() => {
                void api.discoveryCancel(card.id)
                setCard({ ...card, status: 'cancelled' })
              }}
            >
              取消
            </button>
            <button className="primary" disabled={busy} onClick={() => void add()}>
              {busy ? '添加中…' : '添加网络'}
            </button>
          </div>
        )}
      </div>
      {after.map((c, i) => (
        <CardView key={i} card={c} onSettled={onSettled} />
      ))}
    </>
  )
}

function TokenChoice({ card, onSettled }: { card: TokenChoiceCard; onSettled?: () => void }) {
  const [picked, setPicked] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [after, setAfter] = useState<Card[]>([])
  const [copied, setCopied] = useState<string | null>(null)
  const choose = async (key: string) => {
    setBusy(key)
    try {
      setAfter(await api.tokenChoose(card.id, key))
      setPicked(key)
      onSettled?.()
    } catch (e) {
      setAfter([{ kind: 'info', level: 'danger', text: (e as Error).message }])
    } finally {
      setBusy(null)
    }
  }
  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
  const options = picked ? card.options.filter((o) => o.key === picked) : card.options
  return (
    <>
      <div className="card choice">
        <div className="card-head">
          <span className="tag">{card.title ?? `「${card.query}」有 ${card.options.length} 个同名代币`}</span>
          <span className="status ready">{picked ? '已选择' : `选一个来${card.action}`}</span>
        </div>
        <div className="choices">
          {options.map((o) => (
            <div key={o.key} className={`choice-row ${o.recommended ? 'rec' : ''}`}>
              <div className="choice-main">
                <div className="choice-title">
                  <b>{o.name}</b>
                  <span className="muted small">{o.symbol}</span>
                  {o.recommended && <span className="tag ok-tag">流动性最高</span>}
                  {o.note && <span className="tag">{o.note}</span>}
                </div>
                <div className="choice-meta">
                  <span className="chain">{o.network.name}</span>
                  {o.price && <span>{o.price}</span>}
                  {o.change24h !== undefined && (
                    <span className={o.change24h >= 0 ? 'up' : 'down'}>
                      {o.change24h >= 0 ? '+' : ''}
                      {o.change24h.toFixed(1)}%
                    </span>
                  )}
                  {o.liquidity && <span>流动性 {o.liquidity}</span>}
                  {o.volume24h && <span>24h {o.volume24h}</span>}
                  {o.age && <span>上线 {o.age}</span>}
                </div>
                <button
                  className="addr-mini mono"
                  title={o.address}
                  onClick={() => {
                    void navigator.clipboard.writeText(o.address)
                    setCopied(o.key)
                    setTimeout(() => setCopied(null), 1200)
                  }}
                >
                  {copied === o.key ? '已复制合约' : short(o.address)}
                </button>
              </div>
              {!picked && (
                <button className={o.recommended ? 'primary pick' : 'pick'} disabled={!!busy} onClick={() => void choose(o.key)}>
                  {busy === o.key ? <Spinner /> : '选这个'}
                </button>
              )}
            </div>
          ))}
        </div>
        {!picked && <p className="muted small">同名代币里有不少是仿冒币，优先选流动性高、上线时间长的，并核对合约地址</p>}
      </div>
      {after.map((c, i) => (
        <CardView key={i} card={c} onSettled={onSettled} />
      ))}
    </>
  )
}

function Balances({ card }: { card: BalanceCard }) {
  return (
    <div className="card">
      <table>
        <tbody>
          {card.rows.map((r, i) => (
            <tr key={i}>
              <td className="muted">{r.network}</td>
              <td className="num">{r.amount}</td>
              <td>{r.asset}</td>
              {r.error && <td className="error small">{r.error}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Network({ card }: { card: NetworkCard }) {
  return (
    <div className="card">
      <div className="card-head">
        <b>{card.network.name}</b>
        <span className="muted small">
          探测 {card.state.ranked.length} 个节点，可用 {card.state.ranked.filter((r) => r.ok).length} 个
        </span>
      </div>
      <table>
        <tbody>
          {card.state.ranked.map((r) => (
            <tr key={r.url} className={r.ok ? '' : 'dim'}>
              <td>{card.state.selected.includes(r.url) ? '★' : ''}</td>
              <td className="mono small">{new URL(r.url).host}</td>
              <td className="num">{r.ok ? `${r.latencyMs}ms` : ''}</td>
              <td className="small">{r.ok ? `#${r.height}` : <span className="error">{r.error}</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function CardView({ card, onSettled }: { card: Card; onSettled?: () => void }) {
  switch (card.kind) {
    case 'transfer':
      return <Transfer card={card} onSettled={onSettled} />
    case 'balances':
      return <Balances card={card} />
    case 'network':
      return <Network card={card} />
    case 'route':
      return <Route card={card} onSettled={onSettled} />
    case 'discovery':
      return <Discovery card={card} onSettled={onSettled} />
    case 'token_choice':
      return <TokenChoice card={card} onSettled={onSettled} />
    case 'limit':
      return <LimitCard card={card} onSettled={onSettled} />
    case 'orders':
      return <OrdersList card={card} />
    case 'token_report':
      return <TokenReport card={card} />
    case 'dapp_proposal':
      return <ProposalCard card={card} />
    case 'dapp_request':
      return <RequestCard card={card} />
    case 'dapp_command':
      return null
    case 'info':
      return (
        <div className={`card info ${card.level}`}>
          <span className="icon">{LEVEL_ICON[card.level]}</span>
          <pre>{card.text}</pre>
        </div>
      )
  }
}
