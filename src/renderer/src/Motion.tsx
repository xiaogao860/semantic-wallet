import { useEffect, useState } from 'react'
import { onProgress } from './api'

// 订阅主进程进度；active 为 false 时不订阅
export function useProgress(active: boolean): string {
  const [text, setText] = useState('')
  useEffect(() => {
    if (!active) {
      setText('')
      return
    }
    return onProgress(setText)
  }, [active])
  return text
}

function useElapsed(active: boolean): number {
  const [s, setS] = useState(0)
  useEffect(() => {
    if (!active) return setS(0)
    const t0 = Date.now()
    const id = setInterval(() => setS(Math.floor((Date.now() - t0) / 1000)), 500)
    return () => clearInterval(id)
  }, [active])
  return s
}

export function Dots() {
  return (
    <span className="dots" aria-hidden>
      <i />
      <i />
      <i />
    </span>
  )
}

export function Spinner() {
  return <span className="spinner" aria-hidden />
}

// 等待模型和链上查询时的气泡：实时步骤 + 已用秒数，等久了再出骨架卡片
export function Thinking() {
  const text = useProgress(true)
  const sec = useElapsed(true)
  return (
    <div className="assistant">
      <div className="bubble bot thinking">
        <Dots />
        <span key={text} className="step">{text || '正在理解你的意思'}</span>
        {sec >= 3 && <span className="elapsed">{sec}s</span>}
      </div>
      {sec >= 2 && (
        <div className="card skeleton" aria-hidden>
          <div className="sk w40" />
          <div className="sk w70 tall" />
          <div className="sk w90" />
          <div className="sk w60" />
        </div>
      )}
    </div>
  )
}

// 卡片里"签名中 / 发送中"的状态：转圈 + 当前步骤
export function Busy({ label }: { label: string }) {
  const text = useProgress(true)
  return (
    <p className="busy">
      <Spinner />
      <span key={text}>{text || label}</span>
    </p>
  )
}
