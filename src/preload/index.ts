import { contextBridge, ipcRenderer } from 'electron'

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await ipcRenderer.invoke(channel, ...args)) as { ok: boolean; data?: T; error?: string }
  if (!res.ok) throw new Error(res.error)
  return res.data as T
}

contextBridge.exposeInMainWorld('wallet', { call, platform: process.platform })
