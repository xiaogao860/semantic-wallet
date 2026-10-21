// WalletConnect 跑在界面进程：长连接走浏览器内核，自动使用系统代理。
// 这里只负责收发；请求一律交给主进程解码、风控、签名。
import { type IWalletKit, WalletKit, type WalletKitTypes } from '@reown/walletkit'
import { Core } from '@walletconnect/core'
import { buildApprovedNamespaces, getSdkError } from '@walletconnect/utils'
import type { Card, DappInfo, DappProposalCard, DappRequestCard } from '../../shared/types'
import { api } from './api'

const METHODS = [
  'eth_sendTransaction',
  'personal_sign',
  'eth_sign',
  'eth_signTypedData',
  'eth_signTypedData_v3',
  'eth_signTypedData_v4',
  'wallet_switchEthereumChain',
  'wallet_addEthereumChain',
  'eth_accounts',
  'eth_requestAccounts',
  'eth_chainId'
]
const EVENTS = ['chainChanged', 'accountsChanged']
const METADATA = {
  name: '语义钱包',
  description: '一句话完成链上操作的自托管钱包',
  url: 'https://github.com/xiaogao860/semantic-wallet',
  icons: ['https://raw.githubusercontent.com/xiaogao860/semantic-wallet/main/build/icon.png']
}

export interface DappSession {
  topic: string
  dapp: DappInfo
  chains: string[]
}

type Proposal = WalletKitTypes.SessionProposal
type Namespaces = Record<string, { chains?: string[] }>

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function dappOf(meta?: { name?: string; url?: string; icons?: string[] }): DappInfo {
  const url = meta?.url ?? ''
  return { name: meta?.name || hostOf(url) || '未知网站', url, icon: meta?.icons?.find((i) => i.startsWith('https://')) }
}

// 命名空间里请求的全部链（兼容 "eip155" 和 "eip155:1" 两种写法）
function chainsOf(...groups: (Namespaces | undefined)[]): string[] {
  const out: string[] = []
  for (const g of groups) {
    for (const [key, ns] of Object.entries(g ?? {})) out.push(...(ns.chains ?? (key.includes(':') ? [key] : [])))
  }
  return [...new Set(out)]
}

export const WC_URI = /wc:[0-9a-f]{20,}@2\?\S+/i

class WalletConnectManager {
  private kit: IWalletKit | null = null
  private projectId = ''
  private address = ''
  private proposals = new Map<number, Proposal>()
  private cardListeners = new Set<(c: Card) => void>()
  private changeListeners = new Set<() => void>()
  status: 'off' | 'connecting' | 'ready' | 'error' = 'off'
  error = ''

  onCard(fn: (c: Card) => void): () => void {
    this.cardListeners.add(fn)
    return () => this.cardListeners.delete(fn)
  }

  onChange(fn: () => void): () => void {
    this.changeListeners.add(fn)
    return () => this.changeListeners.delete(fn)
  }

  private push(card: Card): void {
    for (const fn of this.cardListeners) fn(card)
  }

  private changed(): void {
    for (const fn of this.changeListeners) fn()
  }

  async init(projectId: string, address: string): Promise<void> {
    this.address = address
    if (!projectId || projectId === this.projectId) return
    this.projectId = projectId
    this.status = 'connecting'
    this.changed()
    try {
      const core = new Core({ projectId, telemetryEnabled: false })
      const kit = await WalletKit.init({ core, metadata: METADATA })
      kit.on('session_proposal', (p) => void this.onProposal(p))
      kit.on('session_request', (r) => void this.onRequest(r))
      kit.on('session_delete', () => this.changed())
      kit.on('proposal_expire', ({ id }) => this.proposals.delete(id))
      this.kit = kit
      this.status = 'ready'
      this.error = ''
    } catch (e) {
      this.status = 'error'
      this.error = (e as Error).message
      this.projectId = ''
    }
    this.changed()
  }

  private need(): IWalletKit {
    if (this.kit) return this.kit
    if (this.status === 'error') throw new Error(`WalletConnect 初始化失败：${this.error}`)
    throw new Error('还没有配置 WalletConnect 项目 ID：在「设置 → 连接网站」里填写')
  }

  // 项目 ID 无效或网络不通时 pair 可能一直挂着，给个超时和明确提示
  async pair(uri: string): Promise<void> {
    const kit = this.need()
    await Promise.race([
      kit.pair({ uri }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('连接超时：请检查 WalletConnect 项目 ID 是否正确、网络是否通畅，或在网站上刷新连接码再试')), 20_000)
      )
    ])
  }

  // ---------- 连接请求 ----------

  private async onProposal(p: Proposal): Promise<void> {
    this.proposals.set(p.id, p)
    const { requiredNamespaces, optionalNamespaces } = p.params
    const all = chainsOf(requiredNamespaces, optionalNamespaces)
    const info = await api.dappChains(all.filter((c) => c.startsWith('eip155:')))
    const required = chainsOf(requiredNamespaces)
    const v = p.verifyContext?.verified
    const card: DappProposalCard = {
      kind: 'dapp_proposal',
      id: p.id,
      dapp: dappOf(p.params.proposer.metadata),
      networks: info.supported.map((s) => s.name),
      unsupported: required.filter((c) => !info.supported.some((s) => s.caip === c)),
      verified: v?.validation ?? 'UNKNOWN',
      isScam: v?.isScam,
      status: 'ready'
    }
    this.push(card)
  }

  async approveProposal(id: number): Promise<void> {
    const kit = this.need()
    const p = this.proposals.get(id)
    if (!p) throw new Error('连接请求已过期，请在网站上重新连接')
    const all = chainsOf(p.params.requiredNamespaces, p.params.optionalNamespaces).filter((c) => c.startsWith('eip155:'))
    const info = await api.dappChains(all)
    let chains = info.supported.map((s) => s.caip)
    if (!chains.length) {
      const def = (await api.settings()).defaultNetwork
      chains = [def.startsWith('evm:') ? `eip155:${def.slice(4)}` : 'eip155:1']
    }
    const namespaces = buildApprovedNamespaces({
      proposal: p.params,
      supportedNamespaces: {
        eip155: { chains, methods: METHODS, events: EVENTS, accounts: chains.map((c) => `${c}:${this.address}`) }
      }
    })
    await kit.approveSession({ id, namespaces })
    this.proposals.delete(id)
    this.changed()
  }

  async rejectProposal(id: number): Promise<void> {
    this.proposals.delete(id)
    await this.need().rejectSession({ id, reason: getSdkError('USER_REJECTED') })
  }

  // ---------- 签名 / 交易请求 ----------

  private async respond(topic: string, id: number, result: unknown): Promise<void> {
    await this.need().respondSessionRequest({ topic, response: { id, jsonrpc: '2.0', result } })
  }

  private async respondError(topic: string, id: number, code: number, message: string): Promise<void> {
    await this.need().respondSessionRequest({ topic, response: { id, jsonrpc: '2.0', error: { code, message } } })
  }

  private async onRequest(r: WalletKitTypes.SessionRequest): Promise<void> {
    const { topic, id, params, verifyContext } = r
    const { request, chainId } = params
    const session = this.need().getActiveSessions()[topic]
    const dapp = dappOf(session?.peer.metadata)
    const p = request.params as unknown[]

    try {
      switch (request.method) {
        case 'eth_accounts':
        case 'eth_requestAccounts':
          return await this.respond(topic, id, [this.address])
        case 'eth_chainId':
          return await this.respond(topic, id, `0x${Number(chainId.split(':')[1]).toString(16)}`)
        case 'wallet_switchEthereumChain':
        case 'wallet_addEthereumChain': {
          const num = Number.parseInt(String((p?.[0] as { chainId?: string })?.chainId ?? '0x0'), 16)
          const target = `eip155:${num}`
          const info = await api.dappChains([target])
          if (!info.supported.length) return await this.respondError(topic, id, 4902, `语义钱包不支持链 ${num}`)
          if (request.method === 'wallet_switchEthereumChain') {
            await this.ensureChain(topic, target)
            await this.need().emitSessionEvent({ topic, event: { name: 'chainChanged', data: num }, chainId: target })
            this.push({ kind: 'info', level: 'info', text: `${dapp.name} 切换到了 ${info.supported[0].name}` })
          }
          return await this.respond(topic, id, null)
        }
      }

      const card = await api.dappAnalyze({
        wcId: id, topic, chainId, method: request.method, params: request.params, dapp,
        verified: verifyContext?.verified?.validation, isScam: verifyContext?.verified?.isScam
      })
      this.push(card)
      // 被拦截的请求直接告诉网站，不让它一直等
      if (card.status === 'blocked') await this.respondError(topic, id, 4001, '语义钱包风控拦截了这个请求')
    } catch (e) {
      this.push({ kind: 'info', level: 'danger', text: `处理 ${dapp.name} 的请求失败：${(e as Error).message}` })
      await this.respondError(topic, id, 5000, '钱包处理请求失败').catch(() => undefined)
    }
  }

  private async ensureChain(topic: string, caip: string): Promise<void> {
    const kit = this.need()
    const s = kit.getActiveSessions()[topic]
    const ns = s?.namespaces.eip155
    if (!ns || ns.chains?.includes(caip)) return
    await kit.updateSession({
      topic,
      namespaces: {
        ...s.namespaces,
        eip155: { ...ns, chains: [...(ns.chains ?? []), caip], accounts: [...ns.accounts, `${caip}:${this.address}`] }
      }
    })
  }

  async approveRequest(card: DappRequestCard): Promise<{ result: string; explorerUrl?: string }> {
    try {
      const r = await api.dappExecute(card.id)
      await this.respond(card.topic, card.wcId, r.result)
      return r
    } catch (e) {
      await this.respondError(card.topic, card.wcId, 5000, '钱包签名失败').catch(() => undefined)
      throw e
    }
  }

  async rejectRequest(card: DappRequestCard): Promise<void> {
    await api.dappReject(card.id)
    await this.respondError(card.topic, card.wcId, 4001, '用户拒绝了请求')
  }

  // ---------- 会话 ----------

  sessions(): DappSession[] {
    if (!this.kit) return []
    return Object.values(this.kit.getActiveSessions()).map((s: ReturnType<IWalletKit['getActiveSessions']>[string]) => ({
      topic: s.topic,
      dapp: dappOf(s.peer.metadata),
      chains: s.namespaces.eip155?.chains ?? []
    }))
  }

  async disconnect(topic: string): Promise<void> {
    await this.need().disconnectSession({ topic, reason: getSdkError('USER_DISCONNECTED') })
    this.changed()
  }

  // 按名字断开（对话里说"断开 Uniswap"），target 为空时断开全部
  async disconnectMatching(target: string | null): Promise<string[]> {
    const t = target?.toLowerCase()
    const hits = this.sessions().filter((s) => !t || s.dapp.name.toLowerCase().includes(t) || s.dapp.url.toLowerCase().includes(t))
    for (const s of hits) await this.disconnect(s.topic)
    return hits.map((s) => s.dapp.name)
  }
}

export const wc = new WalletConnectManager()
