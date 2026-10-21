// 收款地址风控：地址投毒（首尾相同中间不同）、首次转账、转给自己。
import type { ChainFamily, RiskCheck } from '../shared/types'

function body(addr: string, family: ChainFamily): string {
  if (family === 'evm') return addr.toLowerCase().replace(/^0x/, '')
  if (family === 'tron') return addr.replace(/^T/, '')
  return addr
}

export function recipientChecks(opts: {
  family: ChainFamily
  from: string
  to: string
  known: { address: string; label: string }[]
}): RiskCheck[] {
  const { family, from, to, known } = opts
  const checks: RiskCheck[] = []
  const t = body(to, family)

  if (t === body(from, family)) checks.push({ level: 'warn', text: '收款地址是你自己的地址' })

  const exact = known.find((k) => body(k.address, family) === t)
  if (!exact) {
    const lookalike = known.find((k) => {
      const b = body(k.address, family)
      return b !== t && b.slice(0, 4) === t.slice(0, 4) && b.slice(-4) === t.slice(-4)
    })
    if (lookalike) {
      checks.push({
        level: 'danger',
        text: `疑似地址投毒：这个地址和「${lookalike.label}」的地址首尾相同、中间不同。请从可信来源重新复制地址`
      })
    } else {
      checks.push({ level: 'warn', text: '首次向这个地址转账，请逐字核对完整地址' })
    }
  }
  return checks
}
