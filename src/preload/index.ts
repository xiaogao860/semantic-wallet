import { contextBridge, ipcRenderer } from 'electron'

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await ipcRenderer.invoke(channel, ...args)) as { ok: boolean; data?: T; error?: string }
  if (!res.ok) throw new Error(res.error)
  return res.data as T
}

// 主进程的实时进度（"询价中""模拟中"…），返回取消订阅函数
function onProgress(cb: (text: string) => void): () => void {
  const listener = (_e: unknown, text: string) => cb(text)
  ipcRenderer.on('progress', listener)
  return () => ipcRenderer.removeListener('progress', listener)
}

contextBridge.exposeInMainWorld('wallet', { call, onProgress, platform: process.platform })
