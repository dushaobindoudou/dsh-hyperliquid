/**
 * dsh-hyperliquid — the `hyper` Remote namespace (Typert), the single host
 * entry point for both the client UI and the agent tools. One method per
 * capability; every method takes one `request` JSON value and returns plain
 * JSON, mirroring dsh-bots' wire contract.
 * @module lib/remote.js
 */

import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { HyperliquidClient, keys, sigFigs } from './hl.js'
import { canonicalMarketCoin } from './market-symbol.js'
import { HyperStore } from './store.js'
import { addressFromPrivateKey, buildL1TypedData, buildSendAsset, buildUsdClassTransfer, signTypedDataLocal, splitSignature } from './signing.js'
import { TradingGuard } from './trading-guard.js'
import { normalizeMaLines } from './moving-average.js'
import { ALERT_KINDS, ICON_NAMES, TEXT_KINDS, drawingGeometry, drawingStyle, isIconLabel, linePriceAt } from './chart-drawings.js'
import { normalizeRiskSettings, coinAllowed, ALL_COINS } from './risk-settings.js'
import { INDICATOR_IDS, normalizeIndicatorSettings } from './studies.js'
import { normalizeResearch } from './workspace-settings.js'
import { fundingWindow } from './review.js'

const TOOL_CALL = Symbol('verified DSH tool call')

const { Remote, TypertRemoteService } = await resolveTypertRuntime()

/** Anchor to the running dsh CLI's typert copy (dsh-bots' proven technique). */
async function resolveTypertRuntime() {
  const { createRequire } = await import('node:module')
  const { realpathSync } = await import('node:fs')
  const candidates = []
  const SPEC = '@deepseek-ai/dsh-typert-protocol'
  // Test hook: HYPERLIQUID_TYPERT_MODULE pins the typert module for out-of-host
  // smoke tests; inside the real dsh host the argv/execPath anchors win.
  if (process.env.HYPERLIQUID_TYPERT_MODULE) {
    const pinned = process.env.HYPERLIQUID_TYPERT_MODULE
    candidates.push(() => {
      const req = createRequire(pinned.startsWith('file:') ? import.meta.url : pinned)
      return req(req.resolve(pinned.startsWith('file:') ? SPEC : pinned))
    })
  }
  const anchors = []
  for (const a of [process.argv?.[1], process.argv?.[0]]) {
    if (typeof a !== 'string' || a.length === 0) continue
    anchors.push(a)
    try { anchors.push(realpathSync(a)) } catch { /* keep original */ }
  }
  // Anchor via CJS require instead of dynamic import: the dsh loader's module
  // hooks stall import(fileUrl) for loader-external absolute paths, while
  // require(esm) (Node ≥ 22.12) resolves the exact same module natively.
  for (const a of anchors) {
    candidates.push(() => {
      const req = createRequire(a)
      return req(req.resolve(SPEC))
    })
  }
  // Last resort: the plugin's own node_modules walk-up.
  candidates.push(() => {
    const req = createRequire(import.meta.url)
    return req(req.resolve(SPEC))
  })
  for (let i = 0; i < candidates.length; i += 1) {
    try {
      const m = await candidates[i]()
      // require(esm) returns the module namespace; import() may wrap it as
      // { default: {...} } (CJS interop) — accept both spellings.
      const mod = m && m.TypertRemoteService ? m : (m && m.default && m.default.TypertRemoteService ? m.default : m)
      if (mod && mod.TypertRemoteService && mod.Remote) return { Remote: mod.Remote, TypertRemoteService: mod.TypertRemoteService }
    } catch { /* try next anchor */ }
  }
  throw new Error('[dsh-hyperliquid] 无法解析 @deepseek-ai/dsh-typert-protocol（宿主锚定与回退均失败）')
}

/** Apply one `@Remote(method)` marker via a decorator-context shim. */
function markRemoteMethod(prototype, method) {
  const decorator = Remote(method)
  decorator(undefined, {
    name: method,
    private: false,
    static: false,
    addInitializer(fn) { fn.call(Object.create(prototype)) },
  })
}

const MARKETS_TTL_MS = 10_000
const ACCOUNT_MODE_TTL_MS = 30_000
const TRADE_CAPACITY_TTL_MS = 15_000
const SUB_SWEEP_MS = 30_000
const SUB_IDLE_MS = 120_000
const ALERT_CHECK_MS = 2_000
const BOOK_GROUPINGS = {
  full: null,
  '5': { nSigFigs: 5 },
  '5x2': { nSigFigs: 5, mantissa: 2 },
  '5x5': { nSigFigs: 5, mantissa: 5 },
  '4': { nSigFigs: 4 },
  '3': { nSigFigs: 3 },
  '2': { nSigFigs: 2 },
}

export class HyperRemote extends TypertRemoteService {
  constructor(ctx, config = {}) {
    super(ctx, 'hyper')
    this.hostCtx = ctx // kept for optional-service lookups (ctx.get — never throws)
    this.cfg = {
      dataDir: expandHome(config?.dataDir ?? '~/.dsh-hyperliquid'),
      network: config?.network === 'testnet' ? 'testnet' : 'mainnet',
      tradingMode: config?.tradingMode === 'paper' ? 'paper' : 'live',
      privateKey: config?.privateKey || process.env.HYPERLIQUID_PRIVATE_KEY || '',
      // signer 'local': sign with config.privateKey inside this plugin.
      // signer 'web3': delegate EIP-712 signing to the dsh-web3 vault
      //                (ctx.wallet) — the private key never leaves the vault
      //                and every signature passes the wallet's signing policy.
      signer: config?.signer === 'web3' ? 'web3' : 'local',
      web3Account: config?.web3Account ?? 'main',
      tradingAddress: config?.tradingAddress ?? '',
      autonomousLive: config?.autonomousLive === true,
      agentAutoTradeTestnet: config?.agentAutoTradeTestnet === true,
      allowedCoins: String(config?.allowedCoins ?? 'BTC,ETH').split(',').map((v) => v.trim()).filter(Boolean),
      maxOrderUsd: Number(config?.maxOrderUsd ?? 100),
      maxDailyUsd: Number(config?.maxDailyUsd ?? 500),
      maxPositionUsd: Number(config?.maxPositionUsd ?? 500),
      maxLeverage: Number(config?.maxLeverage ?? 2),
    }
    for (const field of ['maxOrderUsd', 'maxDailyUsd', 'maxPositionUsd', 'maxLeverage']) {
      if (!Number.isFinite(this.cfg[field]) || this.cfg[field] <= 0) throw new Error(`${field} 必须为正数`)
    }
    if (this.cfg.autonomousLive && this.cfg.signer !== 'web3') throw new Error('autonomousLive 仅支持 signer=web3')
    if (this.cfg.tradingAddress && !/^0x[0-9a-fA-F]{40}$/.test(this.cfg.tradingAddress)) throw new Error('tradingAddress 必须为 20 字节 EVM 地址')
    this.client = new HyperliquidClient({ network: this.cfg.network, privateKey: this.cfg.privateKey })
    this.store = new HyperStore(this.cfg.dataDir, this.cfg.network)
    // Signing chosen on the desk wins over plugin config (set without a restart; see updateWalletSettings).
    try { Object.assign(this.cfg, normalizeWalletSettings(this.store.walletSettings() ?? {}, this.cfg)) } catch { /* a bad saved file falls back to config */ }
    this.baseRiskSettings = Object.fromEntries(['allowedCoins', 'maxOrderUsd', 'maxDailyUsd', 'maxPositionUsd', 'maxLeverage'].map((key) => [key, this.cfg[key]]))
    const savedRiskSettings = this.store.getRiskSettings()
    this.riskSettingsOverride = savedRiskSettings != null
    if (savedRiskSettings) Object.assign(this.cfg, normalizeRiskSettings(savedRiskSettings))
    this.guard = new TradingGuard(this.cfg.dataDir, { ...this.cfg, dataDir: this.cfg.dataDir })
    this.paperGuard = new TradingGuard(this.cfg.dataDir, { ...this.cfg, dataDir: this.cfg.dataDir }, { budgetName: this.cfg.network === 'mainnet' ? 'paper-budget-mainnet.json' : 'paper-budget.json' })
    // Custody: the desk setting wins; before the trader picks one, config.autonomousLive implies managed.
    this.cfg.custody = this.store.custody() ?? (this.cfg.autonomousLive ? 'managed' : 'assisted')
    this.marketsCache = null
    this.marketsAt = 0
    this.catalogCache = null
    this.catalogAt = 0
    this.catalogDexIndex = new Map()
    this.detailCache = new Map()
    this.addressCache = null
    this.accountModeCache = null
    this.accountModePending = null
    this.tradeCapacityCache = new Map()
    this.tradeCapacityPending = new Map()
    this.walletAddressCache = null
    this.walletEpoch = 0 // bumped on every wallet switch; work that started under an older wallet is discarded
    this.desk = { coin: 'BTC', interval: '15m', sessionId: null } // active UI session and market focus
    this.lastTouch = new Map() // snapshot key -> last request ms
    this.activeTradeOps = 0
    // Hold the network stable through every order/cancel/leverage operation,
    // including wallet approval and the exchange response.
    for (const method of ['placeOrder', 'cancelOrder', 'setLeverage', 'transferCollateral']) {
      const operation = this[method].bind(this)
      this[method] = async (...args) => {
        this.activeTradeOps += 1
        try { return await operation(...args) }
        finally { this.activeTradeOps -= 1 }
      }
    }
    this.sweepTimer = setInterval(() => this.sweepSubs(), SUB_SWEEP_MS)
    this.sweepTimer.unref?.()
    this.alertSides = new Map() // drawing id → last side of the mid price (-1 below, 1 above)
    this.alertListeners = new Set() // (event) => void — the host wakes the session agent through this
    this.dexMidCache = new Map() // HIP-3 dex → { at, mids }: core allMids does not carry builder-deployed markets
    this.alertTimer = setInterval(() => {
      try {
        this.checkDrawingAlerts()
        if (this.cfg.tradingMode === 'paper' && Object.keys(this.store.paper.protections ?? {}).length) {
          const key = this.touch(keys.allMids())
          const snap = this.client.snapshot(key)
          if (snap && Date.now() - snap.at <= 10_000) this.processPaperProtections(Date.now(), snap.data?.mids ?? snap.data)
        }
      } catch (error) { this.hostCtx?.logger?.error?.('[dsh-hyperliquid] paper protection check failed', error) }
      void this.refreshAlertDexMids().catch(() => {})
    }, ALERT_CHECK_MS)
    this.alertTimer.unref?.()
  }

  sweepSubs() {
    const now = Date.now()
    for (const [key, at] of this.lastTouch) {
      if (now - at > SUB_IDLE_MS) {
        this.client.unsubscribe(key)
        this.lastTouch.delete(key)
      }
    }
  }

  touch(key) {
    this.lastTouch.set(key, Date.now())
    // subscribe() ref-counts. Polling the desk must not increment that count.
    if (!this.client.subs.has(key)) this.client.subscribe(key, argsOf(key))
    return key
  }

  // ── dsh-web3 signer plumbing ──────────────────────────────────────────
  /** The dsh-web3 wallet service, if the plugin is installed. Optional read — never throws. */
  walletService() {
    const w = this.hostCtx?.get?.('wallet')
    return w && typeof w.signTypedData === 'function' ? w : null
  }

  /** Harness approval gateway (same resolution dsh-web3's own tools use). */
  approvalGateway() {
    return this.hostCtx?.get?.('approval') ?? { async request() { return 'unavailable' } }
  }

  /** Resolve the configured web3 account's address from the vault. */
  async web3Address() {
    const wallet = this.walletService()
    if (!wallet) throw new Error('signer=web3 但 dsh-web3 未安装或未启用 —— 请执行 dsh plugin --profile web add dsh-web3')
    const accounts = typeof wallet.listAccounts === 'function' ? wallet.listAccounts() : []
    if (accounts.length === 0) throw new Error('dsh-web3 保险库里还没有账户 —— 请在 DSH 设置的「Web3 钱包」页创建或导入')
    const want = this.cfg.web3Account
    const meta = accounts.find((a) => a?.id === want || a?.label === want)
    if (!meta) throw new Error(`dsh-web3 中找不到指定签名账户：${want}`)
    if (!meta?.address) throw new Error('dsh-web3 账户缺少地址')
    this.walletAddressCache = meta.address
    return meta.address
  }

  /**
   * Trading address for reads (status/account/orders/fills).
   * local → derived from config.privateKey; web3 → the vault account.
   */
  async resolveAddress() {
    if (this.cfg.tradingAddress) return this.cfg.tradingAddress
    if (this.cfg.signer === 'web3') {
      // An API wallet signs for its owner; account reads must use the owner.
      return null
    }
    if (!this.cfg.privateKey) return null
    try { return (this.addressCache ??= await addressFromPrivateKey(this.cfg.privateKey)) } catch { return null }
  }

  /** The account abstraction mode changes where Hyperliquid reports collateral. */
  async accountMode(address, fresh = false) {
    const key = address.toLowerCase()
    if (!fresh && this.accountModeCache?.address === key && Date.now() - this.accountModeCache.at < ACCOUNT_MODE_TTL_MS) return this.accountModeCache.mode
    if (this.accountModePending?.address === key) return this.accountModePending.promise
    const promise = this.client.userAbstraction(address).then((mode) => {
      if (!['default', 'disabled', 'dexAbstraction', 'unifiedAccount', 'portfolioMargin'].includes(mode)) throw new Error(`交易所返回未知账户模式：${String(mode)}`)
      this.accountModeCache = { address: key, mode, at: Date.now() }
      return mode
    }).finally(() => { if (this.accountModePending?.promise === promise) this.accountModePending = null })
    this.accountModePending = { address: key, promise }
    return promise
  }

  /** UI-only capacity cache. Order preflight queries the exchange afresh. */
  async activeAssetFor(address, coin, accountMode) {
    const key = `${address.toLowerCase()}:${accountMode}:${coin}`
    const cached = this.tradeCapacityCache?.get(key)
    if (cached && Date.now() - cached.at < TRADE_CAPACITY_TTL_MS) return cached.value
    const pending = this.tradeCapacityPending?.get(key)
    if (pending) return pending
    const promise = this.client.activeAssetData(address, coin).then((value) => {
      if (!validTradeCapacity(value, coin)) throw new Error('交易所可交易额度响应无效')
      this.tradeCapacityCache ??= new Map()
      this.tradeCapacityCache.set(key, { value, at: Date.now() })
      if (this.tradeCapacityCache.size > 256) {
        for (const [oldKey, row] of this.tradeCapacityCache) {
          if (Date.now() - row.at >= TRADE_CAPACITY_TTL_MS) this.tradeCapacityCache.delete(oldKey)
        }
        while (this.tradeCapacityCache.size > 256) this.tradeCapacityCache.delete(this.tradeCapacityCache.keys().next().value)
      }
      return value
    }).finally(() => this.tradeCapacityPending?.delete(key))
    this.tradeCapacityPending ??= new Map()
    this.tradeCapacityPending.set(key, promise)
    return promise
  }

  /**
   * THE live exchange submit. signer=local keeps the validated in-plugin
   * EIP-712 path; signer=web3 builds the identical typed-data payload and
   * lets dsh-web3 sign it under its signing policy (approval gates, PIN,
   * audit log) — then only transports the opaque signature.
   */
  async submitAction(action, exec) {
    if (this.cfg.signer !== 'web3') return this.client.exchange(action)
    const wallet = this.walletService()
    if (!wallet) throw new Error('signer=web3 但 dsh-web3 未安装 —— 请执行 dsh plugin --profile web add dsh-web3')
    const nonce = this.client.nextNonce()
    const typed = await buildL1TypedData(action, nonce, { isMainnet: this.cfg.network === 'mainnet' })
    const purpose = `Hyperliquid ${this.cfg.network} 交易签名：${action?.type}` +
      (action?.type === 'order' ? ` ${action.orders?.[0]?.b ? '买入' : '卖出'} ${action.orders?.[0]?.s} @ ${action.orders?.[0]?.p}` : '')
    const result = await wallet.signTypedData(
      { account: this.cfg.web3Account, ...typed, purpose },
      this.approvalGateway(),
      { toolName: 'dsh-hyperliquid', agent: exec?.agent, callId: exec?.callId, signal: exec?.signal },
    )
    if (result?.status !== 'signed' || !result.signature) {
      const why = {
        'awaiting-approval-rejected': '用户在钱包审批中拒绝了该签名',
        'denied-by-policy': '钱包签名策略拒绝了该签名（在 DSH 设置 → Web3 钱包调整签名策略；与交易台的交易限额无关）',
        'unavailable-approver': '没有可用的审批通道（钱包安全模式要求逐笔确认）',
      }[result?.status] ?? `签名未完成（status=${result?.status}）`
      throw new Error(`dsh-web3 签名失败：${why}`)
    }
    const signerAddress = await this.web3Address()
    if (result.address?.toLowerCase() !== signerAddress.toLowerCase()) throw new Error('dsh-web3 返回的签名地址与配置账户不一致')
    const signature = splitSignature(result.signature)
    return this.client.exchangeSigned(action, signature, nonce)
  }

  /**
   * The exchange asset behind a tradable perp: core perps use their `meta` index; HIP-3 (builder-deployed)
   * perps use 100000 + perpDexIndex * 10000 + index in that dex's meta (Hyperliquid "Asset IDs").
   * Only USDC-collateral dexes are tradable here, since balances and limits are valued in USD.
   * @returns {{ coin, asset, dex, szDecimals, maxLeverage, onlyIsolated }}
   */
  async tradeAsset(coin) {
    if (!coin.includes(':')) {
      const { universe } = await this.markets()
      const index = universe.findIndex((row) => row.name === coin)
      if (index < 0) throw new Error(`未知合约 ${coin}；现货与 Outcome 市场目前只读`)
      const row = universe[index]
      return { coin, asset: index, dex: '', szDecimals: row.szDecimals, maxLeverage: row.maxLeverage, onlyIsolated: Boolean(row.onlyIsolated) }
    }
    const dex = coin.split(':')[0]
    const client = this.client
    const cached = this.dexAssets?.get(dex)
    let entry = cached && Date.now() - cached.at < 60_000 && cached.network === this.cfg.network ? cached : null
    if (!entry) {
      const [dexs, meta] = await Promise.all([this.perpDexList(), client.info('meta', { dex })])
      if (client !== this.client) throw new Error('网络已切换，请重新预检交易')
      const dexIndex = dexs.findIndex((row) => row?.name === dex)
      if (dexIndex < 1 || !Array.isArray(meta?.universe)) throw new Error(`未知的 HIP-3 交易所 ${dex}`)
      entry = { at: Date.now(), network: this.cfg.network, dexIndex, collateralToken: meta.collateralToken, universe: meta.universe }
      ;(this.dexAssets ??= new Map()).set(dex, entry)
    }
    if (entry.collateralToken !== 0) throw new Error(`${dex} 使用非 USDC 保证金（token ${entry.collateralToken}），暂只支持查看行情`)
    const index = entry.universe.findIndex((row) => row.name === coin)
    if (index < 0) throw new Error(`${dex} 上没有合约 ${coin}`)
    const row = entry.universe[index]
    if (row.isDelisted) throw new Error(`${coin} 已下架`)
    return { coin, asset: 100000 + entry.dexIndex * 10000 + index, dex, szDecimals: row.szDecimals, maxLeverage: row.maxLeverage,
      onlyIsolated: Boolean(row.onlyIsolated) || row.marginMode === 'strictIsolated' || row.marginMode === 'noCross' }
  }

  /** `perpDexs`: index 0 is the core dex (null), HIP-3 dexes follow in asset-id order. */
  async perpDexList() {
    if (this.perpDexCache && Date.now() - this.perpDexCache.at < 300_000 && this.perpDexCache.network === this.cfg.network) return this.perpDexCache.rows
    const rows = await this.client.info('perpDexs')
    if (!Array.isArray(rows)) throw new Error('无法读取 HIP-3 交易所列表')
    this.perpDexCache = { at: Date.now(), network: this.cfg.network, rows }
    return rows
  }

  /** Mids of one HIP-3 dex (core mids do not include builder-deployed markets). */
  async dexMids(dex) {
    const res = await this.client.info('allMids', { dex })
    return res?.mids ?? res ?? {}
  }

  /** Mid price for a perp coin: WS allMids first, REST fallback. */
  async midOf(coin) {
    if (coin.includes(':')) {
      const n = Number((await this.dexMids(coin.split(':')[0]))[coin])
      if (Number.isFinite(n) && n > 0) return n
      throw new Error(`无法获得 ${coin} 中间价`)
    }
    this.touch(keys.allMids())
    const snap = this.client.snapshot(keys.allMids())
    if (snap?.data && Date.now() - snap.at < 5_000) {
      const v = snap.data.mids?.[coin] ?? snap.data[coin]
      const n = Number(v)
      if (Number.isFinite(n) && n > 0) return n
    }
    try {
      const mids = await this.client.allMids()
      const n = Number(mids?.mids?.[coin] ?? mids?.[coin])
      if (Number.isFinite(n) && n > 0) return n
    } catch { /* fall through */ }
    const markets = await this.markets()
    const row = markets.universe.find((u) => u.name === coin)
    if (row?.markPx) return Number(row.markPx)
    throw new Error(`无法获得 ${coin} 中间价`)
  }

  async markets(request) {
    const now = Date.now()
    if (this.marketsCache && now - this.marketsAt < MARKETS_TTL_MS) return this.marketsCache
    const client = this.client
    const ctxs = await client.metaAndAssetCtxs()
    if (client !== this.client) throw new Error('网络已切换，忽略旧网络市场数据')
    const universe = (ctxs?.[0]?.universe ?? []).map((u, i) => ({
      name: u.name,
      szDecimals: u.szDecimals,
      maxLeverage: u.maxLeverage,
      onlyIsolated: u.onlyIsolated ?? false,
      ctx: ctxs?.[1]?.[i] ?? null,
    }))
    this.marketsCache = { universe, network: this.cfg.network }
    this.marketsAt = now
    return this.marketsCache
  }

  /** Search catalog for the market picker. Extra venues are view-only until
   * their asset IDs, account state and order guards have dedicated support. */
  async marketCatalog(request) {
    const now = Date.now()
    const client = this.client
    const ctxKey = this.touch(keys.allDexsAssetCtxs())
    if (!this.catalogCache || now - this.catalogAt >= 60_000) {
      const base = await this.markets()
      const [spotResult, perpResult, outcomeResult, categoryResult] = await Promise.allSettled([
        client.info('spotMetaAndAssetCtxs'),
        client.info('allPerpMetas'),
        this.cfg.network === 'testnet' ? client.info('outcomeMeta') : Promise.resolve(null),
        client.info('perpCategories'),
      ])
      if (client !== this.client) throw new Error('网络已切换，忽略旧网络市场目录')
      const categories = new Map(categoryResult.status === 'fulfilled' && Array.isArray(categoryResult.value)
        ? categoryResult.value.filter((pair) => Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string') : [])
      const rows = base.universe.map((row) => ({
        name: row.name, label: `${row.name}-USDC`, kind: 'perp', venue: 'Hyperliquid',
        tradable: true, ctx: row.ctx, maxLeverage: row.maxLeverage,
      }))
      const dexIndex = new Map()
      if (perpResult.status === 'fulfilled' && Array.isArray(perpResult.value)) {
        for (const item of perpResult.value.slice(1)) {
          const meta = Array.isArray(item) ? item[0] : item
          const contexts = Array.isArray(item) ? item[1] : null
          for (const [index, asset] of (meta?.universe ?? []).entries()) {
            const dex = asset.name.split(':')[0] || 'HIP-3'
            dexIndex.set(asset.name, { dex, index })
            // USDC-collateral HIP-3 perps trade through the same order path (asset 100000 + dex·10000 + index).
            rows.push({ name: asset.name, label: asset.name, kind: 'hip3',
              venue: dex, tradable: meta?.collateralToken === 0 && !asset.isDelisted, ctx: contexts?.[index] ?? null,
              category: categories.get(asset.name) ?? null, maxLeverage: asset.maxLeverage, szDecimals: asset.szDecimals })
          }
        }
      }
      if (spotResult.status === 'fulfilled') {
        const [meta, ctxs] = spotResult.value ?? []
        const tokens = new Map((meta?.tokens ?? []).map((token) => [token.index, token.name]))
        for (const [index, asset] of (meta?.universe ?? []).entries()) {
          // spotMetaAndAssetCtxs returns contexts in universe order; contexts
          // have no `coin` field in the documented response.
          const ctx = ctxs?.[index]
          const base = tokens.get(asset.tokens?.[0])
          const quote = tokens.get(asset.tokens?.[1])
          const label = base && quote ? `${base}/${quote}` : asset.name
          rows.push({ name: asset.name, label, kind: 'spot', venue: 'Spot',
            tradable: false, ctx: ctx ?? null, maxLeverage: null })
        }
      }
      if (outcomeResult.status === 'fulfilled') {
        for (const outcome of outcomeResult.value?.outcomes ?? []) {
          if (!Number.isSafeInteger(outcome?.outcome) || outcome.outcome < 0) continue
          for (const [side, spec] of (outcome.sideSpecs ?? []).entries()) {
            if (side > 1) break
            const name = `#${10 * outcome.outcome + side}`
            rows.push({ name, label: `${outcome.name || 'Outcome'} · ${spec?.name || (side === 0 ? 'Yes' : 'No')} #${outcome.outcome}`, kind: 'outcome',
              venue: `Outcome #${outcome.outcome}`, tradable: false, ctx: null, maxLeverage: null })
          }
        }
      }
      this.catalogDexIndex = dexIndex
      this.catalogCache = { markets: rows, network: this.cfg.network, observedAt: now }
      this.catalogAt = now
    }
    const live = this.client.snapshot(ctxKey)
    if (!live || now - live.at > 15_000 || !Array.isArray(live.data?.ctxs)) return this.catalogCache
    const byDex = new Map(live.data.ctxs.filter((entry) => Array.isArray(entry) && typeof entry[0] === 'string' && Array.isArray(entry[1])))
    const markets = this.catalogCache.markets.map((row) => {
      const location = this.catalogDexIndex.get(row.name)
      const ctx = location ? byDex.get(location.dex)?.[location.index] : null
      return ctx ? { ...row, ctx } : row
    })
    return { ...this.catalogCache, markets, ctxObservedAt: live.at }
  }

  /** Refresh one selected market; the picker catalog is not the live price source. */
  async marketDetail(request) {
    const coin = requireCoin(request)
    // Core perps have a small, separately cached metadata endpoint. Do not
    // build the broad spot/HIP-3 catalog merely to refresh a BTC strip.
    if (!coin.includes(':') && !coin.startsWith('#') && !coin.startsWith('@') && !coin.includes('/')) {
      const { universe } = await this.markets()
      const market = universe.find((entry) => entry.name === coin)
      if (market) return { market: { name: coin, label: `${coin}-USDC`, kind: 'perp', venue: 'Hyperliquid', tradable: true,
        ctx: market.ctx, maxLeverage: market.maxLeverage }, observedAt: this.marketsAt }
    }
    const catalog = await this.marketCatalog()
    const row = catalog.markets.find((market) => market.name === coin)
    if (!row) throw new Error(`市场目录中没有 ${coin}`)
    if (row.kind === 'spot') {
      const cached = this.detailCache.get('__spot__')
      if (cached && Date.now() - cached.at < 15_000) return { market: { ...row, ctx: cached.rows.get(coin) ?? row.ctx }, observedAt: cached.at }
      const [meta, ctxs] = await this.client.info('spotMetaAndAssetCtxs')
      const rows = new Map((meta?.universe ?? []).map((asset, index) => [asset.name, ctxs?.[index] ?? null]))
      const at = Date.now()
      this.detailCache.set('__spot__', { at, rows })
      return { market: { ...row, ctx: rows.get(coin) ?? null }, observedAt: at }
    }
    if (row.kind === 'outcome') {
      const key = this.touch(keys.l2Book(coin))
      const live = this.client.snapshot(key)
      const fresh = live && Date.now() - live.at < 5_000 && Array.isArray(live.data?.levels)
      const book = fresh ? live.data : await this.client.l2Book(coin).catch(() => null)
      const bid = Number(book?.levels?.[0]?.[0]?.px)
      const ask = Number(book?.levels?.[1]?.[0]?.px)
      const markPx = bid > 0 && ask > 0 ? String(Number(((bid + ask) / 2).toPrecision(12))) : bid > 0 ? String(bid) : ask > 0 ? String(ask) : null
      return { market: { ...row, ctx: markPx ? { markPx, midPx: markPx } : null }, observedAt: book ? (fresh ? live.at : Date.now()) : 0 }
    }
    if (row.ctx && catalog.ctxObservedAt && Date.now() - catalog.ctxObservedAt < 10_000) {
      return { market: row, observedAt: catalog.ctxObservedAt }
    }
    const dex = coin.split(':')[0]
    const cached = this.detailCache.get(dex)
    if (cached && Date.now() - cached.at < 15_000) return { market: { ...row, ctx: cached.rows.get(coin) ?? row.ctx }, observedAt: cached.at }
    const [meta, ctxs] = await this.client.info('metaAndAssetCtxs', { dex })
    const rows = new Map((meta?.universe ?? []).map((asset, index) => [asset.name, ctxs?.[index] ?? null]))
    const at = Date.now()
    this.detailCache.set(dex, { at, rows })
    return { market: { ...row, ctx: rows.get(coin) ?? row.ctx }, observedAt: at }
  }

  /** Browser reads only the marks for its active registered DSH session. */
  async chartMarks(request) {
    const sessionId = String(request?.sessionId ?? '')
    if (!this.store.getSession(sessionId)) return { marks: [] }
    const coin = requireCoin(request)
    const interval = request?.allIntervals === true ? null : requireInterval(request?.interval ?? this.desk.interval)
    return { marks: this.store.listChartMarks(sessionId, coin, interval) }
  }

  addChartMark(request, sessionId, source = 'agent') {
    this.requireTradingSession(sessionId)
    const coin = requireCoin(request)
    const interval = requireInterval(request?.interval ?? this.desk.interval)
    const kind = request?.kind ?? 'level'
    const role = ['support', 'resistance', 'neutral'].includes(request?.role) ? request.role : 'neutral'
    const label = String(request?.label ?? '').trim()
    const maxLabel = TEXT_KINDS.includes(kind) ? 200 : 60
    if (!label || label.length > maxLabel) throw new Error(`图表标注需要 1-${maxLabel} 字${TEXT_KINDS.includes(kind) ? '文本' : '标签'}`)
    if (kind === 'icon' && !isIconLabel(label)) throw new Error(`图标 label 必须为 ${ICON_NAMES.join('/')} 或贴图库中的 emoji:<贴纸>`)
    const mark = { sessionId, coin, interval, kind, role, label, source, ...drawingGeometry(kind, request), ...drawingStyle({ ...request, kind }) }
    return this.store.addChartMark(mark)
  }

  /** Replace a session chart's MA lines (agent path); the desk reloads on the `chart.ma` event. */
  setSessionMaLines(sessionId, lines) {
    this.requireTradingSession(sessionId)
    const maLines = normalizeMaLines(lines)
    this.store.updateSessionWorkspace(sessionId, { maLines })
    this.store.recordEvent('chart.ma', { sessionId, ids: maLines.map((line) => line.id) })
    return maLines
  }

  /** Agent sets what the session chart shows (interval, indicator panes); the desk follows on `chart.view`. */
  setSessionChartView(sessionId, { interval, show = [], hide = [] } = {}) {
    this.requireTradingSession(sessionId)
    const unknown = [...show, ...hide].filter((id) => !INDICATOR_IDS.includes(id))
    if (unknown.length) throw new Error(`未知指标 ${unknown.join(',')}，可选：${INDICATOR_IDS.join(', ')}`)
    const current = this.store.getSessionWorkspace(sessionId)
    const patch = { indicators: [...new Set([...(current.indicators ?? []).filter((id) => !hide.includes(id)), ...show])] }
    if (interval != null) patch.interval = requireInterval(interval)
    const next = this.store.updateSessionWorkspace(sessionId, patch)
    if (this.desk?.sessionId === sessionId && patch.interval) this.desk.interval = patch.interval
    this.store.recordEvent('chart.view', { sessionId, interval: next.interval, indicators: next.indicators })
    return next
  }

  /** Move, reshape, restyle or relabel one drawing; geometry is re-validated as a whole. */
  editChartMark(id, patch, sessionId) {
    this.requireTradingSession(sessionId)
    const current = this.store.getChartMark(sessionId, String(id ?? ''))
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('画线修改无效')
    const merged = { ...current, ...patch }
    const geometryKeys = ['price', 'fromTime', 'fromPrice', 'toTime', 'toPrice', 'points']
    const fields = { ...drawingStyle({ ...patch, kind: current.kind }) }
    if (patch?.alert === true) fields.alertTriggeredAt = undefined
    // null clears a style back to its default (undo of a first restyle relies on this).
    for (const key of ['color', 'lineWidth', 'lineStyle', 'rows', 'valueArea', 'levels', 'visibleIntervals', 'fontSize', 'fillOpacity', 'bold', 'italic', 'extendLeft', 'extendRight', 'screenX', 'screenY']) if (key in patch && patch[key] === null) fields[key] = undefined
    if (geometryKeys.some((key) => key in patch)) Object.assign(fields, drawingGeometry(current.kind, merged))
    if ('label' in patch) {
      const label = String(patch.label ?? '').trim()
      const maxLabel = TEXT_KINDS.includes(current.kind) ? 200 : 60
      if (!label || label.length > maxLabel) throw new Error(`图表标注需要 1-${maxLabel} 字`)
      fields.label = label
    }
    if (current.locked && !('locked' in patch) && Object.keys(fields).length) throw new Error('该画线已锁定，先解锁再修改')
    return this.store.updateChartMark(sessionId, current.id, fields)
  }

  async updateChartMark(request) {
    return this.editChartMark(request?.id, request?.patch, String(request?.sessionId ?? ''))
  }

  /**
   * Drawing alerts: when the mid price crosses an alert-enabled line it fires once (the alert
   * switches off, the time is recorded) and the desk gets a `chart.alert` event.
   * @param mids - coin → mid (defaults to the live allMids snapshot).
   */
  /** Keep fresh mids for every HIP-3 dex that has an armed alert (polled with the alert check). */
  async refreshAlertDexMids() {
    const watched = (this.store.allChartMarks?.() ?? []).filter((mark) => mark.alert).map((mark) => mark.coin)
    if (this.cfg.tradingMode === 'paper') watched.push(...Object.keys(this.store.paper.protections ?? {}))
    const dexes = new Set(watched.filter((coin) => String(coin).includes(':')).map((coin) => coin.split(':')[0]))
    const client = this.client, network = this.cfg.network
    const rows = await Promise.all([...dexes].map(async (dex) => [dex, { at: Date.now(), mids: await this.dexMids(dex) }]))
    if (this.client !== client || this.cfg.network !== network) throw new Error('网络已切换，丢弃旧价格')
    for (const [dex, value] of rows) this.dexMidCache.set(dex, value)
  }

  checkDrawingAlerts(now = Date.now(), mids = null) {
    const watched = this.store.allChartMarks?.().filter((mark) => mark.alert && ALERT_KINDS.includes(mark.kind)) ?? []
    for (const id of [...this.alertSides.keys()]) if (!watched.some((mark) => mark.id === id)) this.alertSides.delete(id)
    if (!watched.length) return []
    let book = mids
    if (!book) {
      const key = this.touch(keys.allMids())
      const snap = this.client.snapshot(key)
      if (!snap || now - snap.at > 10_000) return []
      book = { ...(snap.data?.mids ?? snap.data) }
      for (const { at, mids: dexBook } of this.dexMidCache.values()) if (now - at <= 10_000) Object.assign(book, dexBook)
    }
    const fired = []
    for (const mark of watched) {
      const mid = Number(book?.[mark.coin])
      const line = linePriceAt(mark, now)
      if (!Number.isFinite(mid) || line == null || !Number.isFinite(line)) continue
      const side = mid > line ? 1 : mid < line ? -1 : 0
      const before = this.alertSides.get(mark.id)
      if (side !== 0) this.alertSides.set(mark.id, side)
      if (before == null || side === 0 || side === before) continue
      this.alertSides.delete(mark.id)
      const saved = this.store.updateChartMark(mark.sessionId, mark.id, { alert: false, alertTriggeredAt: now })
      const event = { sessionId: mark.shared ? null : mark.sessionId, shared: Boolean(mark.shared), coin: mark.coin, id: mark.id, label: mark.label, kind: mark.kind,
        price: mid, line, direction: side > 0 ? 'up' : 'down', at: now }
      this.store.recordEvent('chart.alert', event)
      fired.push({ ...event, mark: saved })
      // The owning session's agent hears about it too (the host decides how, with its own guard rails).
      for (const listener of this.alertListeners ?? []) { try { listener({ ...event, sessionId: mark.sessionId, mark: saved }) } catch { /* a listener must not stop the scan */ } }
    }
    return fired
  }

  /** Execute paper TP/SL from a fresh market snapshot; never infer a fill at the trigger price. */
  processPaperProtections(now = Date.now(), mids = {}) {
    if (this.cfg.tradingMode !== 'paper') return []
    const fired = []
    const book = { ...mids }
    for (const { at, mids: dexBook } of this.dexMidCache?.values?.() ?? []) if (now - at <= 10_000) Object.assign(book, dexBook)
    for (const [coin, bracket] of Object.entries(this.store.paper.protections ?? {})) {
      const pos = this.store.paper.positions[coin]
      if (!pos || Math.sign(pos.size) !== (bracket.isLong ? 1 : -1)) {
        delete this.store.paper.protections[coin]
        continue
      }
      const mid = Number(book[coin])
      if (!Number.isFinite(mid) || mid <= 0) continue
      const kind = bracket.isLong
        ? (bracket.stopLossPx != null && mid <= bracket.stopLossPx ? 'sl' : bracket.takeProfitPx != null && mid >= bracket.takeProfitPx ? 'tp' : null)
        : (bracket.stopLossPx != null && mid >= bracket.stopLossPx ? 'sl' : bracket.takeProfitPx != null && mid <= bracket.takeProfitPx ? 'tp' : null)
      if (!kind) continue
      const costs = this.store.paperCosts()
      const isBuy = !bracket.isLong
      const px = mid * (isBuy ? 1 + costs.slippageBps / 10_000 : 1 - costs.slippageBps / 10_000)
      const sz = Math.min(Math.abs(pos.size), Number(bracket.sz))
      const fill = this.store.paperFill({ coin, isBuy, sz, px, time: now, reason: `paper-${kind}-trigger`,
        sessionId: bracket.sessionId, feeBps: costs.feeBps, referencePx: mid, slippageBps: costs.slippageBps })
      this.store.paperOrderRecord({ oid: fill.oid, coin, isBuy, sz, px, filledPx: px, type: 'trigger',
        triggerKind: kind, triggerPx: kind === 'sl' ? bracket.stopLossPx : bracket.takeProfitPx,
        reduceOnly: true, sessionId: bracket.sessionId })
      this.store.recordEvent('paper.protection', { coin, kind, fill, triggerPx: kind === 'sl' ? bracket.stopLossPx : bracket.takeProfitPx })
      fired.push({ coin, kind, fill })
    }
    return fired
  }

  removeChartMark(id, sessionId) {
    this.requireTradingSession(sessionId)
    return this.store.removeChartMark(sessionId, String(id ?? ''))
  }

  /** Session-scoped workbench state shared by the native UI and agent tools. */
  async sessionWorkspace(request) {
    return this.store.getSessionWorkspace(String(request?.sessionId ?? ''))
  }

  async updateSessionWorkspace(request) {
    const sessionId = String(request?.sessionId ?? '')
    this.requireTradingSession(sessionId)
    const input = request?.patch ?? {}
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('工作台配置无效')
    const patch = {}
    if ('interval' in input) patch.interval = requireInterval(input.interval)
    if ('bookGrouping' in input) {
      if (!Object.hasOwn(BOOK_GROUPINGS, input.bookGrouping)) throw new Error('盘口精度无效')
      patch.bookGrouping = input.bookGrouping
    }
    if ('chartTab' in input) {
      if (!['chart', 'funding'].includes(input.chartTab)) throw new Error('图表页签无效')
      patch.chartTab = input.chartTab
    }
    if ('tapeTab' in input) {
      if (!['book', 'trades'].includes(input.tapeTab)) throw new Error('行情页签无效')
      patch.tapeTab = input.tapeTab
    }
    if ('bottomTab' in input) {
      if (!['positions', 'orders', 'account', 'review'].includes(input.bottomTab)) throw new Error('账户页签无效')
      patch.bottomTab = input.bottomTab
    }
    if ('indicators' in input) {
      const allowed = INDICATOR_IDS
      if (!Array.isArray(input.indicators) || input.indicators.length > allowed.length || input.indicators.some((id) => !allowed.includes(id))) throw new Error('图表指标无效')
      patch.indicators = [...new Set(input.indicators)]
    }
    if ('maLines' in input) patch.maLines = normalizeMaLines(input.maLines)
    if ('indicatorSettings' in input) patch.indicatorSettings = normalizeIndicatorSettings(input.indicatorSettings)
    if ('research' in input) patch.research = normalizeResearch(input.research)
    if ('showDataWindow' in input) { if (typeof input.showDataWindow !== 'boolean') throw Error('数据窗口设置无效'); patch.showDataWindow = input.showDataWindow }
    if ('chartType' in input) {
      if (!['candles', 'bars', 'line', 'area', 'heikinAshi'].includes(input.chartType)) throw new Error('图表类型无效')
      patch.chartType = input.chartType
    }
    if ('priceScale' in input) {
      if (!['normal', 'log', 'percentage'].includes(input.priceScale)) throw new Error('价格刻度无效')
      patch.priceScale = input.priceScale
    }
    if ('chartLayers' in input) {
      const layers = input.chartLayers
      if (!layers || typeof layers !== 'object' || Array.isArray(layers) || Object.keys(layers).some((key) => !['orders', 'fills', 'drawings', 'reasons'].includes(key)) || Object.values(layers).some((value) => typeof value !== 'boolean')) throw new Error('图表图层无效')
      patch.chartLayers = layers
    }
    if ('layout' in input) {
      const l = input.layout
      if (!l || typeof l !== 'object' || Array.isArray(l)) throw new Error('工作台布局无效')
      const clean = {}
      for (const [key, min, max] of [['sessionsWidth', 160, 400], ['chatWidth', 320, 700]]) {
        if (key in l) {
          const value = Number(l[key])
          if (!Number.isFinite(value)) throw new Error('工作台宽度无效')
          clean[key] = Math.max(min, Math.min(max, Math.round(value)))
        }
      }
      for (const key of ['sessionsCollapsed', 'deskCollapsed', 'chatCollapsed']) {
        if (key in l) {
          if (typeof l[key] !== 'boolean') throw new Error('工作台折叠状态无效')
          clean[key] = l[key]
        }
      }
      patch.layout = clean
    }
    if ('chartRanges' in input) {
      const ranges = input.chartRanges
      if (!ranges || typeof ranges !== 'object' || Array.isArray(ranges) || Object.keys(ranges).length > 1) throw new Error('图表视区无效')
      const clean = {}
      for (const [key, range] of Object.entries(ranges)) {
        if (key.length > 100 || key === '__proto__' || !range || !Number.isFinite(range.from) || !Number.isFinite(range.to) || range.from >= range.to) throw new Error('图表视区无效')
        clean[key] = { from: range.from, to: range.to }
      }
      patch.chartRanges = clean
    }
    const result = this.store.updateSessionWorkspace(sessionId, patch)
    if (this.desk?.sessionId === sessionId && patch.interval) this.desk.interval = patch.interval
    return result
  }

  async indicatorTemplates(request) {
    const action = request?.action ?? 'list'
    if (action === 'list') return { templates: this.store.indicatorTemplates() }
    if (action === 'remove') { this.store.removeIndicatorTemplate(String(request?.id ?? '')); return { templates: this.store.indicatorTemplates() } }
    if (action !== 'save') throw Error('指标模板操作无效')
    const name = String(request?.name ?? '').trim()
    if (!name || name.length > 60) throw Error('模板名称需要 1–60 个字符')
    const indicators = request?.indicators
    if (!Array.isArray(indicators) || indicators.length > INDICATOR_IDS.length || indicators.some((id) => !INDICATOR_IDS.includes(id))) throw Error('模板指标无效')
    const id = request?.id
    if (id != null && !this.store.indicatorTemplates().some((row) => row.id === id)) throw Error('指标模板不存在')
    const template = this.store.saveIndicatorTemplate({ id, name, indicators: [...new Set(indicators)], indicatorSettings: normalizeIndicatorSettings(request?.indicatorSettings), maLines: normalizeMaLines(request?.maLines ?? []) })
    return { template, templates: this.store.indicatorTemplates() }
  }

  async updatePaperCosts(request) {
    if (this.activeTradeOps > 0) throw Error('交易操作仍在进行，请稍后修改模拟成本')
    return { paperCosts: this.store.setPaperCosts(request?.costs) }
  }

  async drawChartMark(request) {
    const sessionId = String(request?.sessionId ?? '')
    // Undo re-creates a deleted agent drawing; keep its origin so the chart still labels it as the agent's.
    return this.addChartMark(request, sessionId, request?.restoreSource === 'agent' ? 'agent' : 'user')
  }

  async eraseChartMark(request) {
    const sessionId = String(request?.sessionId ?? '')
    return this.removeChartMark(request?.id, sessionId)
  }

  // ── remote methods ───────────────────────────────────────────────────

  /** Change the desk's data and trade network for this host process. */
  async switchNetwork(request) {
    const network = request?.network
    if (network !== 'mainnet' && network !== 'testnet') throw new Error('network 必须为 mainnet 或 testnet')
    if (network === this.cfg.network) return { network }
    if (this.activeTradeOps > 0) throw new Error('交易操作仍在进行，无法切换网络')
    if (network === 'mainnet' && request?.acknowledgeMainnet !== true) throw new Error('切换主网需要确认')
    const nextPaperGuard = this.cfg.dataDir ? new TradingGuard(this.cfg.dataDir, { ...this.cfg, dataDir: this.cfg.dataDir }, { budgetName: network === 'mainnet' ? 'paper-budget-mainnet.json' : 'paper-budget.json' }) : null
    this.store.selectPaperNetwork?.(network)
    const previous = this.cfg.network
    this.client.close()
    this.cfg.network = network
    this.client = new HyperliquidClient({ network, privateKey: this.cfg.privateKey })
    this.lastTouch.clear()
    this.dexMidCache?.clear()
    this.alertSides?.clear()
    this.lastLiveAccount = null
    this.marketsCache = null
    this.marketsAt = 0
    this.catalogCache = null
    this.catalogAt = 0
    this.catalogDexIndex.clear()
    this.detailCache.clear()
    this.accountModeCache = null
    this.accountModePending = null
    this.tradeCapacityCache.clear()
    this.tradeCapacityPending.clear()
    this.guard.plans.clear()
    if (nextPaperGuard) this.paperGuard = nextPaperGuard
    this.store.recordEvent('network.changed', { from: previous, to: network })
    return { network }
  }

  /** Change between real-account (live) and local paper trading for this host process. */
  async switchTradingMode(request) {
    const mode = request?.mode
    if (mode !== 'live' && mode !== 'paper') throw new Error('mode 必须为 live 或 paper')
    if (mode === this.cfg.tradingMode) return { mode }
    if (this.activeTradeOps > 0) throw new Error('交易操作仍在进行，无法切换交易模式')
    if (mode === 'live' && request?.acknowledgeLive !== true) throw new Error('切换实盘需要确认')
    const previous = this.cfg.tradingMode
    this.cfg.tradingMode = mode
    this.lastLiveAccount = null
    this.accountModeCache = null
    this.accountModePending = null
    this.tradeCapacityCache.clear()
    this.tradeCapacityPending.clear()
    this.guard.plans.clear()
    this.store.recordEvent('mode.changed', { from: previous, to: mode })
    return { mode }
  }

  /** Persist limits as one atomic override and update both live/paper guards. */
  async updateRiskSettings(request) {
    if (this.activeTradeOps > 0) throw new Error('交易操作仍在进行，暂不能修改限额')
    const limits = normalizeRiskSettings(request?.limits)
    this.store.saveRiskSettings(limits)
    this.applyRiskSettings(limits, true)
    return { riskLimits: { ...limits, usedTodayUsd: this.usedTodayUsd() } }
  }

  async resetRiskSettings(request) {
    if (this.activeTradeOps > 0) throw new Error('交易操作仍在进行，暂不能修改限额')
    this.store.clearRiskSettings()
    this.applyRiskSettings(this.baseRiskSettings, false)
    return { riskLimits: { ...this.baseRiskSettings, usedTodayUsd: this.usedTodayUsd() } }
  }

  /** Desk only: the dsh-web3 accounts the trader can sign with (no secrets, just id / label / address). */
  async walletAccounts() {
    const wallet = this.walletService()
    if (!wallet) return { available: false, accounts: [] }
    const accounts = typeof wallet.listAccounts === 'function' ? wallet.listAccounts() : []
    return { available: true, accounts: accounts.filter((row) => row?.address).map((row) => ({ id: row.id, label: row.label ?? row.id, address: row.address })) }
  }

  /**
   * Desk only (never an agent tool): change signer / web3 account / trading address at runtime. The values
   * are validated, saved, and every cached account read is dropped, so the next status and account reads
   * use the new wallet — no host restart. The private key stays in plugin config.
   */
  async updateWalletSettings(request) {
    if (this.activeTradeOps > 0) throw new Error('交易操作仍在进行，请稍后再修改钱包设置')
    const next = normalizeWalletSettings(request ?? {}, this.cfg)
    if (next.signer === 'web3') {
      const wallet = this.walletService()
      if (!wallet) throw new Error('dsh-web3 未安装或未启用：请先在 DSH 中启用 Web3 钱包插件')
      const accounts = typeof wallet.listAccounts === 'function' ? wallet.listAccounts() : []
      if (!accounts.some((row) => row?.id === next.web3Account || row?.label === next.web3Account)) {
        throw new Error(`dsh-web3 中找不到账户「${next.web3Account}」。如果它刚在另一个进程里创建，当前宿主的钱包列表还没刷新，需要重启 DSH`)
      }
    }
    if (next.signer === 'local' && !this.cfg.privateKey) throw new Error('本地签名需要在插件配置里填写私钥')
    if (next.signer === 'web3' && !next.tradingAddress) throw new Error('使用 dsh-web3 签名时需要填写 Hyperliquid 主账户地址')
    Object.assign(this.cfg, next)
    this.walletEpoch += 1
    this.store.saveWalletSettings(next)
    this.addressCache = null; this.walletAddressCache = null
    this.accountModeCache = null; this.accountModePending = null
    this.tradeCapacityCache.clear(); this.tradeCapacityPending.clear()
    this.lastLiveAccount = null
    this.guard.plans.clear()
    this.store.recordEvent('wallet.changed', { signer: next.signer, web3Account: next.web3Account, tradingAddress: next.tradingAddress })
    return { signer: next.signer, web3Account: next.web3Account, tradingAddress: next.tradingAddress, address: await this.resolveAddress() }
  }

  /** 全托管: the agent may act without per-action approval (the dsh-web3 wallet policy still applies). */
  isManaged() { return this.cfg.custody ? this.cfg.custody === 'managed' : this.cfg.autonomousLive === true }

  /** Desk only (never an agent tool): the trader picks 全托管 / 半托管. */
  async setCustody(request) {
    if (this.activeTradeOps > 0) throw new Error('交易操作仍在进行，暂不能切换托管模式')
    const mode = request?.mode
    if (mode !== 'managed' && mode !== 'assisted') throw new Error('托管模式必须为 managed（全托管）或 assisted（半托管）')
    if (mode === 'managed' && this.cfg.tradingMode === 'live' && request?.acknowledge !== true) throw new Error('开启全托管实盘需要确认')
    this.cfg.custody = this.store.saveCustody(mode)
    this.guard.plans.clear()
    this.store.recordEvent('custody.changed', { mode })
    return { custody: mode }
  }

  /**
   * Agent edit of the trading limits — 全托管 only; in 半托管 the trader changes them on the desk.
   * `addCoins` / `removeCoins` adjust the allow-list; numeric limits replace the current value.
   */
  agentUpdateRiskSettings(request) {
    if (!this.isManaged()) throw new Error('当前为半托管：交易限额与允许币对只能由你在交易台 设置 → 交易限额与签名规则 中修改；如需让 agent 自行调整，请在 设置 → 托管模式 切换为全托管')
    const current = { allowedCoins: [...this.cfg.allowedCoins], maxOrderUsd: this.cfg.maxOrderUsd, maxDailyUsd: this.cfg.maxDailyUsd, maxPositionUsd: this.cfg.maxPositionUsd, maxLeverage: this.cfg.maxLeverage }
    const add = (request?.addCoins ?? []).map((coin) => canonicalMarketCoin(coin))
    const drop = new Set((request?.removeCoins ?? []).map((coin) => canonicalMarketCoin(coin)))
    // '*' = all markets. Removing one coin from "all" needs an explicit list first (the trader's call).
    const allNow = current.allowedCoins.includes(ALL_COINS)
    if (allNow && drop.size && !drop.has(ALL_COINS)) throw new Error('当前允许全部币对；要排除某个币对，请先用 removeCoins ["*"] 并 addCoins 列出要允许的币对')
    const base = allNow && drop.has(ALL_COINS) ? [] : current.allowedCoins.filter((coin) => !drop.has(coin))
    const next = { ...current, allowedCoins: add.includes(ALL_COINS) ? [ALL_COINS] : [...new Set([...base, ...add])] }
    for (const key of ['maxOrderUsd', 'maxDailyUsd', 'maxPositionUsd', 'maxLeverage']) if (request?.[key] != null) next[key] = request[key]
    if (this.activeTradeOps > 0) throw new Error('交易操作仍在进行，暂不能修改限额')
    const limits = normalizeRiskSettings(next)
    this.store.saveRiskSettings(limits)
    this.applyRiskSettings(limits, true)
    this.store.recordEvent('risk.changed', { by: 'agent', before: current, after: limits })
    return { before: current, after: limits }
  }

  /**
   * Move USDC between any two of the trader's own accounts: the spot balance ('spot'), the core perp
   * account ('perp') and each HIP-3 dex (e.g. 'xyz'). spot ↔ perp is a `usdClassTransfer`, perp ↔ HIP-3 a
   * `sendAsset`; spot ↔ HIP-3 and HIP-3 ↔ HIP-3 go through perp in two signed legs under one approval.
   * All legs need the main wallet. 半托管 asks the trader once per transfer; 全托管 goes straight through.
   * Accepts { from, to, amount } or the original { dex, direction: 'in' | 'out', amount }.
   */
  async transferCollateral(request, exec) {
    if (this.cfg.tradingMode !== 'live') throw new Error('paper 模式没有交易所资金，无需划转')
    const transferEpoch = this.walletEpoch
    if (!exec?.agent) throw new Error('资金划转仅允许从 DSH agent 工具调用')
    exec.signal?.throwIfAborted()
    const account = (value) => { const name = String(value ?? '').trim(); return name === '' || name === 'main' || name === 'core' ? 'perp' : name }
    let from, to
    if (request?.from != null || request?.to != null) { from = account(request?.from); to = account(request?.to) }
    else {
      const dex = String(request?.dex ?? '').trim()
      if (!dex || dex.includes(':')) throw new Error('需要 from / to（spot、perp 或 HIP-3 交易所名），或 dex + direction')
      ;[from, to] = request?.direction === 'out' ? [dex, 'perp'] : ['perp', dex]
    }
    if (from === to) throw new Error('from 和 to 不能相同')
    if ([from, to].some((name) => name.includes(':'))) throw new Error('交易所名不含冒号，如 xyz')
    const amount = Number(request?.amount)
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('amount 必须为正数（USDC）')
    if (Number(amount.toFixed(6)) !== amount) throw new Error('USDC 划转金额最多 6 位小数')
    if (amount > this.cfg.maxPositionUsd) throw new Error(`单次划转不超过仓位上限 ${this.cfg.maxPositionUsd} USD`)
    // Every leg has the core perp account on one side; a route without it goes through perp.
    const legs = from === 'perp' || to === 'perp' ? [[from, to]] : [[from, 'perp'], ['perp', to]]
    const dexes = [...new Set([from, to].filter((name) => name !== 'spot' && name !== 'perp'))]
    if (dexes.length) {
      const known = await this.perpDexList()
      for (const dex of dexes) {
        if (!known.some((row) => row?.name === dex)) throw new Error(`未知的 HIP-3 交易所 ${dex}`)
        const meta = await this.client.info('meta', { dex })
        if (meta?.collateralToken !== 0) throw new Error(`${dex} 不使用 USDC 保证金，暂不支持划转`)
      }
    }
    const address = await this.resolveAddress()
    if (!address) throw new Error('live 划转需要钱包地址')
    const signerAddress = this.cfg.signer === 'web3' ? await this.web3Address() : await addressFromPrivateKey(this.cfg.privateKey)
    if (signerAddress.toLowerCase() !== address.toLowerCase()) throw new Error('资金划转需要交易主钱包签名；当前签名钱包与 tradingAddress 不一致，API wallet 不能用于划转')
    const label = (name) => name === 'spot' ? '现货账户' : name === 'perp' ? '主永续账户' : name
    const labelEn = (name) => name === 'spot' ? 'spot' : name === 'perp' ? 'core perps' : name
    // Unified / portfolio-margin accounts already share spot and perp USDC: no spot ↔ perp leg. The mode
    // must be known before signing: a failed lookup stops the transfer.
    if (from === 'spot' || to === 'spot') {
      const mode = await this.accountMode(address, true)
      if (mode === 'unifiedAccount' || mode === 'portfolioMargin') throw new Error(`账户模式为 ${mode}，现货 USDC 已直接作为保证金，现货与永续之间无需划转`)
    }
    // What can leave the source account now (the later leg spends what the first one brought into perp).
    let available
    if (from === 'spot') {
      const spot = await this.client.spotClearinghouseState(address)
      const usdc = (spot?.balances ?? []).find((row) => row.coin === 'USDC')
      available = Number(usdc?.total ?? 0) - Number(usdc?.hold ?? 0)
    } else {
      const state = from === 'perp' ? await this.client.clearinghouseState(address) : await this.client.info('clearinghouseState', { user: address, dex: from })
      available = Number(state?.withdrawable)
    }
    if (!Number.isFinite(available)) throw new Error('无法确认可划转余额')
    if (amount > available + 1e-9) throw new Error(`${label(from)}可划转 ${Math.max(0, available).toFixed(2)} USDC，不足 ${amount}`)
    const route = legs.length > 1 ? `${label(from)} → 主永续账户 → ${label(to)}（两步）` : `${label(from)} → ${label(to)}`
    const what = `${amount} USDC：${route}`
    if (!this.isManaged()) await this.authorizeToolAction(`Hyperliquid ${this.cfg.network} 划转 ${what}？`, exec,
      `Hyperliquid ${this.cfg.network}: transfer ${amount} USDC ${[from, ...legs.map(([, next]) => next)].map(labelEn).join(' → ')}?`)
    const isMainnet = this.cfg.network === 'mainnet'
    const amountText = String(Number(amount.toFixed(6)))
    let usdcToken = null
    const responses = []
    for (const [index, [source, target]] of legs.entries()) {
      // Everything before the second leg is submitted can stop it; the first leg's money then sits in perp.
      const parked = `第一步已完成（${amount} USDC 已到主永续账户）`
      let submitted = false
      try {
        if (transferEpoch !== this.walletEpoch) throw new Error('钱包已切换，划转已取消')
        exec.signal?.throwIfAborted()
        if (index > 0) {
          // The money that just arrived must be free to leave perp (positions may have taken it as margin).
          const state = await this.client.clearinghouseState(address)
          const free = Number(state?.withdrawable)
          if (!Number.isFinite(free) || free + 1e-9 < amount) throw new Error(`主永续账户可划转 ${Number.isFinite(free) ? free.toFixed(2) : '未知'} USDC，不足 ${amount}`)
        }
        const nonce = this.client.nextNonce()
        let built
        if (source === 'spot' || target === 'spot') built = buildUsdClassTransfer({ amount: amountText, toPerp: target === 'perp', nonce, isMainnet })
        else {
          if (!usdcToken) {
            const spotMeta = await this.client.info('spotMeta')
            usdcToken = (spotMeta?.tokens ?? []).find((token) => token.index === 0 && token.name === 'USDC')?.tokenId
            if (!usdcToken) throw new Error('无法读取 USDC 代币信息')
          }
          built = buildSendAsset({ destination: address, sourceDex: source === 'perp' ? '' : source, destinationDex: target === 'perp' ? '' : target, token: `USDC:${usdcToken}`, amount: amountText, nonce, isMainnet })
        }
        const signature = await this.signUserTyped(built.typed, `Hyperliquid ${this.cfg.network} 资金划转（${index + 1}/${legs.length}）：${amount} USDC ${label(source)} → ${label(target)}`, exec, signerAddress)
        // Cancelled while the wallet was signing: never submit that signature.
        exec.signal?.throwIfAborted()
        if (transferEpoch !== this.walletEpoch) throw new Error('钱包已切换，划转已取消')
        submitted = true
        const res = await this.client.exchangeUserSigned(built.action, signature, nonce)
        submitted = false
        assertExchangeAccepted(res)
        responses.push(res)
      } catch (error) {
        if (index === 0) throw error
        const reason = error?.message ?? String(error)
        this.store.recordEvent('live.transfer', { from: source, to: target, amount, failed: true, unknown: submitted, reason })
        // Submitted but no answer (timeout, network): it may have gone through. Never suggest a blind retry.
        if (submitted) throw new Error(`${parked}；第二步 主永续账户 → ${label(target)} 已提交但未收到确认（${reason}），结果未知：先用 hyper_account action=state 核对主永续与 ${label(target)} 的余额，不要直接重试`)
        throw new Error(`${parked}，第二步 主永续账户 → ${label(target)} 未完成：${reason}。资金在主永续账户，可稍后 from=perp to=${target} 补划`)
      }
      this.store.recordEvent('live.transfer', { from: source, to: target, amount, dex: [source, target].find((name) => name !== 'spot' && name !== 'perp'), toDex: target !== 'spot' && target !== 'perp' })
    }
    const dex = dexes.length === 1 ? dexes[0] : undefined
    return { ok: true, from, to, amount, legs: legs.map(([source, target]) => ({ from: source, to: target })), dex,
      direction: dex && legs.length === 1 ? (to === dex ? 'in' : 'out') : undefined, response: responses.at(-1), responses }
  }

  /** Sign a user-signed action's EIP-712 payload with the main wallet (dsh-web3 or the local key). */
  async signUserTyped(typed, purpose, exec, signerAddress) {
    if (this.cfg.signer === 'web3') {
      const wallet = this.walletService()
      if (!wallet) throw new Error('signer=web3 但 dsh-web3 未安装')
      const result = await wallet.signTypedData({ account: this.cfg.web3Account, ...typed, purpose },
        this.approvalGateway(), { toolName: 'dsh-hyperliquid', agent: exec?.agent, callId: exec?.callId, signal: exec?.signal })
      if (result?.status !== 'signed' || !result.signature) throw new Error(`dsh-web3 签名未完成（status=${result?.status}）`)
      if (result.address?.toLowerCase() !== signerAddress.toLowerCase()) throw new Error('dsh-web3 返回的签名地址与配置账户不一致')
      return splitSignature(result.signature)
    }
    if (!this.cfg.privateKey) throw new Error('live 划转需要钱包私钥')
    return signTypedDataLocal(this.cfg.privateKey, typed)
  }

  applyRiskSettings(limits, override) {
    Object.assign(this.cfg, limits)
    Object.assign(this.guard.limits, limits)
    Object.assign(this.paperGuard.limits, limits)
    this.guard.plans.clear()
    this.riskSettingsOverride = override
    this.store.recordEvent('risk.changed')
  }

  /** Today's (UTC) notional already counted against maxDailyUsd for the active mode. */
  usedTodayUsd() {
    const guard = this.cfg.tradingMode === 'paper' ? this.paperGuard : this.guard
    if (!guard?.budget) return 0
    return guard.budget.day === new Date().toISOString().slice(0, 10) ? guard.budget.usedUsd : 0
  }

  /** Plugin status: network, mode, account identity, ws health. */
  async status(request) {
    const address = await this.resolveAddress()
    const wallet = this.cfg.signer === 'web3' ? this.walletService() : null
    return {
      paperCosts: this.store.paperCosts?.() ?? { feeBps: 4.5, slippageBps: 5 },
      network: this.cfg.network,
      tradingMode: this.cfg.tradingMode,
      signer: this.cfg.signer,
      web3Account: this.cfg.web3Account,
      tradingAddress: this.cfg.tradingAddress,
      autonomousLive: this.isManaged(),
      custody: this.cfg.custody,
      riskSettingsSource: this.riskSettingsOverride ? 'desk' : 'plugin',
      riskLimits: { allowedCoins: this.cfg.allowedCoins, maxOrderUsd: this.cfg.maxOrderUsd, maxDailyUsd: this.cfg.maxDailyUsd, maxPositionUsd: this.cfg.maxPositionUsd, maxLeverage: this.cfg.maxLeverage,
        // Day budget of the ledger that applies to the current mode (paper and live are separate).
        usedTodayUsd: this.usedTodayUsd() },
      walletConfigured: this.cfg.signer === 'web3' ? Boolean(wallet && this.cfg.tradingAddress) : Boolean(this.cfg.privateKey),
      address,
      ws: this.client.wsStatus(),
      desk: { ...this.desk },
      eventSeq: this.store.eventSeq,
    }
  }

  /** Live snapshot for one coin: mids + book + recent trades (REST fallbacks for the WS warm-up window). */
  async snapshot(request) {
    const client = this.client
    const network = this.cfg?.network ?? client.network ?? 'testnet'
    const coin = requireCoin(request)
    const interval = requireInterval(request?.interval ?? this.desk.interval)
    const bookGrouping = request?.bookGrouping ?? 'full'
    if (!Object.hasOwn(BOOK_GROUPINGS, bookGrouping)) throw new Error(`不支持的盘口价格档位：${bookGrouping}`)
    const grouping = BOOK_GROUPINGS[bookGrouping]
    const bookKey = this.touch(keys.l2Book(coin))
    const groupedKey = grouping ? this.touch(keys.l2Book(coin, grouping)) : null
    const tradesKey = this.touch(keys.trades(coin))
    const candleKey = this.touch(keys.candle(coin, interval))
    this.touch(keys.allMids())
    const book = client.snapshot(bookKey)
    const groupedBook = groupedKey ? client.snapshot(groupedKey) : null
    const trades = client.snapshot(tradesKey)
    const candle = client.snapshot(candleKey)
    const mids = client.snapshot(keys.allMids())
    const now = Date.now()
    const bookFresh = book && now - book.at < 5_000
    const groupedFresh = groupedBook && now - groupedBook.at < 5_000
    const midsFresh = mids && now - mids.at < 5_000
    // Warm-up fallback: the upstream WS needs ~1s after first touch; paint
    // the first frame from REST instead of leaving the desk blank.
    const [restBook, restMids, restGrouped] = await Promise.all([
      bookFresh ? null : client.l2Book(coin).catch(() => null),
      midsFresh ? null : client.allMids().catch(() => null),
      !grouping || groupedFresh ? null : client.l2Book(coin, grouping).catch(() => null),
    ])
    if (client !== this.client) throw new Error('网络已切换，忽略旧网络行情')
    return {
      network,
      coin,
      book: bookFresh ? book.data : (restBook ?? book?.data ?? null),
      bookGrouping,
      groupedBook: grouping ? (groupedFresh ? groupedBook.data : restGrouped) : null,
      trades: trades?.data ?? null,
      candle: candle?.data ?? null,
      interval,
      mids: midsFresh ? mids.data : (restMids ?? mids?.data ?? null),
      observedAt: { book: restBook ? Date.now() : (book?.at ?? 0), groupedBook: groupedFresh ? groupedBook.at : restGrouped ? Date.now() : 0, trades: trades?.at ?? 0, candle: candle?.at ?? 0, mids: restMids ? Date.now() : (mids?.at ?? 0) },
      seqs: { book: book?.seq ?? 0, groupedBook: groupedBook?.seq ?? 0, trades: trades?.seq ?? 0, candle: candle?.seq ?? 0, mids: mids?.seq ?? 0 },
      ws: client.wsStatus(),
    }
  }

  /** Candle history via REST (the WS candle channel is an M2 upgrade). */
  async candles(request) {
    const coin = requireCoin(request)
    const interval = requireInterval(request?.interval ?? '1h')
    const endMs = Number(request?.endMs) || Date.now()
    const startMs = Number(request?.startMs) || endMs - defaultSpanMs(interval)
    let rows
    try {
      rows = await this.client.candleSnapshot(coin, interval, startMs, endMs)
    } catch (error) {
      // The info endpoint returns HTTP 500 for an unknown coin. Distinguish an
      // invalid symbol from a real market whose candle service is unavailable.
      if (error?.response?.status === 500 || /^500\s/.test(String(error?.message ?? ''))) {
        const catalog = await this.marketCatalog().catch(() => null)
        if (catalog && !catalog.markets.some((market) => market.name === coin)) {
          throw new Error(`未知市场 ${coin}；请用 hyper_market action=catalog 查询官方合约名`, { cause: error })
        }
      }
      throw error
    }
    const list = Array.isArray(rows) ? rows : []
    // HL candle timestamps are already ms since epoch.
    return { coin, interval, candles: list.map((c) => ({
      t: Number(c.t ?? c.time ?? 0),
      T: Number(c.T ?? c.closeTime ?? 0),
      o: Number(c.o), h: Number(c.h), l: Number(c.l), c: Number(c.c), v: Number(c.v),
    })) }
  }

  /** Recent hourly funding rates for the selected perpetual market. */
  async fundingHistory(request) {
    const coin = requireCoin(request)
    const startTime = Date.now() - 7 * 86400_000
    const rows = await this.client.info('fundingHistory', { coin, startTime })
    return { coin, rows: Array.isArray(rows) ? rows.slice(-168) : [] }
  }

  /** Account view: mode-aware balances and all-DEX positions when WS is fresh. */
  async account(request) {
    if (this.cfg.tradingMode === 'paper') {
      const paper = this.store.paperAccount()
      const mids = await safeMids(this, Object.keys(paper.positions ?? {}))
      const risk = paperRiskState(paper, mids)
      return { mode: 'paper', usd: paper.usd, equity: risk.equity, uPnl: risk.uPnl,
        marginUsed: risk.marksConfirmed ? risk.marginUsed : null,
        availableMargin: risk.marksConfirmed ? Math.max(0, risk.equity - risk.marginUsed) : null,
        marksConfirmed: risk.marksConfirmed, positions: risk.positions, fills: paper.fills.slice(0, 50),
        simulation: '已模拟配置的滑点与手续费；未模拟盘口深度、资金费或强平' }
    }
    const client = this.client, network = this.cfg.network
    const walletEpoch = this.walletEpoch
    const address = await this.resolveAddress()
    if (!address) throw new Error('live 模式需要钱包：在交易台 设置 → 交易限额与签名规则 → 签名与托管 中连接')
    const accountMode = await this.accountMode(address)
    const sharedBalance = accountMode === 'unifiedAccount' || accountMode === 'portfolioMargin'
    const activeCoin = canonicalMarketCoin(request?.coin ?? this.desk?.coin)
    const accountDex = activeCoin.includes(':') ? activeCoin.split(':')[0] : ''
    const stateKey = this.touch(keys.allDexsClearinghouseState(address))
    const wsState = client.snapshot(stateKey)
    const liveStates = wsState && Date.now() - wsState.at < 10_000 &&
      wsState.data?.user?.toLowerCase() === address.toLowerCase() && Array.isArray(wsState.data?.clearinghouseStates)
      ? new Map(wsState.data.clearinghouseStates.filter((entry) => Array.isArray(entry) && typeof entry[0] === 'string' && entry[1] && Array.isArray(entry[1].assetPositions)))
      : null
    const [state, open, markets, spot] = await Promise.all([
      liveStates?.get(accountDex) ?? (accountDex
        ? client.info('clearinghouseState', { user: address, dex: accountDex })
        : client.clearinghouseState(address)),
      client.frontendOpenOrders(address),
      this.markets().catch(() => null),
      sharedBalance ? client.spotClearinghouseState(address) : Promise.resolve(null),
    ])
    if (!state || !Array.isArray(state.assetPositions) || (!sharedBalance && (!state.marginSummary || !Number.isFinite(Number(state.marginSummary.accountValue))))) {
      throw new Error('交易所永续账户响应无效；账户状态未确认')
    }
    if (!Array.isArray(open)) throw new Error('交易所挂单响应无效；账户状态未确认')
    if (sharedBalance && !Array.isArray(spot?.balances)) throw new Error('交易所统一账户余额响应无效；账户状态未确认')
    const usdcRow = sharedBalance ? spot.balances.find((row) => row.coin === 'USDC' && row.token === 0) : null
    const usdcBalance = sharedBalance ? Number(usdcRow?.total ?? 0) : null
    const unheldUsdc = sharedBalance ? usdcBalance - Number(usdcRow?.hold ?? 0) : null
    if (sharedBalance && (!Number.isFinite(usdcBalance) || !Number.isFinite(unheldUsdc))) throw new Error('统一账户 USDC 余额无效')
    const isCorePerp = Boolean(markets?.universe?.some((market) => market.name === activeCoin))
    const tradeCapacity = sharedBalance && isCorePerp
      ? await this.activeAssetFor(address, activeCoin, accountMode) : null
    const marketByCoin = new Map([...(markets?.universe ?? []), ...(this.catalogCache?.markets ?? [])].map((market) => [market.name, market]))
    const positionStates = liveStates ? new Map(liveStates) : new Map()
    positionStates.set(accountDex, state)
    const assetPositions = [...positionStates].flatMap(([dex, dexState]) => (dexState.assetPositions ?? []).map((row) => ({
      dex,
      coin: row.position?.coin,
      size: Number(row.position?.szi ?? 0),
      entryPx: Number(row.position?.entryPx ?? 0),
      markPx: Number(marketByCoin.get(row.position?.coin)?.ctx?.markPx) ||
        (Number(row.position?.szi) ? Number(row.position?.positionValue) / Math.abs(Number(row.position.szi)) : null),
      positionValue: Number(row.position?.positionValue ?? 0),
      uPnl: Number(row.position?.unrealizedPnl ?? 0),
      returnOnEquity: row.position?.returnOnEquity == null ? null : Number(row.position.returnOnEquity),
      liquidationPx: row.position?.liquidationPx == null ? null : Number(row.position.liquidationPx),
      marginUsed: row.position?.marginUsed == null ? null : Number(row.position.marginUsed),
      cumFunding: row.position?.cumFunding ?? null,
      maxLeverage: row.position?.maxLeverage ?? null,
      leverage: row.position?.leverage ?? null,
    })))
    const liveAccount = {
      mode: 'live',
      address,
      accountMode,
      accountDex,
      positionsCoverage: liveStates ? 'all-dexs' : 'selected-dex',
      positionsObservedAt: liveStates ? wsState.at : Date.now(),
      balanceSource: sharedBalance ? 'spot' : 'perp',
      marginSummary: sharedBalance ? null : state.marginSummary,
      withdrawable: sharedBalance ? null : Number(state.withdrawable),
      usdcBalance,
      unheldUsdc,
      spotBalances: sharedBalance ? spot.balances : null,
      tradeCapacity,
      positions: assetPositions,
      openOrders: open,
    }
    // The system prompt reads this (synchronously) to warn about unprotected positions.
    if (this.client !== client || this.cfg.network !== network || this.cfg.tradingMode !== 'live') throw new Error('账户环境已切换，请重新读取')
    // A response that started under the previous wallet must not land in the new wallet's view.
    if (walletEpoch !== this.walletEpoch) throw new Error('钱包已切换，账户数据已过期')
    this.lastLiveAccount = { at: Date.now(), network, value: liveAccount }
    return liveAccount
  }

  /** Open orders (live mode; paper has none resting). */
  async orders(request) {
    if (this.cfg.tradingMode === 'paper') return { mode: 'paper', orders: [] }
    const address = await this.resolveAddress()
    if (!address) throw new Error('live 模式需要钱包（config.privateKey 或 signer=web3）')
    const rows = await this.client.frontendOpenOrders(address)
    return { mode: 'live', orders: Array.isArray(rows) ? rows : [] }
  }

  /** Recent fills (live mode; paper reads the local ledger). */
  async fills(request) {
    if (this.cfg.tradingMode === 'paper') {
      return { mode: 'paper', fills: this.store.paperAccount().fills.slice(0, 100) }
    }
    const address = await this.resolveAddress()
    if (!address) throw new Error('live 模式需要钱包（config.privateKey 或 signer=web3）')
    const rows = await this.client.userFills(address)
    return { mode: 'live', fills: Array.isArray(rows) ? rows : [] }
  }

  /** Explicitly loaded history: these weighted API calls must not join the 3s account poll. */
  async tradeHistory(request) {
    const client = this.client, mode = this.cfg.tradingMode, network = this.cfg.network
    if (request?.days != null && ![7, 30, 90].includes(request.days)) throw Error('复盘支持最近 7/30/90 天')
    const end = Date.now(), requestedStart = request?.days != null ? end - request.days * 86_400_000 : request?.startTime == null ? null : Number(request.startTime)
    if (requestedStart != null && (!Number.isFinite(requestedStart) || requestedStart < end - 90 * 86_400_000 || requestedStart >= end)) throw Error('复盘时间范围必须在最近 90 天内')
    const start = requestedStart ?? Math.max(0, end - 30 * 86_400_000)
    let result
    if (mode === 'paper') {
      const paper = this.store.paperAccount()
      result = { mode: 'paper', orders: paper.orders.slice(0, 5000), fills: paper.fills.slice(0, 5000), paperCosts: this.store.paperCosts(), funding: [],
        coverage: { fundingStatus: 'not-simulated', fillsLimited: paper.fills.length >= 200, ordersLimited: paper.orders.length >= 200 } }
    } else {
      const address = await this.resolveAddress()
      if (!address) throw Error('未配置交易主账户地址')
      const [orders, fills] = await Promise.all([client.historicalOrders(address), client.userFills(address)])
      if (!Array.isArray(orders) || !Array.isArray(fills)) throw Error('交易所历史数据响应无效')
      const decisions = this.store.liveDecisions ?? {}
      const rows = orders.slice(0, 2000).map((entry) => {
        const order = entry.order ?? entry, local = this.store.liveOrders?.[order.cloid], decision = decisions[local?.decisionId]
        return { ...order, status: entry.status ?? local?.status ?? 'unknown', statusTimestamp: entry.statusTimestamp,
          referencePx: decision?.preview?.mid ?? null,
          reason: local?.thesis ?? decision?.thesis ?? null, sessionId: local?.sessionId ?? decision?.sessionId ?? null }
      })
      result = { mode: 'live', orders: rows, fills: fills.slice(0, 2000), funding: [],
        coverage: { fundingStatus: 'not-requested', fillsLimited: fills.length >= 2000, ordersLimited: orders.length >= 2000 },
        localOrders: Object.entries(this.store.liveOrders ?? {}).map(([cloid, row]) => ({ cloid, coin: row.coin, status: row.status, at: row.updatedAt ?? row.at, sessionId: row.sessionId })) }
      if (request?.includeFunding) {
        try {
          const funding = await fundingWindow(client, address, start, end)
          result.funding = funding.rows
          result.coverage.fundingStatus = funding.status
        } catch (error) { result.coverage.fundingStatus = 'error'; result.coverage.fundingError = String(error?.message ?? error) }
      }
    }
    if (requestedStart != null) {
      result.fills = result.fills.filter((row) => Number(row.time) >= start && Number(row.time) <= end)
      const ids = new Set(result.fills.filter((row) => row.oid != null).map((row) => `${row.coin}:${row.oid}`))
      result.orders = result.orders.filter((row) => Number(row.timestamp ?? row.time) >= start || ids.has(`${row.coin}:${row.oid}`))
    }
    return { ...result, network, observedAt: Date.now(), coverage: { ...result.coverage, startTime: start, endTime: end, bounded: true } }
  }

  /** Hyperliquid portfolio samples are display data, not an accounting ledger. */
  async portfolio(request) {
    if (this.cfg.tradingMode === 'paper') {
      const account = await this.account({})
      const fills = this.store.paperAccount().fills
      return { mode: 'paper', equity: account.equity, unrealizedPnl: account.uPnl,
        realizedPnl: fills.reduce((sum, fill) => sum + Number(fill.realized ?? 0), 0),
        fees: fills.reduce((sum, fill) => sum + Number(fill.fee ?? 0), 0),
        netRealizedPnl: fills.some((fill) => fill.fee == null) ? null : fills.reduce((sum, fill) => sum + Number(fill.realized ?? 0) - Number(fill.fee), 0),
        retainedFills: fills.length, series: {} }
    }
    const address = await this.resolveAddress()
    if (!address) throw new Error('未配置交易主账户地址')
    const rows = await this.client.portfolio(address)
    if (!Array.isArray(rows)) throw new Error('交易所收益数据响应无效')
    return { mode: 'live', series: Object.fromEntries(rows.filter((row) => Array.isArray(row) && typeof row[0] === 'string' && row[1])) }
  }

  async orderStatus(request) {
    if (this.cfg.tradingMode !== 'live') throw new Error('paper 模式没有交易所订单状态')
    const raw = request?.oid
    const oid = typeof raw === 'string' && /^[1-9][0-9]*$/.test(raw) ? Number(raw) : raw
    if (!(Number.isInteger(oid) && oid > 0) && !/^0x[0-9a-fA-F]{32}$/.test(String(oid ?? ''))) throw new Error('orderStatus 需要 oid 或 128 位 cloid')
    const address = await this.resolveAddress()
    if (!address) throw new Error('未配置交易主账户地址')
    const exchange = await this.client.info('orderStatus', { user: address, oid })
    const local = typeof oid === 'string' ? this.store.getLiveOrder(oid) : null
    return { exchange, local }
  }

  // ── trading sessions ─────────────────────────────────────────────────
  async sessions(request) {
    return { sessions: this.store.listSessions() }
  }

  async registerSession(request) {
    const sessionId = String(request?.sessionId ?? '').trim()
    if (!sessionId) throw new Error('registerSession requires sessionId')
    const row = this.store.registerSession(sessionId, { coin: request?.coin == null ? undefined : canonicalMarketCoin(request.coin), title: request?.title })
    this.store.recordEvent('session.register', { sessionId })
    // The Agent usually predates its registration (the desk creates the session,
    // then registers it); index.js attaches the scoped desk prompt here.
    try { this.attachDeskPrompt?.(sessionId) } catch { /* prompt scope is best effort */ }
    return row
  }

  async removeSession(request) {
    const sessionId = String(request?.sessionId ?? '').trim()
    if (!sessionId) throw new Error('removeSession requires sessionId')
    this.store.removeSession(sessionId)
    return { ok: true }
  }

  async bindCoin(request) {
    const sessionId = String(request?.sessionId ?? '').trim()
    const coin = requireCoin(request)
    const source = request?.source === 'ui' ? 'ui' : 'agent'
    const clientId = source === 'ui' ? String(request?.clientId ?? '') : ''
    // Commit the session binding before publishing the desk focus. An agent
    // changing a background session must not move the visible desk.
    const row = sessionId ? this.store.bindCoin(sessionId, coin) : null
    if (source === 'ui') this.desk.sessionId = sessionId || null
    if (!this.desk.sessionId || this.desk.sessionId === sessionId) {
      this.desk.coin = coin
      this.store.recordEvent('desk.state', { ...this.desk, source, clientId })
    }
    if (row) {
      this.store.recordEvent('session.coin', { sessionId, coin, source, clientId })
      return row
    }
    return { coin }
  }

  /**
   * Desk focus two-way sync: the UI pushes what the user is looking at
   * (coin/interval); the agent reads the same state through status() and the
   * dynamic system-prompt section. Agent-driven changes (bindCoin) publish
   * `desk.state` events the UI follows back.
   */
  async deskState(request) {
    const patch = {}
    if (request?.coin !== undefined) patch.coin = requireCoin(request)
    if (request?.sessionId === null) this.desk.sessionId = null
    if (request?.interval !== undefined) {
      const iv = String(request.interval)
      if (!INTERVALS.includes(iv)) throw new Error(`不支持的 K 线周期：${iv}`)
      patch.interval = iv
    }
    if (patch.coin !== undefined && patch.coin !== this.desk.coin) {
      this.desk.coin = patch.coin
      this.store.recordEvent('desk.state', { ...this.desk, source: 'ui', clientId: String(request?.clientId ?? '') })
    }
    if (patch.interval !== undefined) this.desk.interval = patch.interval
    return { ...this.desk }
  }

  // ── orders ───────────────────────────────────────────────────────────
  /** Agent proposal: quote, account and hard limits are checked on the host. */
  async prepareOrder(request, sessionId) {
    if (this.cfg.tradingMode !== 'live') throw new Error('paper 下单无需 live 决策预检')
    this.requireTradingSession(sessionId)
    const thesis = String(request?.thesis ?? '').trim()
    if (thesis.length < 10 || thesis.length > 1000) throw new Error('交易决策需要 10-1000 字的依据')
    const order = orderOf(request)
    const epoch = this.walletEpoch
    const checked = await this.checkLiveOrder(order)
    // A wallet switch while the pre-check was in flight voids it: the decision belongs to the old wallet.
    if (epoch !== this.walletEpoch) throw new Error('钱包已切换，请重新预检')
    const preview = { ...checked, walletEpoch: epoch }
    const decision = this.guard.create(order, sessionId, preview)
    this.store.recordLiveDecision(decision.decisionId, { sessionId, order, thesis, preview, expiresAt: decision.expiresAt })
    return decision
  }

  async checkLiveOrder(order) {
    const client = this.client
    const network = this.cfg.network
    if ((order.takeProfitPx != null || order.stopLossPx != null) && this.cfg.network !== 'testnet') {
      throw new Error('分组止盈止损尚待 funded testnet 验收，目前仅在 testnet 开放')
    }
    const address = await this.resolveAddress()
    if (!address) throw new Error('live 交易需要有效的 tradingAddress 或本地钱包')
    if (this.cfg.signer === 'web3') await this.web3Address()
    const asset = await this.tradeAsset(order.coin)
    // A HIP-3 dex has its own clearinghouse: margin, positions and withdrawable live there.
    const [mids, state, accountMode] = await Promise.all([
      asset.dex ? this.dexMids(asset.dex) : client.allMids(),
      asset.dex ? client.info('clearinghouseState', { user: address, dex: asset.dex }) : client.clearinghouseState(address),
      this.accountMode(address, true),
    ])
    if (!Array.isArray(state?.assetPositions)) throw new Error('交易所持仓状态未确认，拒绝 live 下单')
    const sharedBalance = accountMode === 'unifiedAccount' || accountMode === 'portfolioMargin'
    let positionStates = [state]
    if (sharedBalance) {
      // Shared USDC backs every perp venue. Read fresh positions rather than
      // the UI's partial/cached snapshot; Standard only risks its own dex equity.
      const [dexs, metas] = await Promise.all([client.info('perpDexs'), accountMode === 'unifiedAccount' ? client.info('allPerpMetas') : Promise.resolve(null)])
      if (!Array.isArray(dexs) || dexs.some((dex) => dex !== null && (typeof dex?.name !== 'string' || !dex.name))) throw new Error('交易所持仓状态未确认：无法读取交易所列表')
      if (metas && (!Array.isArray(metas) || metas.length !== dexs.length || metas.some((meta) => !Number.isInteger(meta?.collateralToken)))) throw new Error('交易所持仓状态未确认：无法核对保证金资产')
      if (accountMode === 'unifiedAccount' && !metas) throw new Error('交易所持仓状态未确认：无法核对保证金资产')
      // Unified pools are per collateral token; USDH/USDT dexes do not spend
      // USDC. Portfolio mode remains conservative across its eligible assets.
      const pooledDexs = dexs.filter((dex, index) => dex && (!metas || metas[index].collateralToken === 0))
      const names = [...new Set(['', asset.dex ?? '', ...pooledDexs.map((dex) => dex.name)])]
      positionStates = await Promise.all(names.map((dex) => dex === (asset.dex ?? '') ? state
        : dex ? client.info('clearinghouseState', { user: address, dex }) : client.clearinghouseState(address)))
      if (positionStates.some((value) => !Array.isArray(value?.assetPositions))) throw new Error('交易所持仓状态未确认，拒绝 live 下单')
    }
    const mid = Number(mids?.mids?.[order.coin] ?? mids?.[order.coin])
    if (!Number.isFinite(mid) || mid <= 0) throw new Error('无法获取实时价格，拒绝 live 下单')
    validateProtection(order, mid)
    if (Number(wireSz(order.sz, asset.szDecimals)) !== order.sz) throw new Error(`数量不符合 ${order.coin} 的精度 ${asset.szDecimals}`)
    const row = (state?.assetPositions ?? []).find((p) => p.position?.coin === order.coin)?.position
    const otherExposureUsd = positionStates.flatMap((value) => value.assetPositions).reduce((sum, p) => {
      if (p.position?.coin === order.coin) return sum
      const value = Number(p.position?.positionValue)
      if (!Number.isFinite(value)) throw new Error('无法读取其他仓位敞口')
      return sum + Math.abs(value)
    }, 0)
    const positionSize = Number(row?.szi ?? 0)
    const leverage = Number(row?.leverage?.value ?? row?.leverage?.leverage ?? 1)
    let accountValue = Number(state?.marginSummary?.accountValue)
    if (sharedBalance) {
      const [spot, capacity] = await Promise.all([
        client.spotClearinghouseState(address), client.activeAssetData(address, order.coin),
      ])
      if (!Array.isArray(spot?.balances) || !validTradeCapacity(capacity, order.coin)) throw new Error('统一账户余额或可交易额度未确认，拒绝 live 下单')
      // Core perps use USDC collateral. Other eligible portfolio assets cannot
      // be valued as dollars here; this bound may reject a funded portfolio.
      accountValue = Number(spot.balances.find((balance) => balance.coin === 'USDC' && balance.token === 0)?.total ?? 0)
      const sideCapacity = Math.min(...capacity.maxTradeSzs.map(Number))
      if (!order.reduceOnly && order.sz > sideCapacity + 1e-10) throw new Error('订单数量超过交易所当前可交易额度')
    }
    if (asset.dex && !sharedBalance && !order.reduceOnly && !(accountValue > 0)) {
      throw new Error(`${asset.dex} 是独立保证金的 HIP-3 交易所，账户里没有 USDC。请在 Hyperliquid 网页把 USDC 从主永续账户划转到 ${asset.dex}，或开启统一账户（Unified Account），之后 HIP-3 下单会自动调用主账户余额`)
    }
    const riskPrice = order.type === 'limit' ? Math.max(mid * 1.05, order.px) : mid * 1.05
    const checked = this.guard.validate({ ...order, price: riskPrice, positionSize, otherExposureUsd, accountValue, leverage })
    if (client !== this.client || network !== this.cfg.network) throw new Error('网络已切换，请重新预检交易')
    return { coin: order.coin, dex: asset.dex, side: order.isBuy ? 'buy' : 'sell', mid, riskPrice, accountValue, accountMode, positionSize, otherExposureUsd, leverage, ...checked, network, address }
  }

  async executeToolOrder(request, exec, sessionId) {
    this.requireTradingSession(sessionId)
    return this.placeOrder({ ...request, [TOOL_CALL]: { exec, sessionId } })
  }

  requireTradingSession(sessionId) {
    if (!sessionId || !this.store.getSession(sessionId)) throw new Error('交易操作必须来自已登记的交易会话')
  }

  async authorizeToolAction(reason, exec, english = reason) {
    if (!exec?.agent) throw new Error('live 签名仅允许从 DSH agent 工具调用')
    // reason stays the audit text; displayReason only localizes the approval panel.
    const outcome = await this.approvalGateway().request({ toolName: 'dsh-hyperliquid', callId: exec.callId, agent: exec.agent, signal: exec.signal, reason,
      displayReason: { en: english, zh: reason } })
    if (outcome !== 'allowed-once') throw new Error(`用户未批准 live 操作（${outcome}）`)
  }

  /**
   * THE order path — every order (tool or UI) goes through here.
   * Wire contract (research §3.2/§4.4): orders carry SHORT keys
   * `{a, b, p, s, r, t}` where `a` is the universe index and px/sz are
   * decimal STRINGS with trailing zeros stripped; market orders are Ioc
   * limit orders at ±5% by default.
   * @returns paper: the fill; live: the exchange response
   */
  async placeOrder(request) {
    const coin = requireCoin(request)
    if (typeof request?.isBuy !== 'boolean') throw new Error('place 需要明确的 isBuy 布尔值')
    const isBuy = request.isBuy
    const sz = Number(request?.sz)
    if (!Number.isFinite(sz) || sz <= 0) throw new Error('下单数量 sz 必须为正数')
    const reduceOnly = Boolean(request?.reduceOnly)
    if (this.cfg.tradingMode === 'paper') {
      await this.tradeAsset(coin)
      const mid = await this.midOf(coin)
      const pos = this.store.paper.positions[coin]?.size ?? 0
      const hasProtection = request?.takeProfitPx != null || request?.stopLossPx != null
      if (hasProtection && (reduceOnly || pos !== 0)) throw new Error('paper 保护单只支持从空仓开仓；已有仓位请先平仓')
      if (pos !== 0 && Math.sign(isBuy ? sz : -sz) === Math.sign(pos) && this.store.paper.protections?.[coin]) {
        throw new Error('已有受保护 paper 仓位，暂不支持加仓')
      }
      const takeProfitPx = request?.takeProfitPx == null ? null : Number(request.takeProfitPx)
      const stopLossPx = request?.stopLossPx == null ? null : Number(request.stopLossPx)
      for (const value of [takeProfitPx, stopLossPx]) if (value != null && (!Number.isFinite(value) || value <= 0)) throw new Error('paper 保护价必须为正数')
      if (takeProfitPx != null && (isBuy ? takeProfitPx <= mid : takeProfitPx >= mid)) throw new Error('止盈价必须位于盈利方向')
      if (stopLossPx != null && (isBuy ? stopLossPx >= mid : stopLossPx <= mid)) throw new Error('止损价必须位于亏损方向')
      if (reduceOnly && (pos === 0 || Math.sign(isBuy ? sz : -sz) === Math.sign(pos) || sz > Math.abs(pos) + 1e-10)) throw new Error('只减仓订单会增加或翻转仓位')
      if (request?.type === 'limit') {
        const limit = Number(request?.px)
        if (!Number.isFinite(limit) || limit <= 0) throw new Error('限价单需要有效 px')
        if ((isBuy && limit < mid) || (!isBuy && limit > mid)) throw new Error('paper 当前只支持可立即成交的限价单')
      }
      const costs = this.store.paperCosts()
      const slip = request?.slippagePct == null ? null : Number(request.slippagePct)
      const pct = slip != null && Number.isFinite(slip) ? Math.min(Math.max(slip, 0), 10) / 100 : costs.slippageBps / 10_000
      const px = mid * (isBuy ? 1 + pct : 1 - pct)
      if (request?.type === 'limit' && (isBuy ? px > Number(request.px) : px < Number(request.px))) throw new Error('paper 模拟滑点后无法满足限价')
      const paper = this.store.paperAccount()
      const risk = paperRiskState(paper, { ...await safeMids(this, Object.keys(paper.positions)), [coin]: mid }, true)
      const positionSize = Number(paper.positions[coin]?.size ?? 0)
      const leverage = Number(paper.positions[coin]?.leverage ?? paper.leverageByCoin?.[coin] ?? 1)
      const otherExposureUsd = risk.positions.reduce((sum, p) => sum + (p.coin === coin ? 0 : Math.abs(p.size) * p.markPx), 0)
      const guard = this.paperGuard ??= new TradingGuard(this.cfg.dataDir, { ...this.cfg, dataDir: this.cfg.dataDir }, { budgetName: this.cfg.network === 'mainnet' ? 'paper-budget-mainnet.json' : 'paper-budget.json' })
      const checked = guard.validate({ coin, isBuy, sz, price: px, positionSize, otherExposureUsd, accountValue: risk.equity, leverage, reduceOnly })
      const currentMargin = Math.abs(positionSize) * mid / leverage
      const projectedMargin = risk.marginUsed - currentMargin + Math.abs(checked.nextSize) * mid / leverage
      const projectedEquity = risk.equity - checked.notionalUsd * costs.feeBps / 10_000 - sz * (isBuy ? px - mid : mid - px)
      if (!checked.riskReducing && projectedMargin > projectedEquity + 1e-8) throw new Error('模拟账户可用保证金不足')
      const budgetTicket = guard.reserve(checked.notionalUsd, { riskReducing: checked.riskReducing })
      let fill
      const sessionId = request?.[TOOL_CALL]?.sessionId ?? null
      try { fill = this.store.paperFill({ coin, isBuy, sz, px, reason: request?.reason ?? 'chat', sessionId, feeBps: costs.feeBps,
        referencePx: mid, slippageBps: pct * 10_000,
        protection: hasProtection ? { isLong: isBuy, takeProfitPx, stopLossPx } : null }) }
      catch (err) { guard.release(budgetTicket); throw err }
      this.store.paperOrderRecord({ oid: fill.oid, referencePx: mid, coin, isBuy, sz, px: request?.type === 'limit' ? Number(request.px) : px,
        filledPx: px, type: request?.type === 'limit' ? 'limit' : 'market', reduceOnly,
        reason: request?.reason ?? '', sessionId, takeProfitPx, stopLossPx })
      return { mode: 'paper', fill, marginUsed: projectedMargin, availableMargin: Math.max(0, projectedEquity - projectedMargin),
        simulation: '已模拟配置的滑点、手续费与运行期间的止盈止损触发；未模拟盘口深度、资金费、强平或断线期间触发' }
    }
    // live
    const trusted = request?.[TOOL_CALL]
    if (!trusted?.exec?.agent) throw new Error('live 下单仅允许从 DSH agent 工具调用')
    const orderSpec = orderOf(request)
    const preview = this.guard.consume(request?.decisionId, orderSpec, trusted.sessionId)
    if (preview.network !== this.cfg.network) throw new Error('交易决策的网络与当前网络不一致，请重新预检')
    if (preview.walletEpoch !== this.walletEpoch) throw new Error('交易决策来自切换前的钱包，请重新预检')
    const fresh = await this.checkLiveOrder(orderSpec)
    if (String(fresh.address ?? '').toLowerCase() !== String(preview.address ?? '').toLowerCase() || preview.walletEpoch !== this.walletEpoch) {
      throw new Error('交易账户与预检时不一致，请重新预检')
    }
    if (Math.abs(fresh.mid / preview.mid - 1) > 0.01) throw new Error('价格已偏离预检超过 1%，请重新决策')
    if (!this.isManaged()) {
      await this.authorizeToolAction(`Hyperliquid ${this.cfg.network} ${coin} ${isBuy ? '买入' : '卖出'} ${sz}，预估名义价值 ${fresh.notionalUsd.toFixed(2)} USD。是否允许本次交易？`, trusted.exec,
        `Hyperliquid ${this.cfg.network}: ${isBuy ? 'buy' : 'sell'} ${sz} ${coin}, estimated notional ${fresh.notionalUsd.toFixed(2)} USD. Allow this trade?`)
    }
    const { asset: idx, szDecimals } = await this.tradeAsset(coin)
    const tif = request?.type === 'limit' ? (request?.tif === 'Alo' ? 'Alo' : 'Gtc') : 'Ioc'
    const mid = await this.midOf(coin)
    let pxNum
    if (request?.type === 'limit') {
      pxNum = Number(request?.px)
      if (!Number.isFinite(pxNum) || pxNum <= 0) throw new Error('限价单需要有效 px')
    } else {
      // Market = Ioc limit; docs/SDK use a 5% slippage collar.
      pxNum = mid * (isBuy ? 1.05 : 0.95)
    }
    // Exchange rule: minimum order notional is $10 (rejected otherwise).
    const notional = pxNum * sz
    if (!(notional >= 10)) {
      throw new Error(`订单名义价值 ${notional.toFixed(2)} USD 低于 Hyperliquid 最低 10 USD`)
    }
    const order = {
      a: idx,
      b: isBuy,
      p: wirePx(pxNum, szDecimals),
      s: wireSz(sz, szDecimals),
      r: reduceOnly,
      t: { limit: { tif } },
      c: '0x' + request.decisionId.replaceAll('-', ''),
    }
    const children = protectionOrders(orderSpec, idx, szDecimals, order.s)
    if (children.length) {
      const triggerOf = (kind) => {
        const child = children.find((row) => row.t.trigger.tpsl === kind)
        return child ? Number(child.t.trigger.triggerPx) : null
      }
      validateProtection({ ...orderSpec, px: orderSpec.type === 'limit' ? Number(order.p) : null,
        takeProfitPx: triggerOf('tp'), stopLossPx: triggerOf('sl') }, mid)
    }
    const action = { type: 'order', orders: [order, ...children], grouping: children.length ? 'normalTpsl' : 'na' }
    const budgetTicket = this.guard.reserve(fresh.notionalUsd, { riskReducing: fresh.riskReducing })
    this.store.recordLiveOrder(order.c, { status: 'submitting', coin, isBuy, sz, sessionId: trusted.sessionId,
      decisionId: request.decisionId, thesis: this.store.liveDecisions?.[request.decisionId]?.thesis ?? null,
      protection: { takeProfitPx: orderSpec.takeProfitPx, stopLossPx: orderSpec.stopLossPx }, at: Date.now() })
    let res
    try {
      res = await this.submitAction(action, trusted.exec)
    } catch (err) {
      this.store.recordLiveOrder(order.c, { status: 'unknown', error: String(err?.message ?? err) })
      throw new Error(`订单状态未确认；请先用 hyper_account action=orderStatus, oid=${order.c} 查询，勿直接重下。原因：${String(err?.message ?? err)}`)
    }
    try {
      assertExchangeAccepted(res)
      if (children.length && res?.response?.data?.statuses?.length !== action.orders.length) throw new Error('保护单回执不完整')
    } catch (err) {
      const parent = res?.response?.data?.statuses?.[0]
      if ((parent && !parent.error && (parent.resting || parent.filled)) || (children.length && res?.status === 'ok')) {
        this.store.recordLiveOrder(order.c, { status: 'protection-unknown', response: res })
        throw new Error(`主单可能已生效，但保护单未全部确认；请立即核对挂单、持仓和订单 ${order.c}，勿直接重下。原因：${String(err?.message ?? err)}`)
      }
      this.guard.release(budgetTicket)
      this.store.recordLiveOrder(order.c, { status: 'rejected', response: res })
      throw err
    }
    const parentFilledSz = Number(res?.response?.data?.statuses?.[0]?.filled?.totalSz)
    const protectionState = children.length
      ? parentFilledSz >= Number(order.s) - 1e-10 ? 'verify-active' : 'parent-not-fully-filled'
      : null
    this.store.recordLiveOrder(order.c, { status: 'accepted', protectionState, response: res })
    return { mode: 'live', cloid: order.c, protectionState, response: res }
  }

  async cancelOrder(request) {
    const coin = requireCoin(request)
    const oid = Number(request?.oid)
    if (!Number.isInteger(oid) || oid <= 0) throw new Error('cancelOrder 需要有效的 oid')
    if (this.cfg.tradingMode === 'paper') throw new Error('paper 模式没有挂单')
    const exec = request?.[TOOL_CALL]?.exec
    if (!exec?.agent) throw new Error('live 撤单仅允许从 DSH agent 工具调用')
    if (!this.isManaged() || !coinAllowed(this.cfg.allowedCoins, coin)) await this.authorizeToolAction(`Hyperliquid ${this.cfg.network} 撤销 ${coin} 订单 oid=${oid}？`, exec, `Hyperliquid ${this.cfg.network}: cancel ${coin} order oid=${oid}?`)
    const { asset: idx } = await this.tradeAsset(coin)
    const res = await this.submitAction({ type: 'cancel', cancels: [{ a: idx, o: oid }] }, exec)
    assertExchangeAccepted(res)
    this.store.recordEvent('live.cancel', { coin, oid })
    return { mode: 'live', response: res }
  }

  async setLeverage(request) {
    const coin = requireCoin(request)
    const leverage = Number(request?.leverage)
    if (!Number.isInteger(leverage) || leverage < 1 || leverage > 50) throw new Error('leverage 需要是 1-50 的整数')
    const market = await this.tradeAsset(coin)
    const idx = market.asset
    if (leverage > Number(market.maxLeverage ?? 50)) throw new Error(`杠杆超过 ${coin} 市场上限 ${market.maxLeverage}x`)
    if (market.onlyIsolated && request?.marginMode === 'cross') throw new Error(`${coin} 只支持逐仓`)
    const isCross = request?.marginMode !== 'isolated' && !market.onlyIsolated
    if (this.cfg.tradingMode === 'paper') {
      if (leverage > this.cfg.maxLeverage) throw new Error(`杠杆超过配置上限 ${this.cfg.maxLeverage}x`)
      if (!coinAllowed(this.cfg.allowedCoins, coin)) throw new Error(`${coin} 不在允许交易币对内`)
      const paper = this.store.paperAccount()
      if (paper.positions[coin]) {
        const risk = paperRiskState(paper, await safeMids(this, Object.keys(paper.positions)), true)
        const pos = paper.positions[coin]
        const marked = risk.positions.find((row) => row.coin === coin)
        const currentMargin = Math.abs(pos.size) * marked.markPx / marked.leverage
        const projectedMargin = risk.marginUsed - currentMargin + Math.abs(pos.size) * marked.markPx / leverage
        if (projectedMargin > risk.equity + 1e-8) throw new Error('降低杠杆后模拟账户保证金不足')
      }
      this.store.paperSetLeverage(coin, leverage)
      return { mode: 'paper', ok: true }
    }
    if (leverage > this.cfg.maxLeverage) throw new Error(`杠杆超过配置上限 ${this.cfg.maxLeverage}x`)
    if (!coinAllowed(this.cfg.allowedCoins, coin)) throw new Error(`交易限额：${coin} 不在允许交易币对内（allowedCoins）`)
    const exec = request?.[TOOL_CALL]?.exec
    if (!exec?.agent) throw new Error('live 杠杆变更仅允许从 DSH agent 工具调用')
    if (!this.isManaged()) await this.authorizeToolAction(`Hyperliquid ${this.cfg.network} 将 ${coin} 杠杆设为 ${leverage}x？`, exec, `Hyperliquid ${this.cfg.network}: set ${coin} leverage to ${leverage}x?`)
    const res = await this.submitAction({ type: 'updateLeverage', asset: idx, isCross, leverage }, exec)
    assertExchangeAccepted(res)
    this.store.recordEvent('live.leverage', { coin, leverage, isCross })
    return { mode: 'live', response: res }
  }

  executeToolCancel(request, exec) {
    this.requireTradingSession(exec?.agent?.id ?? exec?.agent?.session?.id)
    return this.cancelOrder({ ...request, [TOOL_CALL]: { exec } })
  }
  executeToolLeverage(request, exec) {
    this.requireTradingSession(exec?.agent?.id ?? exec?.agent?.session?.id)
    return this.setLeverage({ ...request, [TOOL_CALL]: { exec } })
  }

  /** UI event ring replay (order placed, fills, session changes). */
  async eventsSince(request) {
    return this.store.eventsSince(Number(request?.seq) || 0)
  }

  /** Stop the WS loop on teardown. */
  stopWs() {
    clearInterval(this.sweepTimer)
    clearInterval(this.alertTimer)
    this.client.close()
  }
}

// ── helpers ────────────────────────────────────────────────────────────
function requireCoin(request) {
  const coin = canonicalMarketCoin(request?.coin)
  if (!coin) throw new Error('需要 coin（如 BTC / ETH）')
  return coin
}

const INTERVALS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d', '3d', '1w', '1M']

function requireInterval(value) {
  const interval = String(value)
  if (!INTERVALS.includes(interval)) throw new Error(`不支持的 K 线周期：${interval}`)
  return interval
}

function orderOf(request) {
  return {
    coin: requireCoin(request),
    isBuy: request?.isBuy,
    sz: Number(request?.sz),
    type: request?.type === 'limit' ? 'limit' : 'market',
    px: request?.type === 'limit' ? Number(request?.px) : null,
    tif: request?.tif === 'Alo' ? 'Alo' : 'Gtc',
    reduceOnly: request?.reduceOnly === true,
    takeProfitPx: request?.takeProfitPx == null ? null : Number(request.takeProfitPx),
    stopLossPx: request?.stopLossPx == null ? null : Number(request.stopLossPx),
  }
}

function validateProtection(order, mid) {
  const tp = order.takeProfitPx
  const sl = order.stopLossPx
  if (tp == null && sl == null) return
  if (order.reduceOnly) throw new Error('只减仓主单不能附加新的止盈止损保护单')
  const entry = order.type === 'limit' ? order.px : mid
  if (!Number.isFinite(entry) || entry <= 0) throw new Error('保护单需要有效的主单价格')
  const upper = Math.max(entry, mid)
  const lower = Math.min(entry, mid)
  if (tp != null && (!Number.isFinite(tp) || tp <= 0 || (order.isBuy ? tp <= upper : tp >= lower))) throw new Error('止盈价必须位于入场价与当前价的盈利方向之外')
  if (sl != null && (!Number.isFinite(sl) || sl <= 0 || (order.isBuy ? sl >= lower : sl <= upper))) throw new Error('止损价必须位于入场价与当前价的止损方向之外')
}

function protectionOrders(order, asset, szDecimals, size) {
  const children = []
  for (const [kind, trigger] of [['tp', order.takeProfitPx], ['sl', order.stopLossPx]]) {
    if (trigger == null) continue
    const triggerPx = wirePx(trigger, szDecimals)
    if (Number(triggerPx) <= 0) throw new Error(`${kind} 触发价精度无效`)
    children.push({
      a: asset, b: !order.isBuy, p: triggerPx, s: size, r: true,
      t: { trigger: { isMarket: true, triggerPx, tpsl: kind } },
    })
  }
  return children
}

function assertExchangeAccepted(response) {
  if (response?.status !== 'ok') throw new Error(`Hyperliquid 拒绝操作：${JSON.stringify(response).slice(0, 500)}`)
  const statuses = response?.response?.data?.statuses
  const rejected = Array.isArray(statuses) ? statuses.find((s) => s?.error) : null
  if (rejected) throw new Error(`Hyperliquid 拒单：${rejected.error}`)
}

/**
 * float_to_wire equivalent (SDK signing.py): format to 8 decimals, strip
 * trailing zeros, normalize -0 → 0. Prices are additionally capped to 5
 * significant figures with ≤ (6 − szDecimals) decimals for perps.
 */
function wireStr(value) {
  let s = Number(value).toFixed(8)
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '')
  if (s === '-0') s = '0'
  return s
}

function wirePx(pxNum, szDecimals) {
  const capped = Number(sigFigs(pxNum, 5, Math.max(0, 6 - szDecimals)))
  return wireStr(capped)
}

function wireSz(szNum, szDecimals) {
  return wireStr(Number(szNum.toFixed(szDecimals)))
}

function validTradeCapacity(value, coin) {
  return value?.coin === coin && ['availableToTrade', 'maxTradeSzs'].every((field) =>
    Array.isArray(value[field]) && value[field].length === 2 && value[field].every((part) => Number.isFinite(Number(part)) && Number(part) >= 0))
}

function expandHome(p) {
  if (p === '~') return homedir()
  if (p?.startsWith('~/')) return resolve(homedir(), p.slice(2))
  return resolve(p)
}

/** Validate desk wallet settings; missing fields keep the current value. */
export function normalizeWalletSettings(input, current = {}) {
  const signer = input.signer ?? current.signer ?? 'local'
  if (signer !== 'local' && signer !== 'web3') throw new Error('签名方式必须为 local 或 web3')
  const web3Account = String(input.web3Account ?? current.web3Account ?? 'main').trim()
  if (!web3Account || web3Account.length > 80) throw new Error('dsh-web3 账户名无效')
  const tradingAddress = String(input.tradingAddress ?? current.tradingAddress ?? '').trim()
  if (tradingAddress && !/^0x[0-9a-fA-F]{40}$/.test(tradingAddress)) throw new Error('主账户地址必须是 0x 开头的 40 位十六进制地址')
  return { signer, web3Account, tradingAddress }
}

function defaultSpanMs(interval) {
  const spans = { '1m': 6 * 3600e3, '3m': 18 * 3600e3, '5m': 24 * 3600e3, '15m': 3 * 86400e3, '30m': 6 * 86400e3, '1h': 7 * 86400e3, '2h': 14 * 86400e3, '4h': 30 * 86400e3, '8h': 60 * 86400e3, '12h': 90 * 86400e3, '1d': 180 * 86400e3, '3d': 540 * 86400e3, '1w': 1095 * 86400e3, '1M': 5475 * 86400e3 }
  return spans[interval] ?? 7 * 86400e3
}

function argsOf(key) {
  const sep = key.indexOf(':')
  const head = sep < 0 ? key : key.slice(0, sep)
  const rest = sep < 0 ? '' : key.slice(sep + 1)
  if (head === 'allMids') return { type: 'allMids' }
  if (head === 'allDexsAssetCtxs') return { type: 'allDexsAssetCtxs' }
  if (head === 'allDexsClearinghouseState') return { type: 'allDexsClearinghouseState', user: rest }
  if (head === 'l2Book') return { type: 'l2Book', coin: rest }
  if (head === 'l2BookGrouped') {
    const parts = rest.match(/^(.+):([2345]):([025])$/)
    if (!parts) throw new Error(`invalid grouped book key: ${key}`)
    const nSigFigs = Number(parts[2]); const mantissa = Number(parts[3])
    return { type: 'l2Book', coin: decodeURIComponent(parts[1]), nSigFigs, ...(mantissa ? { mantissa } : {}) }
  }
  if (head === 'trades') return { type: 'trades', coin: rest }
  if (head === 'candle') {
    const last = rest.lastIndexOf(':')
    return { type: 'candle', coin: rest.slice(0, last), interval: rest.slice(last + 1) }
  }
  throw new Error(`unknown snapshot key: ${key}`)
}

async function safeMids(remote, coins = []) {
  const core = async () => {
    const cached = remote.client.snapshot(keys.allMids())
    if (cached?.data && Date.now() - cached.at < 5_000) return cached.data.mids ?? cached.data
    const res = await remote.client.allMids()
    return res?.mids ?? res ?? {}
  }
  // HIP-3 positions are priced from their own dex's mids.
  const dexes = [...new Set(coins.filter((coin) => coin.includes(':')).map((coin) => coin.split(':')[0]))]
  const parts = await Promise.allSettled([core(), ...dexes.map((dex) => remote.dexMids(dex))])
  return Object.assign({}, ...parts.map((part) => part.status === 'fulfilled' ? part.value : {}))
}

/** Mark every paper position before computing equity and occupied margin. */
function paperRiskState(paper, mids, strict = false) {
  let uPnl = 0
  let marginUsed = 0
  let marksConfirmed = true
  const positions = Object.entries(paper.positions ?? {}).map(([coin, p]) => {
    const liveMark = Number(mids?.[coin])
    const validMark = Number.isFinite(liveMark) && liveMark > 0
    if (!validMark) {
      if (strict) throw new Error(`${coin} 实时价格未确认，拒绝模拟交易`)
      marksConfirmed = false
    }
    const markPx = validMark ? liveMark : Number(p.entryPx)
    const size = Number(p.size)
    const entryPx = Number(p.entryPx)
    const leverage = Number(p.leverage ?? paper.leverageByCoin?.[coin] ?? 1)
    if (!(Number.isFinite(markPx) && markPx > 0 && Number.isFinite(size) && Number.isFinite(entryPx) && entryPx > 0 &&
      Number.isFinite(leverage) && leverage >= 1)) throw new Error('模拟账户持仓数据无效')
    const positionPnl = (markPx - entryPx) * size
    uPnl += positionPnl
    marginUsed += Math.abs(size) * markPx / leverage
    return { coin, size, entryPx, markPx, uPnl: positionPnl, leverage }
  })
  const equity = Number(paper.usd) + uPnl
  if (!Number.isFinite(equity)) throw new Error('模拟账户权益无效')
  return { equity, uPnl, marginUsed, marksConfirmed, positions }
}

// Remote markers: every method the web client may call.
for (const m of [
  'indicatorTemplates', 'updatePaperCosts', 'status', 'setCustody', 'walletAccounts', 'updateWalletSettings', 'switchNetwork', 'switchTradingMode', 'updateRiskSettings', 'resetRiskSettings', 'markets', 'marketCatalog', 'marketDetail', 'chartMarks', 'drawChartMark', 'updateChartMark', 'eraseChartMark', 'sessionWorkspace', 'updateSessionWorkspace', 'snapshot', 'candles', 'fundingHistory', 'account', 'fills', 'tradeHistory', 'portfolio',
  'sessions', 'registerSession', 'removeSession', 'bindCoin', 'deskState',
  'eventsSince',
]) {
  markRemoteMethod(HyperRemote.prototype, m)
}
