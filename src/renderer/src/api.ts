import type {
  AppSettingsView,
  BalanceCard,
  Card,
  ChatResponse,
  Contact,
  DappRequestCard,
  DappRequestInput,
  LimitOrderCard,
  LlmConnectResult,
  LlmSettingsInput,
  NetworkRpcState,
  NetworkSummary,
  RouteCard,
  TransferCard,
  UiMode,
  WalletStatus
} from '../../shared/types'

declare global {
  interface Window {
    wallet: { call<T>(channel: string, ...args: unknown[]): Promise<T>; onProgress(cb: (text: string) => void): () => void; platform: string }
  }
}

const c = <T,>(channel: string, ...args: unknown[]) => window.wallet.call<T>(channel, ...args)

export const onProgress = (cb: (text: string) => void) => window.wallet.onProgress(cb)

export type FeaturedNetwork = NetworkSummary & { state?: NetworkRpcState }

export const api = {
  status: () => c<WalletStatus>('wallet:status'),
  newMnemonic: () => c<string>('wallet:newMnemonic'),
  create: (mnemonic: string, password: string) => c<WalletStatus>('wallet:create', mnemonic, password),
  unlock: (password: string) => c<WalletStatus>('wallet:unlock', password),
  lock: () => c<WalletStatus>('wallet:lock'),

  chat: (text: string) => c<ChatResponse>('chat:send', text),
  confirm: (id: string) => c<TransferCard>('tx:confirm', id),
  cancel: (id: string) => c<void>('tx:cancel', id),
  txStatus: (id: string) => c<TransferCard | undefined>('tx:status', id),
  routeConfirm: (id: string) => c<RouteCard>('route:confirm', id),
  routeCancel: (id: string) => c<void>('route:cancel', id),
  routeStatus: (id: string) => c<RouteCard | undefined>('route:status', id),
  discoveryConfirm: (id: string) => c<{ network: NetworkSummary; cards: Card[] }>('discovery:confirm', id),
  discoveryCancel: (id: string) => c<void>('discovery:cancel', id),
  tokenChoose: (id: string, key: string) => c<Card[]>('token:choose', id, key),
  limitConfirm: (id: string) => c<LimitOrderCard>('limit:confirm', id),
  limitCancel: (id: string) => c<void>('limit:cancel', id),
  limitStatus: (id: string) => c<LimitOrderCard | undefined>('limit:status', id),
  cancelOrder: (networkId: string, uid: string) => c<void>('orders:cancel', networkId, uid),

  settings: () => c<AppSettingsView>('settings:get'),
  setMode: (mode: UiMode) => c<AppSettingsView>('window:setMode', mode),
  defaultBalances: () => c<BalanceCard>('balances:default'),
  connectLlm: (input: LlmSettingsInput) => c<LlmConnectResult>('llm:connect', input),
  listModels: (input: LlmSettingsInput) => c<{ models: string[]; error?: string }>('llm:models', input),
  setPrefs: (p: Partial<Pick<AppSettingsView, 'defaultNetwork' | 'allowMainnet' | 'stableLimit' | 'wcProjectId'>>) => c<AppSettingsView>('settings:setPrefs', p),

  featured: () => c<FeaturedNetwork[]>('networks:featured'),
  networkCount: () => c<number>('networks:count'),
  probe: (id: string) => c<NetworkRpcState>('networks:probe', id),

  contacts: () => c<Contact[]>('contacts:list'),

  dappChains: (caips: string[]) => c<{ supported: { caip: string; name: string }[]; unsupported: string[] }>('dapp:chains', caips),
  dappAnalyze: (input: DappRequestInput) => c<DappRequestCard>('dapp:analyze', input),
  dappExecute: (id: string) => c<{ result: string; explorerUrl?: string }>('dapp:execute', id),
  dappReject: (id: string) => c<void>('dapp:reject', id)
}
