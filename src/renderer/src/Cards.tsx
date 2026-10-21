import { useEffect, useState } from 'react'
import type { BalanceCard, Card, NetworkCard, TransferCard } from '../../shared/types'
import { api } from './api'
import { ProposalCard, RequestCard } from './DappCards'

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
