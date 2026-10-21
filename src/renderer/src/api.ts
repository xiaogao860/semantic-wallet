import type {
  AppSettingsView,
  BalanceCard,
  ChatResponse,
  Contact,
  DappRequestCard,
  DappRequestInput,
  LlmConnectResult,
  LlmSettingsInput,
  NetworkRpcState,
  NetworkSummary,
  TransferCard,
  UiMode,
  WalletStatus
} from '../../shared/types'

declare global {
  interface Window {
    wallet: { call<T>(channel: string, ...args: unknown[]): Promise<T>; platform: string }
  }
}

const c = <T,>(channel: string, ...args: unknown[]) => window.wallet.call<T>(channel, ...args)

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
