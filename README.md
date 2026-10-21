# 语义钱包 Semantic Wallet

一句话完成链上操作的自托管桌面钱包。EVM 全系（chainlist 2800+ 条链）+ Solana + Tron，RPC 自动探测、选优、切换。

> 「给小王转 50U，走波场」→ 解析意图 → 解析地址 / 代币 → 链上模拟 → 风控 → 你确认 → 本地签名广播

## 下载

到 [Releases](../../releases) 或 [Actions](../../actions) 下载：

- `SemanticWallet-Setup-x.y.z.exe`：安装版
- `SemanticWallet-Portable-x.y.z.exe`：免安装，双击即用
- `SemanticWallet-x.y.z-arm64.dmg`：macOS（Apple 芯片）

> 安装包没有代码签名：Windows 首次运行 SmartScreen 会提示「未知发布者」，点「更多信息 → 仍要运行」；macOS 首次打开请右键应用选「打开」，如提示已损坏，执行 `xattr -cr /Applications/SemanticWallet.app`。

## 从源码运行

```bash
npm install
npm run dev          # 开发模式
npm run dist:win     # 打包 Windows exe（输出到 release/）
npm run dist:mac     # 打包 macOS dmg
```

推送到 `main` 会由 GitHub Actions 在 Windows / macOS 机器上自动打包；推送 `v*` 标签会自动发布 Release。

首次启动：创建或导入助记词 → 默认是小窗模式（约 MetaMask 弹窗大小），点右上角「⋯ → 模型与安全设置」，选服务商后粘贴 API Key 即自动识别并连接。默认用 DeepSeek V4.1 Flash（`deepseek-flash`），也支持 Claude 官方、OpenAI 官方，以及任何兼容 Anthropic / OpenAI 协议的接口。

API Key 和加密后的助记词只保存在本机用户数据目录（Windows：`%APPDATA%\semantic-wallet`；macOS：`~/Library/Application Support/semantic-wallet`），不在项目目录里。

## 核心设计：LLM 只理解，不执行

```
用户一句话
  │
  ▼ intent/parser.ts   LLM → 结构化意图 JSON（zod 校验，失败带错误重试一次）
  ▼ engine.ts          确定性代码解析：链名→网络、符号→白名单合约、联系人/ENS→地址
  ▼ adapters/*.ts      链上模拟（eth_call / simulateTransaction / triggerConstantContract）+ 手续费估算
  ▼ risk.ts / engine   风控：余额、手续费、主网开关、稳定币限额、地址投毒、首次地址、合约收款方
  ▼ 渲染进程            确认卡片（内容全部来自代码，不来自 LLM 文本）
  ▼ engine.confirm     签名前重新模拟；手续费上涨超过 50% 则作废重来
  ▼ keystore.ts        主进程内存中的私钥签名并广播
```

- **LLM 碰不到私钥**，也不能生成地址或合约地址：只能原样复制用户给的内容，代币合约只从白名单查，白名单 decimals 还会链上核对。
- **双协议**：`intent/llm.ts` 同时适配 Anthropic Messages API 与 OpenAI Chat Completions API。官方端点用严格结构化输出（Claude 官方额外开启服务端 `fallbacks: "default"`）；DeepSeek 等兼容端点用 JSON 模式 + 本地校验兜底。
- **私钥**：一套 BIP39 助记词派生三条链（EVM `m/44'/60'/0'/0/0`、Solana `m/44'/501'/0'/0'`（SLIP-10，与 Phantom 一致）、Tron `m/44'/195'/0'/0/0`）。scrypt + AES-256-GCM 加密落盘，解锁后只在主进程内存，15 分钟闲置自动锁定。渲染进程开启 sandbox + contextIsolation + CSP。
- **API Key** 用系统钥匙串（Electron safeStorage）加密保存。

## RPC 自动配置（`rpc.ts`）

1. 候选节点：chainlist（不追踪用户的节点优先）+ 用户自己加的节点（优先参与探测）
2. 并发探测：延迟、区块高度
3. 身份校验：EVM 比对 chainId，Solana 比对创世哈希，Tron 多数派创世块，防恶意/配错的节点
4. 剔除落后节点：与中位高度差超过阈值的不要
5. 取最快 3 个，viem `fallback` / 逐个重试自动切换；缓存 10 分钟，过期后台刷新
6. 自动读取系统代理（`proxy.ts`），国内网络也能连上海外节点

## 能说的话

| 说法 | 动作 |
|---|---|
| 给小王转 50U，走波场 | Tron 上转 50 USDT 给联系人小王 |
| 给 vitalik.eth 转 0.01 ETH | ENS 解析后转账（带核对提示） |
| 把 0x… 存为小李 | 保存联系人，自动识别地址属于哪条链 |
| 查一下 base 和 sol 的余额 | 多链余额 |
| 加上 Arbitrum，测一下哪个 RPC 最快 | 探测并切换默认网络 |
| 用我的节点 https://… 跑 Base | 添加自定义 RPC（不可用会拒绝） |
| 全部转给小王 | 自动扣除手续费后的最大金额 |
| 我的收款地址 / 最近转账记录 | 查询 |

## 连接网站（WalletConnect）

1. 在 [cloud.reown.com](https://cloud.reown.com) 免费创建项目，把项目 ID 填到「设置 → 连接网站」
2. 在网站上点「连接钱包 → WalletConnect」，复制连接码（`wc:` 开头）
3. 粘贴到钱包的「连接网站」面板或直接粘贴进对话框，确认连接

网站发来的请求都会变成对话里的确认卡片，内容由主进程独立解码：

| 请求 | 钱包怎么处理 |
|---|---|
| 登录签名（SIWE） | 核对签名里的域名和当前网站是否一致，不一致直接拦截 |
| 代币授权 `approve` | 显示被授权方和额度，无限额授权重点警告 |
| 离线授权 Permit / Permit2 | 解析额度、被授权方、有效期；无限额 Permit 直接拦截 |
| NFT `setApprovalForAll` / Seaport 挂单 | 警告可能转走全部 NFT / 按签名价格卖出 |
| 未知合约调用 | 查 4byte 签名库还原函数和参数，链上模拟，再由大模型给一句「AI 解读」 |
| `eth_sign` | 直接拒绝 |

对话里也能说「我连了哪些网站」「断开 Uniswap」「断开所有网站」。连接码里含配对密钥，不会发给大模型。



- 默认网络是 Base Sepolia；**主网转账默认关闭**，需在设置里打开
- 主网稳定币单笔上限 1000（可改），超出直接拦截
- 地址投毒检测：与联系人或历史地址首尾 4 位相同、中间不同，直接拦截

## 已验证

- 派生地址与 Hardhat 标准助记词、TronWeb 官方实现、SLIP-10 官方测试向量一致
- 6 个网络（Base Sepolia / Solana Devnet / Tron Nile / 以太坊 / Solana / Tron）RPC 探测全部成功
- 白名单代币在 10 个网络上链上核对通过
- 两种 LLM 协议用 mock 服务测通，包括输出不规范时的修复重试
- 完整 GUI 流程截图走查（导入、余额、联系人、拦截、投毒、待确认、追问、测速、设置）

## 已知限制

- 还没有在链上实际广播过交易（需要你用自己的钱包领测试币后测试「确认并签名」）
- OP Stack 等 L2 的 L1 数据费没算进手续费估算（"全部转出"时额外留了余量）
- 只支持 HTTP 代理；只开了 SOCKS 的话需要在代理软件里开 HTTP 端口
- 暂不支持 swap、approve、批量签名等操作

## 目录

```
src/main/           主进程（私钥、链、LLM 全在这里）
  keystore.ts       助记词加密、三链派生、自动锁定
  chains/           链注册表（chainlist + 中文别名）与内置种子
  rpc.ts            RPC 探测 / 选优 / 故障切换
  proxy.ts          系统代理
  adapters/         evm.ts / solana.ts / tron.ts 统一接口
  intent/           llm.ts 双协议适配，parser.ts 提示词与校验
  engine.ts         编排、风控、确认、历史
  tokens.ts         代币白名单
src/preload/        最小 IPC 桥
src/renderer/       React 界面
scripts/build-seed.mts   重新生成内置链种子：npm run seed
```
