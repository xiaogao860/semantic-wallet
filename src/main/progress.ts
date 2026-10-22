// 进度播报：耗时操作的每一步实时告诉界面，减少等待时的"卡住了"体感
import type { WebContents } from 'electron'

let target: WebContents | null = null

export function setProgressTarget(wc: WebContents | null): void {
  target = wc
}

export function progress(text: string): void {
  if (target && !target.isDestroyed()) target.send('progress', text)
}
