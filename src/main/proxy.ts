// 网络代理：主进程的 fetch / axios 默认不走系统代理，国内网络下大部分海外 RPC 会超时。
// 代理随时可能被开关，所以定期重新检测：代理可用就走代理，代理关了或端口不通就自动直连。
import { session } from 'electron'
import { connect } from 'node:net'
import { Agent, EnvHttpProxyAgent, setGlobalDispatcher } from 'undici'

const CHECK_INTERVAL = 8_000

// 启动时的环境变量代理（用户自己设的），之后我们改写 process.env 不影响它
const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy

let current: string | undefined | null = null // null = 还没设置过
let onChange: (() => void) | undefined
let timer: NodeJS.Timeout | undefined

async function systemProxy(): Promise<string | undefined> {
  if (envProxy) return envProxy
  // 形如 "PROXY 127.0.0.1:7890; DIRECT"；只支持 HTTP 代理，SOCKS 需在代理软件里开启 HTTP 端口
  const rule = await session.defaultSession.resolveProxy('https://api.trongrid.io')
  const m = rule.match(/(?:PROXY|HTTPS)\s+([^\s;]+)/)
  return m ? `http://${m[1]}` : undefined
}

// 代理软件退出后系统设置里可能还留着代理地址，所以要实际连一下端口
function reachable(proxy: string): Promise<boolean> {
  return new Promise((resolve) => {
    let url: URL
    try {
      url = new URL(proxy)
    } catch {
      return resolve(false)
    }
    const socket = connect({ host: url.hostname, port: Number(url.port || 80), timeout: 1500 })
    const done = (ok: boolean) => {
      socket.destroy()
      resolve(ok)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.once('timeout', () => done(false))
  })
}

function apply(proxy: string | undefined): void {
  if (proxy) {
    process.env.HTTPS_PROXY = proxy // axios（tronweb）读取环境变量
    process.env.HTTP_PROXY = proxy
    process.env.NO_PROXY ||= 'localhost,127.0.0.1,::1'
    setGlobalDispatcher(new EnvHttpProxyAgent())
  } else {
    delete process.env.HTTPS_PROXY
    delete process.env.HTTP_PROXY
    delete process.env.https_proxy
    delete process.env.http_proxy
    setGlobalDispatcher(new Agent())
  }
}

export async function refreshProxy(): Promise<string | undefined> {
  const candidate = await systemProxy().catch(() => undefined)
  const next = candidate && (await reachable(candidate)) ? candidate : undefined
  if (next !== current) {
    const first = current === null
    current = next
    apply(next)
    // 网络路径变了，之前测出来的 RPC 排名不再可靠
    if (!first) onChange?.()
  }
  return next
}

export async function configureProxy(changed?: () => void): Promise<string | undefined> {
  onChange = changed
  const p = await refreshProxy()
  if (!timer) timer = setInterval(() => void refreshProxy(), CHECK_INTERVAL)
  return p
}

export function proxyStatus(): string | undefined {
  return current ?? undefined
}
