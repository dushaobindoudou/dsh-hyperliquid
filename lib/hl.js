// lib/hl.js — Hyperliquid market-data layer, SDK-backed.
//
// Data plane (info + WS) runs on the community-standard TypeScript SDK
// `@nktkas/hyperliquid` (MIT): HttpTransport for /info requests and
// WebSocketTransport + SubscriptionClient for live channels. The SDK brings
// schema-validated requests, automatic reconnection and automatic
// re-subscription after reconnect — the three things the previous hand-rolled
// wire layer lacked.
//
// The execution plane (/exchange) stays on our own EIP-712 signing
// implementation (lib/signing.js), which is byte-for-byte validated against
// the official hyperliquid-python-sdk (see test/signing.test.mjs).
//
// Public surface (consumed by lib/remote.js): HyperliquidClient, keys, sigFigs.
// Snapshot keys and payload shapes are unchanged, so the remote layer and the
// web desk are source-compatible.

import { canonicalAction, signL1Action } from './signing.js'

const MAINNET = 'https://api.hyperliquid.xyz'
const TESTNET = 'https://api.hyperliquid-testnet.xyz'
const WS_MAINNET = 'wss://api.hyperliquid.xyz/ws'
const WS_TESTNET = 'wss://api.hyperliquid-testnet.xyz/ws'

function quietUnsubscribe(channel) {
  try { Promise.resolve(channel?.unsubscribe()).catch(() => {}) }
  catch { /* transport already closing */ }
}

/** Round to `maxDecimals` with at most `n` significant figures. */
export function sigFigs(value, n, maxDecimals) {
  const num = Number(value)
  if (!Number.isFinite(num) || num === 0) return '0'
  const abs = Math.abs(num)
  const digits = Math.floor(Math.log10(abs)) + 1
  const decimals = Math.max(0, Math.min(maxDecimals, n - digits))
  return num.toFixed(decimals)
}

async function postJson(url, body, timeoutMs = 10_000) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    })
    const data = await res.json().catch(() => null)
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)?.slice(0, 300)}`)
    return data
  } finally {
    clearTimeout(timer)
  }
}

/**
 * One Hyperliquid endpoint pair (REST + WS) with snapshot caches.
 * The trading desk instantiates exactly one; clients poll snapshots from it.
 *
 * Live channels are ref-counted: remote.js calls subscribe(key)/unsubscribe(key)
 * as coins gain/lose focus; every callback just refreshes the snapshot map.
 */
export class HyperliquidClient {
  /**
   * @param {{network?: 'mainnet'|'testnet', privateKey?: string}} opts
   */
  constructor(opts = {}) {
    this.network = opts.network === 'mainnet' ? 'mainnet' : 'testnet'
    this.restBase = this.network === 'mainnet' ? MAINNET : TESTNET
    this.wsBase = this.network === 'mainnet' ? WS_MAINNET : WS_TESTNET
    this.privateKey = opts.privateKey ?? ''
    // A signer must never reuse a nonce, including concurrent order/cancel calls.
    this.lastNonce = 0

    // ── SDK transports (lazy: nothing connects until first use) ──
    this._sdk = null // { HttpTransport, WebSocketTransport, SubscriptionClient, info: {...fns} }
    this._http = null
    this._wsTransport = null
    this._subsClient = null
    this._liveSubs = new Map() // snapshot key -> ISubscription

    this.ws = null // legacy compat field (unused by the SDK path)
    this.wsState = 'closed' // closed | idle | connecting | open
    this.subs = new Map() // key -> {args, listeners:number}
    this.snapshots = new Map() // key -> latest payload
    this.snapshotTimes = new Map() // key -> last exchange message received on host
    this.seqs = new Map() // key -> monotonically increasing revision
    this.throws = 0
    this.lastWsError = null
    this.pingTimer = null // legacy compat (SDK keep-alive handles ping)
    this.retryTimers = new Map() // failed channel key -> retry timer
  }

  // ── SDK bootstrap ────────────────────────────────────────────────────
  _sdkOnce() {
    if (this._sdk) return this._sdk
    // Plain dynamic imports keep the SDK optional at parse time and let the
    // desk degrade to REST-only polling if the package is unavailable.
    const root = '@nktkas/hyperliquid'
    const infoApi = `${root}/api/info`
    const subApi = `${root}/api/subscription`
    // Deliberately not awaited: transports are created eagerly-ish but callers
    // await the individual request methods, which await their modules.
    this._sdk = Promise.all([import(root), import(infoApi), import(subApi)]).then(([r, i, s]) => {
      this._http = new r.HttpTransport({ isTestnet: this.network !== 'mainnet' })
      const cfg = { transport: this._http }
      this._sdkInfo = {
        meta: () => i.meta(cfg),
        metaAndAssetCtxs: () => i.metaAndAssetCtxs(cfg),
        allMids: () => i.allMids(cfg),
        l2Book: (coin, grouping = null) => i.l2Book(cfg, { coin, ...(grouping ?? {}) }),
        candleSnapshot: (coin, interval, startTime, endTime) => i.candleSnapshot(cfg, { coin, interval, startTime, endTime }),
        clearinghouseState: (user) => i.clearinghouseState(cfg, { user }),
        spotClearinghouseState: (user) => i.spotClearinghouseState(cfg, { user }),
        userAbstraction: (user) => i.userAbstraction(cfg, { user }),
        activeAssetData: (user, coin) => i.activeAssetData(cfg, { user, coin }),
        openOrders: (user) => i.openOrders(cfg, { user }),
        frontendOpenOrders: (user) => i.frontendOpenOrders(cfg, { user }),
        userFills: (user) => i.userFills(cfg, { user }),
        historicalOrders: (user) => i.historicalOrders(cfg, { user }),
        portfolio: (user) => i.portfolio(cfg, { user }),
      }
      this._wsTransport = new r.WebSocketTransport({ url: this.wsBase })
      this._subsClient = new r.SubscriptionClient({ transport: this._wsTransport })
      // Connection bookkeeping: the transport's event target carries the
      // system events; ready() resolves once the socket is up.
      const hlEvents = this._wsTransport._hlEvents
      hlEvents?.addEventListener?.('error', (ev) => {
        this.lastWsError = ev?.detail ?? 'ws error'
        this.wsState = 'connecting'
      })
      hlEvents?.addEventListener?.('subscriptionResponse', () => {
        // Unsubscribe acks arrive here too; with no channels left we are idle.
        if (this.wsState !== 'closed') this.wsState = this.subs.size ? 'open' : 'idle'
      })
      // The SDK socket reconnects and resubscribes on its own; mirror that so
      // a dropped upstream reads as "connecting" rather than a silent "open".
      const socket = this._wsTransport.socket
      socket?.addEventListener?.('close', () => { if (this.wsState !== 'closed') this.wsState = 'connecting' })
      socket?.addEventListener?.('open', () => { if (this.wsState === 'connecting') this.wsState = this.subs.size ? 'open' : 'idle' })
      Promise.resolve(this._wsTransport.ready?.()).then(() => {
        this.wsState = 'open'
      }).catch((err) => {
        this.lastWsError = String(err?.message ?? err)
      })
      return this._sdkInfo
    })
    return this._sdk
  }

  _infoFns() {
    return this._sdkOnce().then((fns) => {
      if (!fns) throw new Error('SDK 初始化失败（@nktkas/hyperliquid 不可用）')
      return fns
    })
  }

  // ── /info ────────────────────────────────────────────────────────────
  /** Generic /info passthrough with a timeout. `type` values per docs. */
  info(type, extra = {}, timeoutMs = 10_000) {
    return postJson(`${this.restBase}/info`, { type, ...extra }, timeoutMs)
  }

  async meta() { return (await this._infoFns()).meta() }
  async metaAndAssetCtxs() { return (await this._infoFns()).metaAndAssetCtxs() }
  async allMids() { return (await this._infoFns()).allMids() }
  async l2Book(coin, grouping = null) { return (await this._infoFns()).l2Book(coin, grouping) }
  recentTrades(coin) { return this.info('recentTrades', { coin }) }
  async candleSnapshot(coin, interval, startTime, endTime) {
    return (await this._infoFns()).candleSnapshot(coin, interval, startTime, endTime)
  }
  async clearinghouseState(user) { return (await this._infoFns()).clearinghouseState(user) }
  async spotClearinghouseState(user) { return (await this._infoFns()).spotClearinghouseState(user) }
  async userAbstraction(user) { return (await this._infoFns()).userAbstraction(user) }
  async activeAssetData(user, coin) { return (await this._infoFns()).activeAssetData(user, coin) }
  async openOrders(user) { return (await this._infoFns()).openOrders(user) }
  async frontendOpenOrders(user) { return (await this._infoFns()).frontendOpenOrders(user) }
  async userFills(user) { return (await this._infoFns()).userFills(user) }
  async historicalOrders(user) { return (await this._infoFns()).historicalOrders(user) }
  async portfolio(user) { return (await this._infoFns()).portfolio(user) }

  // ── /exchange ────────────────────────────────────────────────────────
  /**
   * Send a signed exchange action. Paper mode never reaches here.
   * Execution stays on our validated EIP-712 path (lib/signing.js).
   * @param {object} action L1 action body, e.g. {type:'order', orders:[…], grouping:'na'}
   */
  async exchange(action) {
    if (!this.privateKey) throw new Error('未配置钱包私钥（插件 config.privateKey）；paper 模式下单不经过 /exchange')
    const nonce = this.nextNonce()
    const canonical = canonicalAction(action)
    const signature = await signL1Action(this.privateKey, canonical, null, nonce, this.network === 'mainnet')
    return postJson(`${this.restBase}/exchange`, { action: canonical, nonce, signature }, 15_000)
  }

  nextNonce() {
    this.lastNonce = Math.max(Date.now(), this.lastNonce + 1)
    return this.lastNonce
  }

  /**
   * Send an exchange action with an EXTERNALLY produced signature — the
   * dsh-web3 path: the private key never leaves the wallet vault, this
   * client only transports the already-signed envelope.
   * @param {object} action L1 action body
   * @param {{r: string, s: string, v: number}} signature wire-form signature
   * @param {number} nonce the nonce that was hashed into the signature
   */
  exchangeSigned(action, signature, nonce) {
    if (!signature?.r || !signature?.s || !signature?.v) throw new Error('exchangeSigned 需要完整的 {r,s,v} 签名')
    return postJson(`${this.restBase}/exchange`, { action: canonicalAction(action), nonce, signature }, 15_000)
  }

  /** Post a user-signed action (sendAsset …) as built; these are not L1 actions and skip canonicalAction. */
  exchangeUserSigned(action, signature, nonce) {
    if (!signature?.r || !signature?.s || !signature?.v) throw new Error('exchangeUserSigned 需要完整的 {r,s,v} 签名')
    return postJson(`${this.restBase}/exchange`, { action, nonce, signature }, 15_000)
  }

  // ── WebSocket upstream (SDK SubscriptionClient) ──────────────────────
  /** Map a snapshot key to a SubscriptionClient channel; resolve its ISubscription. */
  async _openChannel(key, args) {
    await this._infoFns()
    this.wsState = 'connecting'
    const sc = this._subsClient
    const feed = (payload) => {
      this.snapshots.set(key, payload)
      this.snapshotTimes.set(key, Date.now())
      this.seqs.set(key, (this.seqs.get(key) ?? 0) + 1)
      this.wsState = 'open'
    }
    switch (args?.type) {
      case 'allMids':
        return sc.allMids((ev) => feed(ev?.detail ?? ev))
      case 'allDexsAssetCtxs':
        return sc.allDexsAssetCtxs((ev) => feed(ev?.detail ?? ev))
      case 'allDexsClearinghouseState':
        return sc.allDexsClearinghouseState({ user: args.user }, (ev) => feed(ev?.detail ?? ev))
      case 'l2Book':
        return sc.l2Book({ coin: args.coin, ...(args.nSigFigs ? { nSigFigs: args.nSigFigs, ...(args.mantissa ? { mantissa: args.mantissa } : {}) } : {}) }, (ev) => feed(ev?.detail ?? ev))
      case 'trades':
        return sc.trades({ coin: args.coin }, (ev) => feed(ev?.detail ?? ev))
      case 'candle':
        return sc.candle({ coin: args.coin, interval: args.interval }, (ev) => feed(ev?.detail ?? ev))
      case 'userFills':
        return sc.userFills({ user: args.user }, (ev) => feed(ev?.detail ?? ev))
      case 'userEvents':
        return sc.userEvents({ user: args.user }, (ev) => feed(ev?.detail ?? ev))
      default:
        throw new Error(`unknown subscription type: ${args?.type}`)
    }
  }

  /**
   * Register interest in a WS channel; ref-counted. Returns the snapshot key.
   * Supported: allMids | allDexsAssetCtxs | {allDexsClearinghouseState, user} | {l2Book, coin} | {trades, coin} | {candle, coin, interval}
   *            | {userFills, user} | {userEvents, user}
   */
  subscribe(key, args) {
    const row = this.subs.get(key) ?? { args, listeners: 0, channel: null, opening: false }
    row.listeners += 1
    this.subs.set(key, row)
    if (!row.channel && !row.opening) {
      row.opening = true
      this._openChannel(key, args)
        .then((sub) => {
          row.channel = sub
          row.opening = false
          this.wsState = 'open'
          if (row.listeners <= 0) {
            // Interest went away while the channel was opening.
            quietUnsubscribe(sub)
            row.channel = null
            this.subs.delete(key)
            this.snapshots.delete(key)
            this.snapshotTimes.delete(key)
          }
        })
        .catch((err) => {
          row.opening = false
          this.lastWsError = String(err?.message ?? err)
          if (row.listeners > 0) this._retryChannel(key)
        })
    }
    return key
  }

  _retryChannel(key) {
    if (this.retryTimers.has(key)) return
    const timer = setTimeout(() => {
      this.retryTimers.delete(key)
      const row = this.subs.get(key)
      if (row && row.listeners > 0 && !row.channel && !row.opening) {
        row.opening = true
        this._openChannel(key, row.args)
          .then((sub) => {
            row.opening = false
            if (row.listeners <= 0) { quietUnsubscribe(sub); this.subs.delete(key); return }
            row.channel = sub
            this.wsState = 'open'
          })
          .catch((err) => {
            row.opening = false
            this.lastWsError = String(err?.message ?? err)
            if (row.listeners > 0) this._retryChannel(key)
          })
      }
    }, 3_000)
    this.retryTimers.set(key, timer)
  }

  unsubscribe(key) {
    const row = this.subs.get(key)
    if (!row) return
    row.listeners -= 1
    if (row.listeners <= 0) {
      if (row.channel) {
        quietUnsubscribe(row.channel)
        row.channel = null
      }
      this.subs.delete(key)
      this.snapshots.delete(key)
      this.snapshotTimes.delete(key)
      const timer = this.retryTimers.get(key)
      if (timer) clearTimeout(timer)
      this.retryTimers.delete(key)
      // The upstream socket stays connected (SDK keep-alive); only channels went away.
      if (this.subs.size === 0 && this.wsState !== 'closed') this.wsState = 'idle'
    }
  }

  snapshot(key) {
    const snap = this.snapshots.get(key)
    const seq = this.seqs.get(key) ?? 0
    return snap === undefined ? null : { seq, at: this.snapshotTimes.get(key) ?? 0, data: snap }
  }

  wsStatus() {
    const lastDataAt = Math.max(0, ...this.snapshotTimes.values())
    const state = this.wsState === 'open' && lastDataAt > 0 && Date.now() - lastDataAt > 15_000
      ? 'stale' : this.wsState
    return { state, lastDataAt, subs: [...this.subs.keys()], lastError: this.lastWsError }
  }

  close() {
    for (const timer of this.retryTimers.values()) clearTimeout(timer)
    this.retryTimers.clear()
    for (const [key, row] of this.subs) {
      if (row.channel) {
        quietUnsubscribe(row.channel)
        row.channel = null
      }
      row.listeners = 0
    }
    this.subs.clear()
    this.snapshots.clear()
    this.snapshotTimes.clear()
    try { this._wsTransport?.close?.() } catch { /* already closed */ }
    this.wsState = 'closed'
    this.ws = null
  }
}

/** Canonical snapshot key builders shared with the remote layer. */
export const keys = {
  allMids: () => 'allMids',
  allDexsAssetCtxs: () => 'allDexsAssetCtxs',
  allDexsClearinghouseState: (user) => `allDexsClearinghouseState:${user.toLowerCase()}`,
  l2Book: (coin, grouping = null) => grouping
    ? `l2BookGrouped:${encodeURIComponent(coin)}:${grouping.nSigFigs}:${grouping.mantissa ?? 0}`
    : `l2Book:${coin}`,
  trades: (coin) => `trades:${coin}`,
  candle: (coin, interval) => `candle:${coin}:${interval}`,
  userEvents: () => 'userEvents',
  userFills: (user) => `userFills:${user}`,
}
