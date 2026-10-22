// 联网搜索：DuckDuckGo（需代理）/ Bing（国内可用），以及网页正文提取。
// 搜到的内容只作为"线索"交给模型提取，关键参数一律再用链上 RPC 验证。
import { proxyStatus } from './proxy'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36'

export interface SearchResult {
  url: string
  title: string
  snippet: string
}

async function getText(url: string, timeout = 12_000): Promise<string> {
  const res = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.8,zh-CN;q=0.6' }, signal: AbortSignal.timeout(timeout), redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const text = await res.text()
  return text.slice(0, 1_500_000)
}

const decode = (s: string) =>
  s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
const stripTags = (s: string) => decode(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()

async function duckduckgo(q: string): Promise<SearchResult[]> {
  const html = await getText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`)
  const out: SearchResult[] = []
  const re = /class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
  for (let m = re.exec(html); m && out.length < 8; m = re.exec(html)) {
    const href = decode(m[1])
    const real = /[?&]uddg=([^&]+)/.exec(href)
    const url = real ? decodeURIComponent(real[1]) : href.startsWith('//') ? `https:${href}` : href
    if (url.startsWith('http')) out.push({ url, title: stripTags(m[2]), snippet: stripTags(m[3]) })
  }
  return out
}

async function bing(q: string): Promise<SearchResult[]> {
  const html = await getText(`https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=en&ensearch=1`)
  const out: SearchResult[] = []
  for (const block of html.split('<li class="b_algo"').slice(1)) {
    const a = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block)
    if (!a) continue
    let url = decode(a[1])
    // Bing 的跳转链接：u=a1 + base64url
    const u = /[?&]u=a1([^&]+)/.exec(url)
    if (u) url = Buffer.from(u[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    const p = /<p[^>]*>([\s\S]*?)<\/p>/.exec(block)
    if (url.startsWith('http')) out.push({ url, title: stripTags(a[2]), snippet: p ? stripTags(p[1]) : '' })
    if (out.length >= 8) break
  }
  return out
}

// 有代理先用 DuckDuckGo，没有先用 Bing；一个失败或没结果就换另一个
export async function webSearch(q: string): Promise<SearchResult[]> {
  const engines = proxyStatus() ? [duckduckgo, bing] : [bing, duckduckgo]
  for (const engine of engines) {
    const r = await engine(q).catch(() => [])
    if (r.length) return r
  }
  return []
}

// 网页正文：去掉脚本样式和标签，保留文字（链参数常在表格、代码块里）
export async function pageText(url: string, max = 8_000): Promise<string> {
  const html = await getText(url, 10_000)
  // Next.js 站点（如 chainlist）把数据放在 __NEXT_DATA__ 里，单独保留
  const nextData = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ''
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h\d)[^>]*>/gi, '\n')
  const text = decode(body.replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim()
  return (nextData ? `${text.slice(0, max / 2)}\n[页面数据]\n${nextData.slice(0, max / 2)}` : text).slice(0, max)
}
