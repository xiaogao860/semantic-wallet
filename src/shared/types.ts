// 主进程与渲染进程共享的类型。渲染进程只拿到展示用的数据，永远拿不到私钥。

export type ChainFamily = 'evm' | 'solana' | 'tron'

export interface NetworkSummary {
  id: string // evm:8453 / solana:devnet / tron:nile
  family: ChainFamily
  name: string
  isTestnet: boolean
  nativeSymbol: string
}

export interface RpcHealth {
  url: string
  ok: boolean
  latencyMs: number
  height?: number
  error?: string
}

export interface NetworkRpcState {
  networkId: string
  checkedAt: number
  ranked: RpcHealth[]
  selected: string[]
}

export type CheckLevel = 'ok' | 'info' | 'warn' | 'danger'

export interface RiskCheck {
  level: CheckLevel
  text: string
}

export interface TransferCard {
  kind: 'transfer'
  id: string
  status: 'ready' | 'blocked' | 'sending' | 'sent' | 'confirmed' | 'failed' | 'cancelled' | 'expired'
  network: NetworkSummary
  from: string
  to: string
  toLabel?: string
  asset: string
  amount: string
  fee: string
  feeSymbol: string
  balanceAfter?: string
  simulation: { ok: boolean; detail: string }
  checks: RiskCheck[]
  hash?: string
  explorerUrl?: string
  error?: string
}

export interface BalanceCard {
  kind: 'balances'
  rows: { network: string; asset: string; amount: string; error?: string }[]
}

export interface NetworkCard {
  kind: 'network'
  network: NetworkSummary
  state: NetworkRpcState
}

export interface InfoCard {
  kind: 'info'
  level: CheckLevel
  text: string
}

export type Card = TransferCard | BalanceCard | NetworkCard | InfoCard

export interface ChatResponse {
  reply: string
  cards: Card[]
}

export type LlmProtocol = 'anthropic' | 'openai'

export interface LlmSettingsView {
  protocol: LlmProtocol
  baseURL: string
  model: string
  hasKey: boolean
}

export interface LlmSettingsInput {
  protocol: LlmProtocol
  baseURL: string
  model: string
  apiKey?: string // 留空表示沿用已保存的 key
}

export type UiMode = 'compact' | 'full'

export interface AppSettingsView {
  uiMode: UiMode
  llm: LlmSettingsView
  savedKeyHosts: string[] // 已保存 key 的接口域名
  defaultNetwork: string
  allowMainnet: boolean
  stableLimit: number
}

export interface LlmConnectResult {
  ok: boolean
  detail: string
  settings: AppSettingsView
}

export interface WalletStatus {
  exists: boolean
  unlocked: boolean
  addresses?: { evm: string; solana: string; tron: string }
}

export interface Contact {
  name: string
  address: string
  family: ChainFamily
}
