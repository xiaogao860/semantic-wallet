// 自托管私钥库：一套 BIP39 助记词派生 EVM / Solana / Tron 三类账户。
// 助记词用 scrypt + AES-256-GCM 加密落盘；解锁后私钥只存在主进程内存，闲置自动锁定。
import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync } from 'node:crypto'
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { HDKey } from '@scure/bip32'
import { privateKeyToAccount } from 'viem/accounts'
import { Keypair } from '@solana/web3.js'
import { TronWeb } from 'tronweb'
import { fileExists, readJson, writeJson } from './store'

const VAULT = 'vault.json'
const SCRYPT = { N: 1 << 17, r: 8, p: 1 }
const AUTO_LOCK_MS = 15 * 60 * 1000

interface VaultFile {
  version: 1
  kdf: { salt: string; N: number; r: number; p: number }
  iv: string
  tag: string
  ciphertext: string
}

export interface Signers {
  evm: { privateKey: `0x${string}`; address: `0x${string}` }
  solana: { keypair: Keypair; address: string }
  tron: { privateKey: string; address: string } // privateKey 为不带 0x 的 hex
}

let unlocked: Signers | null = null
let lockTimer: NodeJS.Timeout | null = null

function deriveKey(password: string, salt: Buffer, kdf = SCRYPT): Buffer {
  return scryptSync(password, salt, 32, { ...kdf, maxmem: 256 * 1024 * 1024 })
}

// SLIP-0010 ed25519 派生（Phantom / Solflare 使用的 m/44'/501'/0'/0'）
export function slip10Ed25519(seed: Uint8Array, path: number[]): Buffer {
  let I = createHmac('sha512', 'ed25519 seed').update(seed).digest()
  let key = I.subarray(0, 32)
  let chain = I.subarray(32)
  for (const index of path) {
    const data = Buffer.alloc(37)
    data[0] = 0
    key.copy(data, 1)
    data.writeUInt32BE((index | 0x80000000) >>> 0, 33)
    I = createHmac('sha512', chain).update(data).digest()
    key = I.subarray(0, 32)
    chain = I.subarray(32)
  }
  return Buffer.from(key)
}

function deriveSigners(mnemonic: string): Signers {
  const seed = mnemonicToSeedSync(mnemonic)
  const root = HDKey.fromMasterSeed(seed)

  const evmKey = root.derive("m/44'/60'/0'/0/0").privateKey!
  const evmHex = `0x${Buffer.from(evmKey).toString('hex')}` as const
  const evmAccount = privateKeyToAccount(evmHex)

  const tronKey = Buffer.from(root.derive("m/44'/195'/0'/0/0").privateKey!).toString('hex')
  const tronAddress = TronWeb.address.fromPrivateKey(tronKey)
  if (!tronAddress) throw new Error('Tron 地址派生失败')

  const solKeypair = Keypair.fromSeed(slip10Ed25519(seed, [44, 501, 0, 0]))

  return {
    evm: { privateKey: evmHex, address: evmAccount.address },
    solana: { keypair: solKeypair, address: solKeypair.publicKey.toBase58() },
    tron: { privateKey: tronKey, address: tronAddress }
  }
}

function touch(): void {
  if (lockTimer) clearTimeout(lockTimer)
  lockTimer = setTimeout(lock, AUTO_LOCK_MS)
}

export function vaultExists(): boolean {
  return fileExists(VAULT)
}

export function isUnlocked(): boolean {
  return unlocked !== null
}

export function newMnemonic(): string {
  return generateMnemonic(wordlist, 128)
}

export function saveVault(mnemonic: string, password: string): void {
  const normalized = mnemonic.trim().toLowerCase().split(/\s+/).join(' ')
  if (!validateMnemonic(normalized, wordlist)) throw new Error('助记词无效')
  if (password.length < 8) throw new Error('密码至少 8 位')
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', deriveKey(password, salt), iv)
  const ciphertext = Buffer.concat([cipher.update(normalized, 'utf8'), cipher.final()])
  const file: VaultFile = {
    version: 1,
    kdf: { salt: salt.toString('hex'), ...SCRYPT },
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    ciphertext: ciphertext.toString('hex')
  }
  writeJson(VAULT, file)
  unlocked = deriveSigners(normalized)
  touch()
}

export function unlock(password: string): void {
  const file = readJson<VaultFile | null>(VAULT, null)
  if (!file) throw new Error('还没有钱包')
  const { salt, N, r, p } = file.kdf
  const decipher = createDecipheriv(
    'aes-256-gcm',
    deriveKey(password, Buffer.from(salt, 'hex'), { N, r, p }),
    Buffer.from(file.iv, 'hex')
  )
  decipher.setAuthTag(Buffer.from(file.tag, 'hex'))
  let mnemonic: string
  try {
    mnemonic = Buffer.concat([decipher.update(Buffer.from(file.ciphertext, 'hex')), decipher.final()]).toString('utf8')
  } catch {
    throw new Error('密码错误')
  }
  unlocked = deriveSigners(mnemonic)
  touch()
}

export function lock(): void {
  unlocked = null
  if (lockTimer) clearTimeout(lockTimer)
  lockTimer = null
}

export function signers(): Signers {
  if (!unlocked) throw new Error('钱包已锁定，请先解锁')
  touch()
  return unlocked
}

export function addresses(): { evm: string; solana: string; tron: string } | undefined {
  if (!unlocked) return undefined
  return { evm: unlocked.evm.address, solana: unlocked.solana.address, tron: unlocked.tron.address }
}
