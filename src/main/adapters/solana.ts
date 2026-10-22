// Solana 适配：SOL + SPL / Token-2022 代币；收款方没有代币账户时自动创建（ATA）。
import {
  Connection,
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
  TransactionMessage,
  VersionedTransaction
} from '@solana/web3.js'
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getMint
} from '@solana/spl-token'
import type { RiskCheck } from '../../shared/types'
import type { Network } from '../chains/registry'
import { withRpc } from '../rpc'
import type { ChainAdapter, TransferParams } from './types'
import { explainSolana } from './evm'

const conns = new Map<string, Connection>()
function conn(url: string): Connection {
  let c = conns.get(url)
  // 显式用全局 fetch，确保走 proxy.ts 配置的代理
  if (!c) conns.set(url, (c = new Connection(url, { commitment: 'confirmed', fetch: (input, init) => globalThis.fetch(input, init) })))
  return c
}

const on = <T>(n: Network, fn: (c: Connection) => Promise<T>) => withRpc(n.id, (url) => fn(conn(url)))
export const onSolana = on

async function tokenProgram(c: Connection, mint: PublicKey): Promise<PublicKey> {
  const info = await c.getAccountInfo(mint)
  if (!info) throw new Error('代币 mint 不存在')
  return info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
}

async function buildInstructions(c: Connection, p: TransferParams) {
  const from = new PublicKey(p.from)
  const to = new PublicKey(p.to)
  const checks: RiskCheck[] = []
  let rent = 0n
  const ixs: TransactionInstruction[] = []

  if (p.asset.kind === 'native') {
    const [source, target] = await Promise.all([c.getAccountInfo(from), c.getAccountInfo(to)])
    if (source?.data.length) checks.push({ level: 'danger', text: '付款账户带有数据（如 nonce 账户），不能用普通转账转出 SOL' })
    if (!target) {
      const min = BigInt(await c.getMinimumBalanceForRentExemption(0))
      if (p.amount < min) checks.push({ level: 'danger', text: `收款地址是新账户，至少要转 ${Number(min) / 1e9} SOL 才能激活` })
      else checks.push({ level: 'info', text: '收款地址是新账户，本次转账会激活它' })
    }
    ixs.push(SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: p.amount }))
  } else {
    const mint = new PublicKey(p.asset.address)
    const program = await tokenProgram(c, mint)
    const fromAta = getAssociatedTokenAddressSync(mint, from, false, program)
    const toAta = getAssociatedTokenAddressSync(mint, to, true, program)
    if (!(await c.getAccountInfo(toAta))) {
      rent = BigInt(await c.getMinimumBalanceForRentExemption(165))
      checks.push({ level: 'info', text: `收款方还没有 ${p.asset.symbol} 账户，将代为创建（租金约 ${(Number(rent) / 1e9).toFixed(5)} SOL）` })
      ixs.push(createAssociatedTokenAccountIdempotentInstruction(from, toAta, to, mint, program))
    }
    ixs.push(createTransferCheckedInstruction(fromAta, mint, toAta, from, p.amount, p.asset.decimals, [], program))
  }
  return { ixs, rent, checks, from }
}

async function compile(c: Connection, payer: PublicKey, ixs: TransactionInstruction[]) {
  const { blockhash } = await c.getLatestBlockhash()
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message()
  return { msg, tx: new VersionedTransaction(msg) }
}

export const solana: ChainAdapter = {
  isAddress(s) {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false
    try {
      new PublicKey(s)
      return true
    } catch {
      return false
    }
  },
  normalizeAddress: (s) => new PublicKey(s).toBase58(),

  balance(n, owner, asset) {
    return on(n, async (c) => {
      const pk = new PublicKey(owner)
      if (asset.kind === 'native') return BigInt(await c.getBalance(pk))
      const mint = new PublicKey(asset.address)
      const ata = getAssociatedTokenAddressSync(mint, pk, true, await tokenProgram(c, mint))
      try {
        return BigInt((await c.getTokenAccountBalance(ata)).value.amount)
      } catch {
        return 0n // 账户不存在 = 余额 0
      }
    })
  },

  tokenMeta(n, address) {
    return on(n, async (c) => {
      const mint = new PublicKey(address)
      const m = await getMint(c, mint, 'confirmed', await tokenProgram(c, mint))
      return { symbol: `${address.slice(0, 4)}…${address.slice(-4)}`, decimals: m.decimals }
    })
  },

  prepare(p) {
    return on(p.network, async (c) => {
      const { ixs, rent, checks, from } = await buildInstructions(c, p)
      const { msg, tx } = await compile(c, from, ixs)
      const baseFee = BigInt((await c.getFeeForMessage(msg)).value ?? 5000)
      const sim = await c.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true })
      const simulation = sim.value.err
        ? { ok: false, detail: `模拟失败：${explainSolana(sim.value.err, (sim.value.logs ?? []).slice(-1)[0] ?? '')}` }
        : { ok: true, detail: `simulateTransaction 通过，消耗 ${sim.value.unitsConsumed ?? '?'} CU` }
      return { fee: baseFee + rent, simulation, checks }
    })
  },

  send(p, s) {
    return on(p.network, async (c) => {
      const { ixs, from } = await buildInstructions(c, p)
      if (!from.equals(s.solana.keypair.publicKey)) throw new Error('签名账户与付款地址不一致')
      const { tx } = await compile(c, from, ixs)
      tx.sign([s.solana.keypair])
      return c.sendTransaction(tx, { maxRetries: 3 })
    })
  },

  status(n, hash) {
    return on(n, async (c) => {
      const st = (await c.getSignatureStatuses([hash], { searchTransactionHistory: true })).value[0]
      if (!st) return 'pending'
      if (st.err) return 'failed'
      return st.confirmationStatus === 'processed' ? 'pending' : 'success'
    })
  },

  async maxAmount(p) {
    const bal = await solana.balance(p.network, p.from, p.asset)
    if (p.asset.kind === 'token') return bal
    return bal > 10_000n ? bal - 10_000n : 0n
  }
}
