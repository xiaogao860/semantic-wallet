import { useEffect, useRef, useState } from 'react'
import type { Card } from '../../shared/types'
import { api } from './api'
import CardView from './Cards'
import { WC_URI, wc } from './walletconnect'

type Msg = { role: 'user'; text: string } | { role: 'assistant'; text: string; cards: Card[] }

const EXAMPLES = [
  '查一下我在 Base Sepolia 和 Solana devnet 的余额',
  '加上 Arbitrum，测一下哪个 RPC 最快',
  '把 0x000000000000000000000000000000000000dEaD 存为小王',
  '给小王转 0.0001 ETH，走 Base Sepolia',
  '波场测试网上我有多少 TRX 和 USDT',
  '我的收款地址是什么'
]

const COMPACT_EXAMPLES = ['查一下余额', '我的收款地址是什么', '给小王转 0.001 ETH', '加上 Arbitrum，测一下 RPC']

export default function Chat({ compact = false, onSettled }: { compact?: boolean; onSettled?: () => void }) {
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' })
  }, [msgs, busy])

  // 网站发来的连接 / 签名请求插入对话
  useEffect(() => wc.onCard((card) => setMsgs((m) => [...m, { role: 'assistant', text: '', cards: [card] }])), [])

  // 对话里的"连了哪些网站 / 断开网站"交给 WalletConnect 执行
  const runDappCommands = async (cards: Card[]): Promise<Card[]> => {
    const out: Card[] = []
    for (const c of cards) {
      if (c.kind !== 'dapp_command') {
        out.push(c)
        continue
      }
      try {
        if (c.op === 'list') {
          const list = wc.sessions()
          out.push({ kind: 'info', level: 'info', text: list.length ? `已连接：\n${list.map((s) => `${s.dapp.name}（${s.dapp.url}）`).join('\n')}` : '还没有连接任何网站' })
        } else {
          const names = await wc.disconnectMatching(c.target)
          out.push({ kind: 'info', level: names.length ? 'ok' : 'info', text: names.length ? `已断开：${names.join('、')}` : '没有找到要断开的网站' })
        }
      } catch (e) {
        out.push({ kind: 'info', level: 'danger', text: (e as Error).message })
      }
    }
    return out
  }

  const send = async (text: string) => {
    const t = text.trim()
    if (!t || busy) return
    setInput('')
    // WalletConnect 连接码里有配对密钥，不发给大模型，直接本地配对
    const uri = WC_URI.exec(t)
    if (uri) {
      setMsgs((m) => [
        ...m,
        { role: 'user', text: `${uri[0].slice(0, 24)}…` },
        { role: 'assistant', text: '正在连接网站，网站信息到了会在这里请你确认…', cards: [] }
      ])
      try {
        await wc.pair(uri[0])
      } catch (e) {
        setMsgs((m) => [...m, { role: 'assistant', text: '', cards: [{ kind: 'info', level: 'danger', text: (e as Error).message }] }])
      }
      return
    }
    setMsgs((m) => [...m, { role: 'user', text: t }])
    setBusy(true)
    try {
      const r = await api.chat(t)
      const cards = await runDappCommands(r.cards)
      setMsgs((m) => [...m, { role: 'assistant', text: r.reply, cards }])
      onSettled?.()
    } catch (e) {
      setMsgs((m) => [...m, { role: 'assistant', text: '', cards: [{ kind: 'info', level: 'danger', text: (e as Error).message }] }])
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="chat">
      <div className="messages">
        {msgs.length === 0 && (
          <div className="empty">
            <h2>想做什么，直接说</h2>
            <p className="muted">
              {compact ? '每笔转账都先模拟、风控，由你确认后才签名' : '转账、查余额、切换网络、添加 RPC、存联系人。每笔转账都会先模拟、风控，由你确认后才签名。'}
            </p>
            <div className="examples">
              {(compact ? COMPACT_EXAMPLES : EXAMPLES).map((e) => (
                <button key={e} className="chip" onClick={() => void send(e)}>
                  {e}
                </button>
              ))}
            </div>
          </div>
        )}
        {msgs.map((m, i) =>
          m.role === 'user' ? (
            <div key={i} className="bubble user">
              {m.text}
            </div>
          ) : (
            <div key={i} className="assistant">
              {m.text && <div className="bubble bot">{m.text}</div>}
              {m.cards.map((c, j) => (
                <CardView key={j} card={c} onSettled={onSettled} />
              ))}
            </div>
          )
        )}
        {busy && <div className="bubble bot muted">理解中…</div>}
        <div ref={bottom} />
      </div>
      <div className="composer">
        <textarea
          rows={1}
          placeholder={compact ? '说一句，比如：给小王转 50U' : '例如：给小王转 50U，走波场'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send(input)
            }
          }}
        />
        <button className="primary send" disabled={busy || !input.trim()} onClick={() => void send(input)} title="发送">
          {compact ? '↑' : '发送'}
        </button>
      </div>
    </main>
  )
}
