import { BrowserWindow, app, ipcMain, nativeTheme, shell } from 'electron'
import { join } from 'node:path'
import type { ChainFamily, Contact, LlmConnectResult, LlmSettingsInput, UiMode, WalletStatus } from '../shared/types'
import { allNetworks, getNetwork, loadRegistry, summary } from './chains/registry'
import { cancel, chat, confirm, contacts, defaultBalances, removeContact, saveContact, txStatus } from './engine'
import { describeLlmError, listModels, testLlm } from './intent/llm'
import * as keystore from './keystore'
import { cachedState, loadRpcState, probe } from './rpc'
import { configureProxy } from './proxy'
import { loadSettings, resolveLlm, setLlm, setPrefs, settings, view } from './settings'

const FEATURED = ['evm:84532', 'evm:11155111', 'evm:421614', 'solana:devnet', 'tron:nile', 'evm:1', 'evm:8453', 'evm:42161', 'evm:56', 'solana:mainnet', 'tron:mainnet']

// 小窗尺寸参照 MetaMask 弹窗
const WINDOW = {
  compact: { width: 380, height: 640, minWidth: 340, minHeight: 520 },
  full: { width: 1280, height: 820, minWidth: 960, minHeight: 640 }
}

let mainWindow: BrowserWindow | null = null

const isMac = process.platform === 'darwin'

function applyMode(win: BrowserWindow, mode: UiMode): void {
  const s = WINDOW[mode]
  win.setMinimumSize(s.minWidth, s.minHeight)
  win.setContentSize(s.width, s.height, true)
  win.center()
}

function status(): WalletStatus {
  return { exists: keystore.vaultExists(), unlocked: keystore.isUnlocked(), addresses: keystore.addresses() }
}

// 渲染进程只能调用这里列出的通道
const handlers: Record<string, (...args: any[]) => unknown> = {
  'wallet:status': () => status(),
  'wallet:newMnemonic': () => keystore.newMnemonic(),
  'wallet:create': (mnemonic: string, password: string) => {
    keystore.saveVault(mnemonic, password)
    return status()
  },
  'wallet:unlock': (password: string) => {
    keystore.unlock(password)
    return status()
  },
  'wallet:lock': () => {
    keystore.lock()
    return status()
  },

  'chat:send': (text: string) => chat(String(text).slice(0, 2000)),
  'tx:confirm': (id: string) => confirm(id),
  'tx:cancel': (id: string) => cancel(id),
  'tx:status': (id: string) => txStatus(id),

  'settings:get': () => view(),
  // 先用候选配置测通，再保存；测不通就不覆盖原来的配置
  'llm:connect': async (input: LlmSettingsInput): Promise<LlmConnectResult> => {
    const r = await testLlm(await resolveLlm(input))
    if (r.ok) await setLlm(input)
    return { ...r, settings: view() }
  },
  'llm:models': async (input: LlmSettingsInput) => {
    try {
      return { models: await listModels(await resolveLlm(input, false)) }
    } catch (e) {
      return { models: [], error: describeLlmError(e) }
    }
  },
  'window:setMode': (mode: UiMode) => {
    if (mode !== 'compact' && mode !== 'full') throw new Error('未知模式')
    setPrefs({ uiMode: mode })
    if (mainWindow) applyMode(mainWindow, mode)
    return view()
  },
  'balances:default': () => defaultBalances(),
  'settings:setPrefs': (p: { defaultNetwork?: string; allowMainnet?: boolean; stableLimit?: number }) => {
    if (p.defaultNetwork) getNetwork(p.defaultNetwork)
    setPrefs(p)
    return view()
  },

  'networks:featured': () => {
    const def = settings().defaultNetwork
    const ids = FEATURED.includes(def) ? FEATURED : [def, ...FEATURED]
    return ids.map((id) => ({ ...summary(getNetwork(id)), state: cachedState(id) }))
  },
  'networks:count': () => allNetworks().length,
  'networks:probe': (id: string) => probe(id),

  'contacts:list': () => contacts(),
  'contacts:add': (c: Contact) => saveContact(c),
  'contacts:remove': (name: string, family: ChainFamily) => removeContact(name, family)
}

function createWindow(): void {
  const size = WINDOW[settings().uiMode]
  nativeTheme.themeSource = 'dark' // Windows 标题栏跟随深色
  const win = new BrowserWindow({
    ...size,
    useContentSize: true, // 尺寸按内容区算，Windows 边框不占用小窗空间
    title: '语义钱包',
    backgroundColor: '#0f1115',
    // macOS 用内嵌红绿灯；Windows 用系统标题栏并隐藏菜单栏
    ...(isMac ? { titleBarStyle: 'hiddenInset' as const } : { autoHideMenuBar: true }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  // 外链（区块浏览器）用系统浏览器打开，应用内禁止跳转
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  mainWindow = win
  if (!isMac) win.removeMenu()

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(async () => {
  // 开发模式下 Dock 也显示应用图标（打包后由安装包自带图标）
  if (isMac && !app.isPackaged) app.dock?.setIcon(join(__dirname, '../../build/icon.png'))
  loadSettings()
  loadRpcState()
  await configureProxy()
  await loadRegistry()
  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (_e, ...args) => {
      try {
        return { ok: true, data: await fn(...args) }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    })
  }
  createWindow()
  // 后台给常用网络测速，侧边栏马上能看到延迟
  void (async () => {
    for (const id of [settings().defaultNetwork, ...FEATURED]) await probe(id).catch(() => undefined)
  })()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  keystore.lock()
  if (process.platform !== 'darwin') app.quit()
})
