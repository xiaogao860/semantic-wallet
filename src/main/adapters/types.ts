import type { RiskCheck } from '../../shared/types'
import type { Network } from '../chains/registry'
import type { Signers } from '../keystore'

// 已解析的资产：native 或代币（合约 / mint）
export type Asset =
  | { kind: 'native'; symbol: string; decimals: number }
  | { kind: 'token'; symbol: string; decimals: number; address: string; listed: boolean }

export interface TransferParams {
  network: Network
  from: string
  to: string
  asset: Asset
  amount: bigint // 最小单位
}

export interface Prepared {
  fee: bigint // 以原生币最小单位计的手续费上限
  simulation: { ok: boolean; detail: string }
  checks: RiskCheck[] // 链相关的额外检查（如收款方是合约、Tron 账户未激活）
}

export interface ChainAdapter {
  isAddress(s: string): boolean
  normalizeAddress(s: string): string
  balance(network: Network, owner: string, asset: Asset): Promise<bigint>
  // 读链上代币信息（用于非白名单代币或核对白名单 decimals）
  tokenMeta(network: Network, address: string): Promise<{ symbol: string; decimals: number }>
  prepare(p: TransferParams): Promise<Prepared>
  // 签名并广播：必须按 p 中的参数重新构造，确保签的就是用户确认的那笔
  send(p: TransferParams, signers: Signers): Promise<string>
  status(network: Network, hash: string): Promise<'pending' | 'success' | 'failed'>
  // 最大可转数量（原生币需扣除手续费）
  maxAmount(p: Omit<TransferParams, 'amount'>): Promise<bigint>
}
