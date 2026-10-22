// 代币白名单：符号 → 合约地址只从这里查，绝不让 LLM 生成合约地址。
// 列表里的 EVM / Tron 代币在使用时还会链上核对 decimals，不一致直接拒绝。

export interface TokenInfo {
  symbol: string
  address: string // EVM 合约 / Solana mint / Tron 合约
  decimals: number
}

const T = (symbol: string, address: string, decimals: number): TokenInfo => ({ symbol, address, decimals })

export const TOKENS: Record<string, TokenInfo[]> = {
  'evm:1': [T('USDC', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 6), T('USDT', '0xdAC17F958D2ee523a2206206994597C13D831ec7', 6), T('WETH', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 18)],
  'evm:8453': [T('USDC', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 6), T('WETH', '0x4200000000000000000000000000000000000006', 18)],
  'evm:42161': [T('USDC', '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 6), T('USDT', '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', 6), T('WETH', '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', 18)],
  'evm:10': [T('USDC', '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', 6), T('USDT', '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', 6), T('WETH', '0x4200000000000000000000000000000000000006', 18)],
  'evm:137': [T('USDC', '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', 6), T('USDT', '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', 6)],
  'evm:56': [T('USDC', '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', 18), T('USDT', '0x55d398326f99059fF775485246999027B3197955', 18)],
  'evm:43114': [T('USDC', '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', 6), T('USDT', '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', 6)],
  'evm:11155111': [T('USDC', '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', 6), T('WETH', '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14', 18)],
  'evm:84532': [T('USDC', '0x036CbD53842c5426634e7929541eC2318f3dCF7e', 6), T('WETH', '0x4200000000000000000000000000000000000006', 18)],
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

// 不在支持链上的主流币 → 各链上的主流跨链版本（已在链上核对 symbol / decimals，按流动性从高到低排）
export interface BridgedToken {
  networkId: string
  address: string
  symbol: string
  name: string
  decimals: number
  wrapped: boolean // true：跨链 / 包装版本；false：本来就是这条链上的代币
}

const B = (networkId: string, address: string, symbol: string, name: string, decimals: number, wrapped = true): BridgedToken => ({ networkId, address, symbol, name, decimals, wrapped })

export const BRIDGED: Record<string, BridgedToken[]> = {
  BTC: [
    B('evm:1', '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', 'WBTC', 'Wrapped BTC', 8),
    B('evm:8453', '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', 'cbBTC', 'Coinbase Wrapped BTC', 8),
    B('evm:56', '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c', 'BTCB', 'BTCB Token', 18),
    B('evm:42161', '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', 'WBTC', 'Wrapped BTC', 8),
    B('evm:137', '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6', 'WBTC', '(PoS) Wrapped BTC', 8)
  ],
  DOGE: [B('evm:56', '0xbA2aE424d960c26247Dd6c32edC70B295c744C43', 'DOGE', 'Binance-Peg Dogecoin', 8)],
  XRP: [B('evm:56', '0x1D2F0da169ceB9fC7B3144628dB156f3F6c60dBE', 'XRP', 'Binance-Peg XRP', 18)],
  ADA: [B('evm:56', '0x3EE2200Efb3400fAbB9AacF31297cBdD1d435D47', 'ADA', 'Binance-Peg Cardano', 18)],
  LTC: [B('evm:56', '0x4338665CBB7B2485A8855A139b75D5e34AB0DB94', 'LTC', 'Binance-Peg Litecoin', 18)],
  TON: [B('evm:56', '0x76A797A59Ba2C17726896976B7B3747BfD1d220f', 'TONCOIN', 'Wrapped TON Coin', 9)],
  LINK: [
    B('evm:1', '0x514910771AF9Ca656af840dff83E8264EcF986CA', 'LINK', 'ChainLink Token', 18, false),
    B('evm:56', '0xF8A0BF9cF54Bb92F17374d9e9A321E6a111a51bD', 'LINK', 'Binance-Peg ChainLink', 18),
    B('evm:42161', '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4', 'LINK', 'ChainLink Token', 18),
    B('evm:8453', '0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196', 'LINK', 'ChainLink Token', 18)
  ]
}
