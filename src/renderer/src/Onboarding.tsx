import { useState } from 'react'
import type { WalletStatus } from '../../shared/types'
import { api } from './api'

export default function Onboarding({ onDone }: { onDone: (s: WalletStatus) => void }) {
  const [mode, setMode] = useState<'choose' | 'create' | 'import'>('choose')
  const [mnemonic, setMnemonic] = useState('')
  const [backedUp, setBackedUp] = useState(false)
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const startCreate = async () => {
    setMnemonic(await api.newMnemonic())
    setMode('create')
  }

  const submit = async () => {
    if (pw !== pw2) return setError('两次密码不一致')
    setBusy(true)
    setError('')
    try {
      onDone(await api.create(mnemonic, pw))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (mode === 'choose') {
    return (
      <div className="center">
        <div className="panel narrow">
          <h1>语义钱包</h1>
          <p className="muted">一句话转账，自动配置 RPC。EVM 全系 / Solana / Tron，私钥只保存在这台电脑上。</p>
          <button className="primary" onClick={() => void startCreate()}>创建新钱包</button>
          <button onClick={() => setMode('import')}>导入助记词</button>
        </div>
      </div>
    )
  }

  const passwordFields = (
    <>
      <input type="password" placeholder="设置密码（至少 8 位）" value={pw} onChange={(e) => setPw(e.target.value)} />
      <input type="password" placeholder="再次输入密码" value={pw2} onChange={(e) => setPw2(e.target.value)} />
    </>
  )

  return (
    <div className="center">
      <div className="panel narrow">
        <h2>{mode === 'create' ? '备份助记词' : '导入助记词'}</h2>
        {mode === 'create' ? (
          <>
            <p className="muted">这 12 个词就是你的钱包。请抄在纸上离线保存，任何人拿到都能转走资产。</p>
            <ol className="words">
              {mnemonic.split(' ').map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ol>
            <label className="check">
              <input type="checkbox" checked={backedUp} onChange={(e) => setBackedUp(e.target.checked)} />
              我已抄写并妥善保存
            </label>
          </>
        ) : (
          <textarea rows={3} placeholder="12 或 24 个英文单词，用空格分隔" value={mnemonic} onChange={(e) => setMnemonic(e.target.value)} />
        )}
        {passwordFields}
        {error && <p className="error">{error}</p>}
        <button
          className="primary"
          disabled={busy || pw.length < 8 || (mode === 'create' && !backedUp) || !mnemonic.trim()}
          onClick={() => void submit()}
        >
          {busy ? '加密保存中…' : '完成'}
        </button>
        <button className="ghost" onClick={() => setMode('choose')}>返回</button>
      </div>
    </div>
  )
}
