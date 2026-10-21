// 代币白名单：符号 → 合约地址只从这里查，绝不让 LLM 生成合约地址。
// 列表里的 EVM / Tron 代币在使用时还会链上核对 decimals，不一致直接拒绝。

export interface TokenInfo {
  symbol: string
  address: string // EVM 合约 / Solana mint / Tron 合约
  decimals: number
}

const T = (symbol: string, address: string, decimals: number): TokenInfo => ({ symbol, address, decimals })

export const TOKENS: Record<string, TokenInfo[]> = {
  'evm:1': [T('USDC', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 6), T('USDT', '0xdAC17F958D2ee523a2206206994597C13D831ec7', 6)],
  'evm:8453': [T('USDC', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 6)],
  'evm:42161': [T('USDC', '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 6), T('USDT', '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', 6)],
  'evm:10': [T('USDC', '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', 6), T('USDT', '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', 6)],
  'evm:137': [T('USDC', '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', 6), T('USDT', '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', 6)],
  'evm:56': [T('USDC', '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', 18), T('USDT', '0x55d398326f99059fF775485246999027B3197955', 18)],
  'evm:43114': [T('USDC', '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', 6), T('USDT', '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', 6)],
  'evm:11155111': [T('USDC', '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', 6)],
  'evm:84532': [T('USDC', '0x036CbD53842c5426634e7929541eC2318f3dCF7e', 6)],
  'evm:421614': [T('USDC', '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', 6)],
  'solana:mainnet': [T('USDC', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 6), T('USDT', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 6)],
  'solana:devnet': [T('USDC', '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', 6)],
  'tron:mainnet': [T('USDT', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 6), T('USDC', 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8', 6)],
  'tron:nile': [T('USDT', 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf', 6)]
}

// 中文圈常见叫法
const SYMBOL_ALIASES: Record<string, string> = { U: 'USDT', 'U币': 'USDT', 泰达币: 'USDT', 刀: 'USDT' }

export function canonicalSymbol(s: string): string {
  const t = s.trim()
  return SYMBOL_ALIASES[t] ?? SYMBOL_ALIASES[t.toUpperCase()] ?? t.toUpperCase()
}

export function listedToken(networkId: string, symbol: string): TokenInfo | undefined {
  const sym = canonicalSymbol(symbol)
  return TOKENS[networkId]?.find((t) => t.symbol === sym)
}

export function listedByAddress(networkId: string, address: string): TokenInfo | undefined {
  return TOKENS[networkId]?.find((t) => t.address.toLowerCase() === address.toLowerCase())
}
