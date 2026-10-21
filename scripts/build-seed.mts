// 从 chainlist 生成内置 EVM 链种子：离线或 chainlist 不可达时兜底。
// 用法：npm run seed
import { writeFileSync } from 'node:fs'

const KEEP_TESTNETS = [11155111, 84532, 421614, 11155420, 97, 80002, 43113, 17000]
const TOP_MAINNETS = 60
const MAX_RPCS = 12

type Raw = {
  name: string; chainId: number; shortName?: string; chainSlug?: string; isTestnet?: boolean
  status?: string; tvl?: number; nativeCurrency: { symbol: string; decimals: number }
  rpc: ({ url: string } | string)[]; explorers?: { url: string }[]
}

const res = await fetch('https://chainlist.org/rpcs.json')
const all = (await res.json()) as Raw[]
const usable = all.filter((c) => c.status !== 'deprecated' && c.rpc?.length)
const mainnets = usable.filter((c) => !c.isTestnet).sort((a, b) => (b.tvl ?? 0) - (a.tvl ?? 0)).slice(0, TOP_MAINNETS)
const testnets = usable.filter((c) => KEEP_TESTNETS.includes(c.chainId))

const seed = [...mainnets, ...testnets].map((c) => ({
  name: c.name,
  chainId: c.chainId,
  shortName: c.shortName,
  chainSlug: c.chainSlug,
  isTestnet: !!c.isTestnet,
  tvl: Math.round(c.tvl ?? 0),
  nativeCurrency: { symbol: c.nativeCurrency.symbol, decimals: c.nativeCurrency.decimals },
  rpc: c.rpc
    .map((r) => (typeof r === 'string' ? r : r.url))
    .filter((u) => u.startsWith('https://') && !u.includes('${'))
    .slice(0, MAX_RPCS),
  explorers: (c.explorers ?? []).slice(0, 1).map((e) => ({ url: e.url }))
}))

writeFileSync(new URL('../src/main/chains/evm-seed.json', import.meta.url), JSON.stringify(seed))
console.log(`写入 ${seed.length} 条链（${mainnets.length} 主网 + ${testnets.length} 测试网）`)
