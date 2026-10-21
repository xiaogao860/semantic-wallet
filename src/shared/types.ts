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

// ---------- 连接网站（WalletConnect） ----------

export interface DappInfo {
  name: string
  url: string
  icon?: string
}

export interface DappField {
  label: string
  value: string
  mono?: boolean
}

// 网站发来的请求（签名 / 交易），由主进程解码后生成
export interface DappRequestCard {
  kind: 'dapp_request'
  id: string
  wcId: number
  topic: string
  dapp: DappInfo
  method: string
  title: string
  network?: NetworkSummary
  fields: DappField[]
  checks: RiskCheck[]
  simulation?: { ok: boolean; detail: string }
  aiSummary?: string
  status: 'ready' | 'blocked' | 'sending' | 'done' | 'rejected' | 'failed' | 'expired'
  result?: string
  explorerUrl?: string
  error?: string
}

// 网站请求连接
export interface DappProposalCard {
  kind: 'dapp_proposal'
  id: number
  dapp: DappInfo
  networks: string[]
  unsupported: string[]
  verified: 'VALID' | 'INVALID' | 'UNKNOWN'
  isScam?: boolean
  status: 'ready' | 'approved' | 'rejected' | 'failed' | 'expired'
  error?: string
}

// 对话里说"断开所有网站""连了哪些网站"，交给界面里的 WalletConnect 执行
export interface DappCommandCard {
  kind: 'dapp_command'
  op: 'list' | 'disconnect'
  target: string | null
}

export interface DappRequestInput {
  wcId: number
  topic: string
  chainId: string // CAIP-2，如 eip155:8453
  method: string
  params: unknown
  dapp: DappInfo
  verified?: 'VALID' | 'INVALID' | 'UNKNOWN'
  isScam?: boolean
}

// 兑换 / 跨链
export interface RouteCard {
  kind: 'route'
  id: string
  mode: 'swap' | 'bridge'
  status: 'ready' | 'blocked' | 'sending' | 'sent' | 'confirmed' | 'failed' | 'cancelled' | 'expired'
  provider: string
  from: { network: NetworkSummary; asset: string; amount: string }
  to: { network: NetworkSummary; asset: string; amount: string; min?: string; address: string }
  rate?: string
  duration?: string
  fees: { label: string; value: string }[]
  steps: string[]
  simulation: { ok: boolean; detail: string }
  checks: RiskCheck[]
  progress?: string
  hash?: string
  explorerUrl?: string
  destHash?: string
  destExplorerUrl?: string
  error?: string
}

export type Card = TransferCard | BalanceCard | NetworkCard | InfoCard | DappRequestCard | DappProposalCard | DappCommandCard | RouteCard

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
  wcProjectId: string
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
