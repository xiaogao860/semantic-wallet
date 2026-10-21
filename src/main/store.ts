// userData 目录下的 JSON 文件存储，原子写入。
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function dir(): string {
  const d = app.getPath('userData')
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}

export function readJson<T>(name: string, fallback: T): T {
  const p = join(dir(), name)
  if (!existsSync(p)) return fallback
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T
  } catch {
    return fallback
  }
}

export function writeJson(name: string, data: unknown): void {
  const p = join(dir(), name)
  const tmp = `${p}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  renameSync(tmp, p)
}

export function fileExists(name: string): boolean {
  return existsSync(join(dir(), name))
}
