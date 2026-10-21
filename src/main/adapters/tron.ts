// Tron 适配：TRX + TRC20。手续费按带宽 / 能量模型估算（先用账户自有资源，不足部分燃烧 TRX）。
import { TronWeb } from 'tronweb'
import { decodeAbiParameters } from 'viem'
import type { RiskCheck } from '../../shared/types'
import type { Network } from '../chains/registry'
import { withRpc } from '../rpc'
import type { ChainAdapter, TransferParams } from './types'

const tws = new Map<string, TronWeb>()
function tw(url: string): TronWeb {
  let t = tws.get(url)
  if (!t) tws.set(url, (t = new TronWeb({ fullHost: url })))
  return t
}
const on = <T>(n: Network, fn: (t: TronWeb) => Promise<T>) => withRpc(n.id, (url) => fn(tw(url)))

const BW_TRX = 280 // TRX 转账约占带宽字节
const BW_TRC20 = 350

async function chainParams(t: TronWeb): Promise<Record<string, number>> {
  const list = (await t.trx.getChainParameters()) as { key: string; value?: number }[]
  return Object.fromEntries(list.map((p) => [p.key, p.value ?? 0]))
}

async function resources(t: TronWeb, addr: string) {
  const r = (await t.trx.getAccountResources(addr)) as unknown as Record<string, number | undefined>
  const bandwidth = (r.freeNetLimit ?? 0) - (r.freeNetUsed ?? 0) + (r.NetLimit ?? 0) - (r.NetUsed ?? 0)
  const energy = (r.EnergyLimit ?? 0) - (r.EnergyUsed ?? 0)
  return { bandwidth: Math.max(0, bandwidth), energy: Math.max(0, energy) }
}

async function constantCall(t: TronWeb, contract: string, selector: string, params: { type: string; value: unknown }[], issuer: string) {
  const r = (await t.transactionBuilder.triggerConstantContract(contract, selector, {}, params, issuer)) as {
    result?: { result?: boolean; message?: string }
    energy_used?: number
    constant_result?: string[]
  }
  if (!r.result?.result) throw new Error(r.result?.message ? Buffer.from(r.result.message, 'hex').toString() : '合约调用失败')
  return r
}

function safeNumber(v: bigint): number {
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('金额过大')
  return Number(v)
}

function transferParams(p: TransferParams) {
  return [
    { type: 'address', value: p.to },
    { type: 'uint256', value: p.amount.toString() }
  ]
}

async function estimate(t: TronWeb, p: TransferParams) {
  const [cp, res] = await Promise.all([chainParams(t), resources(t, p.from)])
  const bwPrice = BigInt(cp.getTransactionFee ?? 1000)
  const energyPrice = BigInt(cp.getEnergyFee ?? 210)
  const checks: RiskCheck[] = []
  let fee = 0n
  let energyNeeded = 0n
  let simulation = { ok: true, detail: '' }

  if (p.asset.kind === 'native') {
    if (res.bandwidth < BW_TRX) fee += BigInt(BW_TRX) * bwPrice
    const target = (await t.trx.getAccount(p.to)) as { address?: string }
    if (!target?.address) {
      fee += BigInt((cp.getCreateNewAccountFeeInSystemContract ?? 1_000_000) + (cp.getCreateAccountFee ?? 100_000))
      checks.push({ level: 'info', text: '收款地址未激活，本次转账会激活它（额外约 1.1 TRX）' })
    }
    simulation.detail = `带宽可用 ${res.bandwidth}，需要约 ${BW_TRX}`
  } else {
    if (res.bandwidth < BW_TRC20) fee += BigInt(BW_TRC20) * bwPrice
    try {
      const r = await constantCall(t, p.asset.address, 'transfer(address,uint256)', transferParams(p), p.from)
      if (!r.constant_result?.[0]?.endsWith('1')) throw new Error('代币合约返回 false')
      energyNeeded = BigInt(r.energy_used ?? 65_000)
      simulation.detail = `triggerConstantContract 模拟通过，需要能量 ${energyNeeded}（可用 ${res.energy}）`
    } catch (e) {
      energyNeeded = 130_000n
      simulation = { ok: false, detail: `模拟失败：${(e as Error).message}`.slice(0, 200) }
    }
    const burn = energyNeeded > BigInt(res.energy) ? energyNeeded - BigInt(res.energy) : 0n
    fee += burn * energyPrice
    if (burn > 0n) checks.push({ level: 'info', text: `能量不足，将燃烧约 ${(Number(burn * energyPrice) / 1e6).toFixed(2)} TRX 支付能量` })
  }
  const feeLimit = clamp((energyNeeded * energyPrice * 3n) / 2n, 30_000_000n, 200_000_000n)
  return { fee, checks, simulation, feeLimit }
}

function clamp(v: bigint, lo: bigint, hi: bigint): bigint {
  return v < lo ? lo : v > hi ? hi : v
}

export const tron: ChainAdapter = {
  isAddress: (s) => /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(s) && TronWeb.isAddress(s),
  normalizeAddress: (s) => s,

  balance(n, owner, asset) {
    return on(n, async (t) => {
      if (asset.kind === 'native') return BigInt(await t.trx.getBalance(owner))
      const r = await constantCall(t, asset.address, 'balanceOf(address)', [{ type: 'address', value: owner }], owner)
      return BigInt(`0x${r.constant_result?.[0] || '0'}`)
    })
  },

  tokenMeta(n, address) {
    return on(n, async (t) => {
      const [d, s] = await Promise.all([
        constantCall(t, address, 'decimals()', [], address),
        constantCall(t, address, 'symbol()', [], address)
      ])
      const [symbol] = decodeAbiParameters([{ type: 'string' }], `0x${s.constant_result![0]}`)
      return { symbol, decimals: Number(BigInt(`0x${d.constant_result![0]}`)) }
    })
  },

  prepare(p) {
    return on(p.network, async (t) => {
      const { fee, checks, simulation } = await estimate(t, p)
      if (p.asset.kind === 'native') {
        const bal = BigInt(await t.trx.getBalance(p.from))
        if (bal < p.amount + fee) Object.assign(simulation, { ok: false, detail: 'TRX 余额不足以支付金额和手续费' })
        else simulation.detail = `余额校验通过，${simulation.detail}`
      }
      return { fee, simulation, checks }
    })
  },

  send(p, s) {
    return on(p.network, async (t) => {
      if (s.tron.address !== p.from) throw new Error('签名账户与付款地址不一致')
      let tx
      if (p.asset.kind === 'native') {
        tx = await t.transactionBuilder.sendTrx(p.to, safeNumber(p.amount), p.from)
      } else {
        const { feeLimit } = await estimate(t, p)
        const r = await t.transactionBuilder.triggerSmartContract(
          p.asset.address, 'transfer(address,uint256)', { feeLimit: safeNumber(feeLimit) }, transferParams(p), p.from
        )
        if (!r.result?.result) throw new Error('构造 TRC20 交易失败')
        tx = r.transaction
      }
      const signed = await t.trx.sign(tx, s.tron.privateKey)
      const res = (await t.trx.sendRawTransaction(signed)) as { result?: boolean; txid?: string; code?: string; message?: string }
      if (!res.result) {
        const msg = res.message ? Buffer.from(res.message, 'hex').toString() : res.code
        throw new Error(`广播失败：${msg}`)
      }
      return res.txid ?? (signed as { txID: string }).txID
    })
  },

  status(n, hash) {
    return on(n, async (t) => {
      const info = (await t.trx.getTransactionInfo(hash)) as { blockNumber?: number; result?: string; receipt?: { result?: string } }
      if (!info?.blockNumber) return 'pending'
      if (info.result === 'FAILED' || (info.receipt?.result && info.receipt.result !== 'SUCCESS')) return 'failed'
      return 'success'
    })
  },

  async maxAmount(p) {
    const bal = await tron.balance(p.network, p.from, p.asset)
    if (p.asset.kind === 'token') return bal
    const reserve = 1_500_000n // 留 1.5 TRX 给带宽 / 激活费
    return bal > reserve ? bal - reserve : 0n
  }
}
