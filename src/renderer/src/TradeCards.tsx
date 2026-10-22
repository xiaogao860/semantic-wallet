import { useEffect, useState } from 'react'
import type { LimitOrderCard, OrdersCard, TokenReportCard } from '../../shared/types'
import { api } from './api'
import { Busy } from './Motion'

const LEVEL_ICON = { ok: '✓', info: 'i', warn: '!', danger: '✕' }

const LIMIT_STATUS: Record<LimitOrderCard['status'], string> = {
  ready: '待确认', blocked: '已拦截', signing: '签名中…', open: '挂单中', filled: '已成交', cancelled: '已撤销', expired: '已过期', failed: '失败'
}

export function LimitCard({ card: initial, onSettled }: { card: LimitOrderCard; onSettled?: () => void }) {
  const [card, setCard] = useState(initial)

  useEffect(() => {
    if (card.status !== 'open') return
    const t = setInterval(async () => {
      const next = await api.limitStatus(card.id).catch(() => undefined)
      if (next) setCard({ ...next })
    }, 15_000)
    return () => clearInterval(t)
  }, [card.status, card.id])

  useEffect(() => {
    if (card.status === 'filled') onSettled?.()
  }, [card.status])

  const confirm = async () => {
    setCard({ ...card, status: 'signing' })
    try {
      setCard(await api.limitConfirm(card.id))
    } catch (e) {
      setCard({ ...card, status: 'failed', error: (e as Error).message })
    }
  }

  return (
    <div className={`card transfer limit ${card.status === 'filled' ? 'confirmed' : card.status}`}>
      <div className="card-head">
        <span className={`tag ${card.network.isTestnet ? '' : 'warn'}`}>
          限价{card.side === 'buy' ? '买入' : '卖出'} · {card.network.name}
        </span>
        <span className={`status ${card.status === 'filled' ? 'confirmed' : card.status}`}>{LIMIT_STATUS[card.status]}</span>
      </div>
      <div className="legs">
        <div className="leg">
          <span className="muted small">付出</span>
          <b>{card.sell}</b>
        </div>
        <span className="arrow">→</span>
        <div className="leg">
          <span className="muted small">至少得到</span>
          <b>{card.buy}</b>
        </div>
      </div>
      <dl>
        <dt>触发价</dt>
        <dd>{card.price}</dd>
        {card.market && (
          <>
            <dt>现价</dt>
            <dd>{card.market}</dd>
          </>
        )}
        <dt>有效期至</dt>
        <dd>{card.validUntil}</dd>
        <dt>步骤</dt>
        <dd>{card.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}</dd>
      </dl>
      <ul className="checks">
        {card.checks.map((c, i) => (
          <li key={i} className={c.level}>
            <span className="icon">{LEVEL_ICON[c.level]}</span>
            {c.text}
          </li>
        ))}
        {card.status === 'ready' && (
          <li className="info">
            <span className="icon">i</span>挂单由 CoW Protocol 撮合，价格到了自动成交，钱包关着也会成交
          </li>
        )}
      </ul>
      {card.status === 'signing' && <Busy label="签名挂单" />}
      {card.error && <p className="error">{card.error}</p>}
      {card.explorerUrl && (
        <p className="small">
          订单：
          <a href={card.explorerUrl} target="_blank" rel="noreferrer" className="mono">
            {card.uid!.slice(0, 12)}…{card.uid!.slice(-6)}
          </a>
        </p>
      )}
      {card.status === 'ready' && (
        <div className="row">
          <button
            className="ghost"
            onClick={() => {
              void api.limitCancel(card.id)
              setCard({ ...card, status: 'cancelled' })
            }}
          >
            取消
          </button>
          <button className="primary" onClick={() => void confirm()}>
            {card.steps.length > 1 ? `确认挂单（${card.steps.length} 步）` : '签名挂单'}
          </button>
        </div>
      )}
    </div>
  )
}

export function OrdersList({ card }: { card: OrdersCard }) {
  const [orders, setOrders] = useState(card.orders)
  const [busy, setBusy] = useState<string | null>(null)
  const cancel = async (networkId: string, uid: string) => {
    setBusy(uid)
    try {
      await api.cancelOrder(networkId, uid)
      setOrders((o) => o.map((x) => (x.uid === uid ? { ...x, status: 'cancelled' } : x)))
    } catch (e) {
      alert((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="card">
      <div className="card-head">
        <b>限价单</b>
        <span className="muted small">{orders.filter((o) => o.status === 'open').length} 个挂单中</span>
      </div>
      {orders.map((o) => (
        <div key={o.uid} className={`order ${o.status === 'open' ? '' : 'dim'}`}>
          <div className="order-main">
            <a href={o.explorerUrl} target="_blank" rel="noreferrer">
              {o.text}
            </a>
            <span className="muted small">
              {o.network} · {LIMIT_STATUS[o.status]}
            </span>
          </div>
          {o.status === 'open' && (
            <button className="ghost small" disabled={busy === o.uid} onClick={() => void cancel(o.networkId, o.uid)}>
              {busy === o.uid ? '…' : '撤销'}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

export function TokenReport({ card }: { card: TokenReportCard }) {
  const danger = card.checks.some((c) => c.level === 'danger')
  const warn = card.checks.some((c) => c.level === 'warn')
  return (
    <div className={`card ${danger ? 'transfer blocked' : ''}`}>
      <div className="card-head">
        <div>
          <b>{card.symbol}</b> <span className="muted small">{card.name !== card.symbol ? card.name : ''}</span>
          <div className="muted small">{card.network.name}</div>
        </div>
        <span className={`status ${danger ? 'blocked' : warn ? 'ready' : 'confirmed'}`}>{danger ? '高风险' : warn ? '有风险点' : '未发现风险'}</span>
      </div>
      {card.price && (
        <div className="amount-line">
          {card.price}
          {card.change24h && <span className={card.change24h.startsWith('-') ? 'down' : 'up'}> {card.change24h}</span>}
        </div>
      )}
      <dl className="facts">
        {card.facts.map((f) => (
          <div key={f.label} className="contents">
            <dt>{f.label}</dt>
            <dd>{f.value}</dd>
          </div>
        ))}
        {card.address && (
          <>
            <dt>合约</dt>
            <dd className="mono break">{card.address}</dd>
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
      <p className="muted small">数据来自 GoPlus 与 DexScreener，仅供参考</p>
    </div>
  )
}
