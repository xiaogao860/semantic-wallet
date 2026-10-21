// 网络代理：主进程的 fetch / axios 默认不走系统代理，国内网络下大部分海外 RPC 会超时。
// 优先用环境变量里的代理，否则读取系统代理设置（Electron resolveProxy），统一设置给 fetch 和 axios。
import { session } from 'electron'
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici'

export async function configureProxy(): Promise<string | undefined> {
  let proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
  if (!proxy) {
    // 形如 "PROXY 127.0.0.1:7890; DIRECT"；只支持 HTTP 代理，SOCKS 需在代理软件里开启 HTTP 端口
    const rule = await session.defaultSession.resolveProxy('https://api.trongrid.io')
    const m = rule.match(/(?:PROXY|HTTPS)\s+([^\s;]+)/)
    if (m) proxy = `http://${m[1]}`
  }
  if (!proxy) return undefined
  process.env.HTTPS_PROXY ||= proxy // axios（tronweb）读取环境变量
  process.env.HTTP_PROXY ||= proxy
  process.env.NO_PROXY ||= 'localhost,127.0.0.1,::1'
  setGlobalDispatcher(new EnvHttpProxyAgent())
  return proxy
}
