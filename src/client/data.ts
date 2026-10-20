/**
 * dsh-hyperliquid — client data layer: every host interaction lives here.
 *
 * Polling discipline (from the desk's IP-rate-limit lesson): the browser
 * polls the HOST, never the exchange. Snapshot/account cadence is 0.9s/3s;
 * `eventsSince` drains the host event ring (fills, agent-driven desk focus).
 * @module src/client/data
 */

import { hyperCall, t, tr } from './remote'
import { getActiveRef, notify, store } from './store'
import type { Candle, ChartMark, DeskState, Interval, SessionWorkspace } from './types'
import { chartReferenceLabel, formatChartReference, type ChartReferenceRef, type ChartSelection } from './chart-reference'

const POLL_FAST_MS = 900
const POLL_SLOW_MS = 3000
const MARKETS_MS = 15000
const SESSIONS_MS = 10000
const DETAIL_MS = 5000

export function isMarketStale(s: DeskState, now = Date.now()): boolean {
  const observed = s.snapshot?.observedAt
  const kind = s.selectedMarket?.name === s.activeCoin ? s.selectedMarket.kind
    : s.marketCatalog.find((row) => row.name === s.activeCoin)?.kind
      ?? (s.activeCoin.startsWith('#') ? 'outcome' : s.activeCoin.includes(':') ? 'hip3' : s.activeCoin.startsWith('@') || s.activeCoin.includes('/') ? 'spot' : 'perp')
  return Boolean(s.statusError || s.snapshotError || (s.snapshot?.network && s.status?.network && s.snapshot.network !== s.status.network) || !s.statusAt || now - s.statusAt > 20_000 ||
    !s.snapshotAt || now - s.snapshotAt > 5_000 ||
    !observed?.book || now - observed.book > 10_000 ||
    (kind === 'perp' && (!observed?.mids || now - observed.mids > 10_000)) ||
    (kind !== 'perp' && (!s.selectedMarketAt || now - s.selectedMarketAt > 25_000 || Boolean(s.selectedMarketError))))
}
let focusVersion = 0
let focusQueue: Promise<void> = Promise.resolve()
const focusClientId = Math.random().toString(36).slice(2) + Date.now().toString(36)
const pendingSnapshots = new Set<string>()
const pendingDetails = new Set<string>()
let accountPending = false
let historyPending: Promise<void> | null = null
let historyPendingEpoch = -1
let accountPendingEpoch = -1
let eventsPending = false
let catalogPending: Promise<void> | null = null
let catalogPendingEpoch = -1
let networkEpoch = 0
const workspaceWrites = new Map<string, Promise<unknown>>()
const ANONYMOUS_WORKSPACE: SessionWorkspace = {
  coin: 'BTC', interval: '15m', bookGrouping: 'full', chartTab: 'chart', tapeTab: 'book', bottomTab: 'positions', indicators: ['volume'], maLines: [],
  priceScale: 'normal', chartRanges: {},
  chartLayers: { orders: true, fills: true, drawings: true },
  layout: { sessionsWidth: 232, chatWidth: 480, sessionsCollapsed: false, deskCollapsed: false, chatCollapsed: false },
}
let workspaceLoadVersion = 0
let chartMarksLoadVersion = 0

/** Restore preferences before binding market focus; stale replies cannot cross sessions. */
export async function openSession(sessionId: string, fallbackCoin = 'BTC'): Promise<void> {
  const loadVersion = ++workspaceLoadVersion
  focusVersion += 1
  store.patch({ activeSessionId: sessionId, workspaceSessionId: null, workspace: null,
    activeCoin: fallbackCoin, interval: '15m', bookGrouping: 'full', chartMarks: [], chartMarksKey: '', candles: [],
    snapshot: null, snapshotAt: 0, selectedMarket: null, selectedMarketAt: 0, fundingRows: [], fundingCoin: null,
    ticketDraft: null })
  try {
    await workspaceWrites.get(sessionId)?.catch(() => {})
    if (store.get().activeSessionId !== sessionId || loadVersion !== workspaceLoadVersion) return
    const workspace = await hyperCall('sessionWorkspace', { sessionId }) as SessionWorkspace
    if (store.get().activeSessionId !== sessionId || loadVersion !== workspaceLoadVersion) return
    store.patch({ workspace, workspaceSessionId: sessionId, interval: workspace.interval, bookGrouping: workspace.bookGrouping })
    await setDeskCoin(workspace.coin ?? fallbackCoin)
    void loadCandles()
    void loadChartMarks()
  } catch (error) {
    if (store.get().activeSessionId === sessionId) notify(tr('会话工作台加载失败', 'Could not load session workspace') + '：' + String((error as Error)?.message ?? error))
  }
}

export function saveSessionWorkspace(patch: Partial<SessionWorkspace>): void {
  const state = store.get()
  const sessionId = state.activeSessionId
  if (sessionId && (state.workspaceSessionId !== sessionId || !state.workspace)) return
  const current = state.workspace ?? ANONYMOUS_WORKSPACE
  const next: SessionWorkspace = { ...current, ...patch,
    layout: patch.layout ? { ...current.layout, ...patch.layout } : current.layout,
    chartLayers: patch.chartLayers ? { ...(current.chartLayers ?? { orders: true, fills: true, drawings: true }), ...patch.chartLayers } : current.chartLayers,
    chartRanges: patch.chartRanges ? { ...current.chartRanges, ...patch.chartRanges } : current.chartRanges }
  store.patch({ workspace: next,
    ...(patch.interval ? { interval: patch.interval } : {}),
    ...(patch.bookGrouping ? { bookGrouping: patch.bookGrouping } : {}) })
  if (!sessionId) return
  const previous = workspaceWrites.get(sessionId) ?? Promise.resolve()
  const task = previous.catch(() => {}).then(() => hyperCall('updateSessionWorkspace', { sessionId, patch }))
  workspaceWrites.set(sessionId, task)
  void task.catch((error) => notify(tr('会话工作台保存失败', 'Could not save session workspace') + '：' + String((error as Error)?.message ?? error)))
}

function resetNetworkView(network: 'mainnet' | 'testnet'): void {
  networkEpoch += 1
  const previous = store.get()
  store.patch({
    status: previous.status ? { ...previous.status, network } : null,
    statusAt: 0, statusError: null,
    markets: [], marketsAt: 0, marketCatalog: [], marketCatalogAt: 0,
    selectedMarket: null, selectedMarketAt: 0, selectedMarketError: null,
    snapshot: null, snapshotAt: 0, snapshotError: null,
    candles: [], candlesState: 'idle', fundingRows: [], fundingCoin: null,
    account: null, accountAt: 0, accountError: null,
    tradeHistory: null, tradeHistoryAt: 0, tradeHistoryError: null,
  })
  void Promise.allSettled([loadStatus(), loadMarkets(true), loadSnapshot(), loadCandles(), loadMarketDetail(previous.activeCoin), loadAccount()])
}

export async function switchNetwork(network: 'mainnet' | 'testnet'): Promise<void> {
  const result = await hyperCall('switchNetwork', { network, acknowledgeMainnet: network === 'mainnet' })
  if (result?.network !== network) throw new Error(tr('网络切换结果不一致', 'Network switch response mismatch'))
  resetNetworkView(network)
}

/** Real and paper accounts never share a view: drop the old account before reloading. */
function resetModeView(mode: 'live' | 'paper'): void {
  networkEpoch += 1
  const previous = store.get()
  store.patch({
    status: previous.status ? { ...previous.status, tradingMode: mode } : null,
    account: null, accountAt: 0, accountError: null,
    tradeHistory: null, tradeHistoryAt: 0, tradeHistoryError: null,
  })
  void Promise.allSettled([loadStatus(), loadAccount(), loadTradeHistory(true)])
}

/** A different wallet: drop every account-derived view and discard replies that are still in flight. */
export function resetWalletView(): void {
  networkEpoch += 1
  store.patch({ account: null, accountAt: 0, accountError: null, tradeHistory: null, tradeHistoryAt: 0, tradeHistoryError: null })
  void Promise.allSettled([loadStatus(), loadAccount(), loadTradeHistory(true)])
}

export async function switchTradingMode(mode: 'live' | 'paper'): Promise<void> {
  const result = await hyperCall('switchTradingMode', { mode, acknowledgeLive: mode === 'live' })
  if (result?.mode !== mode) throw new Error(tr('交易模式切换结果不一致', 'Trading mode switch response mismatch'))
  resetModeView(mode)
}

function applyLocalCoin(coin: string): void {
  if (coin === store.get().activeCoin) return
  store.patch({ activeCoin: coin, snapshot: null, snapshotAt: 0, snapshotError: null, selectedMarket: null, selectedMarketAt: 0, selectedMarketError: null, candles: [], chartMarks: [], chartMarksKey: '', fundingRows: [], fundingCoin: null })
  void loadCandles()
  void loadSnapshot()
  void loadMarketDetail(coin)
  // Marks were cleared above; reload them here rather than rely on a render seeing the coin change
  // (a quick A→B→A flip inside one batch would leave the chart without its drawings).
  void loadChartMarks()
}

function liveCandle(value: any): Candle | null {
  if (!value || typeof value !== 'object') return null
  const row = { t: Number(value.t), o: Number(value.o), h: Number(value.h), l: Number(value.l), c: Number(value.c), v: Number(value.v) }
  return Object.values(row).every(Number.isFinite) && row.t > 0 ? row : null
}

/** Hyperliquid only serves the most recent 5000 candles per coin and interval. */
const MAX_CANDLES = 5000
const OLDER_PAGE_BARS = 500
const INTERVAL_MS: Record<Interval, number> = {
  '1m': 60e3, '3m': 180e3, '5m': 300e3, '15m': 900e3, '30m': 1800e3, '1h': 3600e3, '2h': 7200e3, '4h': 14400e3,
  '8h': 28800e3, '12h': 43200e3, '1d': 86400e3, '3d': 259200e3, '1w': 604800e3, '1M': 2592000e3,
}
/** coin:interval the stored candles belong to, so a reload can keep paged-in history. */
let candlesFor = ''
let olderPending = false

function mergeCandle(rows: Candle[], next: Candle): Candle[] {
  const last = rows.at(-1)
  if (!last || next.t > last.t) return [...rows, next].slice(-MAX_CANDLES)
  if (next.t === last.t && JSON.stringify(next) !== JSON.stringify(last)) return [...rows.slice(0, -1), next]
  return rows
}

/** The trader picks 全托管 / 半托管 on the desk; the agent can only read it. */
export async function setCustody(mode: 'managed' | 'assisted', acknowledge = false): Promise<void> {
  await hyperCall('setCustody', { mode, acknowledge })
  await loadStatus()
}

export async function loadStatus(): Promise<void> {
  const epoch = networkEpoch
  try {
    const status = await hyperCall('status')
    if (epoch === networkEpoch) store.patch({ status, statusError: null, statusAt: Date.now() })
  } catch (e) {
    if (epoch === networkEpoch) store.patch({ statusError: String((e as Error)?.message ?? e) })
  }
}

export async function loadMarkets(force = false): Promise<void> {
  if (!force && Date.now() - store.get().marketsAt < MARKETS_MS) return
  try {
    const epoch = networkEpoch
    const m = await hyperCall('markets')
    if (epoch === networkEpoch) store.patch({ markets: m.universe ?? [], marketsAt: Date.now() })
  } catch { /* transient */ }
}

/** The broad catalog is loaded on demand when the selector opens. */
export async function loadMarketCatalog(force = false): Promise<void> {
  if (!force && Date.now() - store.get().marketCatalogAt < 60_000) return
  if (catalogPending && catalogPendingEpoch === networkEpoch) return catalogPending
  const epoch = networkEpoch
  catalogPendingEpoch = epoch
  catalogPending = hyperCall('marketCatalog').then((res) => {
    if (epoch === networkEpoch) store.patch({ marketCatalog: res.markets ?? [], marketCatalogAt: Date.now() })
  }).finally(() => { if (catalogPendingEpoch === epoch) catalogPending = null })
  return catalogPending
}

export async function loadMarketDetail(coin: string): Promise<void> {
  const epoch = networkEpoch
  const pendingKey = `${epoch}:${coin}`
  if (pendingDetails.has(pendingKey)) return
  pendingDetails.add(pendingKey)
  try {
    const res = await hyperCall('marketDetail', { coin })
    if (epoch !== networkEpoch || store.get().activeCoin !== coin || !res?.market) return
    store.patch((prev) => {
      const index = prev.marketCatalog.findIndex((row) => row.name === coin)
      const marketCatalog = [...prev.marketCatalog]
      if (index < 0) marketCatalog.push(res.market)
      else marketCatalog[index] = res.market
      return { marketCatalog, selectedMarket: res.market, selectedMarketAt: Number(res.observedAt) || 0, selectedMarketError: null }
    })
  } catch (e) {
    if (epoch === networkEpoch && store.get().activeCoin === coin) store.patch({ selectedMarketError: String((e as Error)?.message ?? e) })
  } finally {
    pendingDetails.delete(pendingKey)
  }
}

export async function loadSnapshot(): Promise<void> {
  const { activeCoin: coin, interval, bookGrouping } = store.get()
  const epoch = networkEpoch
  const key = `${epoch}:${coin}:${interval}:${bookGrouping}`
  if (pendingSnapshots.has(key)) return
  pendingSnapshots.add(key)
  try {
    const snapshot = await hyperCall('snapshot', { coin, interval, bookGrouping })
    if (epoch !== networkEpoch || store.get().activeCoin !== coin || store.get().interval !== interval || store.get().bookGrouping !== bookGrouping) return
    const candle = liveCandle(snapshot?.candle)
    store.patch((prev) => ({
      snapshot,
      snapshotAt: Date.now(),
      snapshotError: null,
      ...(candle && prev.candlesState === 'ready' ? { candles: mergeCandle(prev.candles, candle) } : {}),
    }))
  } catch (e) {
    if (epoch === networkEpoch && store.get().activeCoin === coin && store.get().interval === interval && store.get().bookGrouping === bookGrouping) store.patch({ snapshotError: String((e as Error)?.message ?? e) })
  } finally {
    pendingSnapshots.delete(key)
  }
}

/** Page in history before the first loaded candle when the chart is scrolled to its left edge. */
export async function loadOlderCandles(): Promise<void> {
  const { activeCoin: coin, interval, candles, candlesState, candlesOlder } = store.get()
  const first = candles[0]
  if (olderPending || !first || candlesState !== 'ready' || candlesOlder === 'done' || candles.length >= MAX_CANDLES) return
  const key = `${coin}:${interval}`
  if (candlesFor !== key) return
  olderPending = true
  const epoch = networkEpoch
  store.patch({ candlesOlder: 'loading' })
  try {
    const endMs = first.t - 1
    const res = await hyperCall('candles', { coin, interval, startMs: endMs - INTERVAL_MS[interval] * OLDER_PAGE_BARS, endMs })
    if (epoch !== networkEpoch || candlesFor !== key) return
    const current = store.get().candles
    const head = current[0]?.t ?? Infinity
    const older = ((res.candles ?? []) as Candle[]).filter((row) => row.t < head)
    const room = Math.max(0, MAX_CANDLES - current.length)
    const next = older.slice(-room)
    store.patch({ candles: [...next, ...current], candlesOlder: next.length === 0 || next.length === room ? 'done' : 'idle' })
  } catch {
    if (epoch === networkEpoch && candlesFor === key) store.patch({ candlesOlder: 'error' })
  } finally {
    olderPending = false
  }
}

export async function loadCandles(): Promise<void> {
  const { activeCoin: coin, interval } = store.get()
  const epoch = networkEpoch
  store.patch({ candlesState: 'loading' })
  try {
    const res = await hyperCall('candles', { coin, interval })
    if (epoch === networkEpoch && store.get().activeCoin === coin && store.get().interval === interval) {
      const fetched = (res.candles ?? []) as Candle[]
      const key = `${coin}:${interval}`
      const prev = store.get().candles
      const same = candlesFor === key
      // A refresh (e.g. after the tab was hidden) keeps history the trader already paged in.
      const older = same && fetched.length ? prev.filter((row) => row.t < fetched[0].t) : []
      const rows = [...older, ...fetched]
      const lastLive = same ? prev.at(-1) : undefined
      candlesFor = key
      store.patch({ candles: lastLive && lastLive.t >= (rows.at(-1)?.t ?? 0) ? mergeCandle(rows.filter((row) => row.t < lastLive.t), lastLive) : rows, candlesState: 'ready',
        ...(same ? {} : { candlesOlder: 'idle' as const }) })
    }
  } catch {
    if (epoch === networkEpoch && store.get().activeCoin === coin && store.get().interval === interval) store.patch({ candlesState: 'error' })
  }
}

export async function loadChartMarks(): Promise<void> {
  const { activeSessionId: sessionId, activeCoin: coin } = store.get()
  const key = `${sessionId ?? ''}:${coin}`
  const version = ++chartMarksLoadVersion
  if (!sessionId) { store.patch({ chartMarks: [], chartMarksKey: key }); return }
  try {
    const res = await hyperCall('chartMarks', { sessionId, coin, allIntervals: true })
    const current = store.get()
    if (version === chartMarksLoadVersion && `${current.activeSessionId ?? ''}:${current.activeCoin}` === key) {
      store.patch({ chartMarks: (res.marks ?? []) as ChartMark[], chartMarksKey: key })
    }
  } catch { /* preserve existing marks during transient host errors */ }
}

export async function loadFunding(): Promise<void> {
  const coin = store.get().activeCoin
  const epoch = networkEpoch
  store.patch({ fundingState: 'loading' })
  try {
    const res = await hyperCall('fundingHistory', { coin })
    if (epoch === networkEpoch && store.get().activeCoin === coin) {
      store.patch({ fundingRows: res.rows ?? [], fundingCoin: coin, fundingState: 'ready' })
    }
  } catch {
    if (epoch === networkEpoch && store.get().activeCoin === coin) store.patch({ fundingState: 'error' })
  }
}

export async function loadAccount(): Promise<void> {
  if (accountPending && accountPendingEpoch === networkEpoch) return
  accountPending = true
  const coin = store.get().activeCoin
  const epoch = networkEpoch
  accountPendingEpoch = epoch
  try {
    const account = await hyperCall('account', { coin })
    if (epoch === networkEpoch && store.get().activeCoin === coin) store.patch({ account, accountError: null, accountAt: Date.now() })
  } catch (e) {
    if (epoch === networkEpoch) store.patch({ accountError: String((e as Error)?.message ?? e) })
  } finally {
    if (accountPendingEpoch === epoch) accountPending = false
  }
}

/** History is an expensive exchange query; refresh only on demand or every 30s. */
export function loadTradeHistory(force = false): Promise<void> {
  if (historyPending && historyPendingEpoch === networkEpoch) return historyPending
  if (!force && Date.now() - store.get().tradeHistoryAt < 30_000) return Promise.resolve()
  const epoch = networkEpoch
  historyPendingEpoch = epoch
  const task = hyperCall('tradeHistory').then((result) => {
    if (epoch === networkEpoch) store.patch({ tradeHistory: result, tradeHistoryAt: Date.now(), tradeHistoryError: null })
  }).catch((error) => {
    if (epoch === networkEpoch) store.patch({ tradeHistoryError: String((error as Error)?.message ?? error) })
  }).finally(() => { if (historyPending === task) historyPending = null })
  historyPending = task
  return task
}

export async function loadSessions(): Promise<void> {
  try {
    const res = await hyperCall('sessions')
    store.patch({ sessions: res.sessions ?? [], sessionsLoaded: true })
  } catch { /* transient */ }
}

/** The agent changed this session's MA lines: take the host's copy without touching other workspace edits. */
let maReloadVersion = 0
async function reloadMaLines(sessionId: string): Promise<void> {
  const version = ++maReloadVersion
  try {
    const workspace = await hyperCall('sessionWorkspace', { sessionId }) as SessionWorkspace
    const state = store.get()
    if (version !== maReloadVersion) return
    if (state.workspaceSessionId === sessionId && state.workspace) store.patch({ workspace: { ...state.workspace, maLines: workspace.maLines ?? [] } })
  } catch { /* next event or session reload retries */ }
}

/** The agent switched this session's interval or indicator panes. */
let viewReloadVersion = 0
async function reloadChartView(sessionId: string): Promise<void> {
  // Two quick view changes can answer out of order; only the newest read may apply.
  const version = ++viewReloadVersion
  try {
    const workspace = await hyperCall('sessionWorkspace', { sessionId }) as SessionWorkspace
    const state = store.get()
    if (version !== viewReloadVersion || state.workspaceSessionId !== sessionId || !state.workspace) return
    const intervalChanged = workspace.interval !== state.interval
    store.patch({ workspace: { ...state.workspace, interval: workspace.interval, indicators: workspace.indicators }, interval: workspace.interval })
    if (intervalChanged) void loadCandles()
  } catch { /* next event or session reload retries */ }
}

/** Drain the host event ring: fills refresh the account, desk.state moves the focus. */
export async function pollEvents(): Promise<void> {
  if (eventsPending) return
  eventsPending = true
  try {
    const res = await hyperCall('eventsSince', { seq: store.get().eventsSeq })
    if (Array.isArray(res.events) && res.events.length > 0) {
      for (const ev of res.events) {
        if (ev.kind === 'network.changed' && (ev.data?.to === 'mainnet' || ev.data?.to === 'testnet') && ev.data.to !== store.get().status?.network) resetNetworkView(ev.data.to)
        if (ev.kind === 'mode.changed' && (ev.data?.to === 'live' || ev.data?.to === 'paper') && ev.data.to !== store.get().status?.tradingMode) resetModeView(ev.data.to)
        if (ev.kind === 'risk.changed') void loadStatus()
        if (ev.kind === 'wallet.changed') resetWalletView()
        if (ev.kind === 'custody.changed') void loadStatus()
        if (ev.kind === 'paper.fill' || ev.kind?.startsWith('live.order.')) { void loadAccount(); void loadTradeHistory(true) }
        if (ev.kind === 'chart.mark' && (ev.data?.sessionId === store.get().activeSessionId || (ev.data?.shared && ev.data?.coin === store.get().activeCoin))) void loadChartMarks()
        if (ev.kind === 'chart.alert' && (ev.data?.sessionId === store.get().activeSessionId || ev.data?.shared)) {
          notify(tr(`${ev.data.coin} 价格${ev.data.direction === 'up' ? '上穿' : '下穿'}「${ev.data.label}」：${ev.data.price}`, `${ev.data.coin} crossed ${ev.data.direction === 'up' ? 'above' : 'below'} "${ev.data.label}": ${ev.data.price}`))
          if (ev.data.coin === store.get().activeCoin) void loadChartMarks()
        }
        if (ev.kind === 'chart.ma' && ev.data?.sessionId === store.get().activeSessionId) void reloadMaLines(ev.data.sessionId)
        if (ev.kind === 'chart.view' && ev.data?.sessionId === store.get().activeSessionId) void reloadChartView(ev.data.sessionId)
        if (ev.data?.clientId === focusClientId) continue
        if (ev.kind === 'desk.state' && ev.data?.coin && (!ev.data.sessionId || ev.data.sessionId === store.get().activeSessionId) && ev.data.coin !== store.get().activeCoin) {
          focusVersion += 1
          applyLocalCoin(ev.data.coin)
        }
        if (ev.kind === 'session.coin' && ev.data?.sessionId === store.get().activeSessionId && ev.data?.coin && ev.data.coin !== store.get().activeCoin) {
          focusVersion += 1
          applyLocalCoin(ev.data.coin)
        }
      }
    }
    if (Number.isFinite(res.seq)) store.patch({ eventsSeq: res.seq })
  } catch { /* transient */ }
  finally { eventsPending = false }
}

/** Start the panel's polling loops; returns the cleanup. */
export function startPolling(): () => void {
  void loadStatus()
  void loadMarkets(true)
  void loadSessions()
  void loadCandles()
  void loadSnapshot()
  void loadMarketDetail(store.get().activeCoin)
  store.patch({ resumedAt: Date.now() })
  const visible = () => !document.hidden
  let hiddenAt = document.hidden ? Date.now() : 0
  const fast = setInterval(() => { if (visible()) { void loadSnapshot(); void pollEvents() } }, POLL_FAST_MS)
  const slow = setInterval(() => { if (visible()) { void loadAccount(); void loadMarkets() } }, POLL_SLOW_MS)
  const titles = setInterval(() => { if (visible()) { void loadSessions(); void loadStatus() } }, SESSIONS_MS)
  const detail = setInterval(() => { if (visible()) void loadMarketDetail(store.get().activeCoin) }, DETAIL_MS)
  // Hidden pages stop polling, so the host releases idle exchange channels
  // after SUB_IDLE_MS. On return, resubscribe and backfill everything that
  // could have moved meanwhile (missed candles, fills, session titles).
  const onVisibility = () => {
    if (!visible()) { hiddenAt = Date.now(); return }
    const away = hiddenAt ? Date.now() - hiddenAt : 0
    hiddenAt = 0
    store.patch({ resumedAt: Date.now() })
    void loadStatus(); void loadSnapshot(); void loadMarketDetail(store.get().activeCoin); void loadAccount(); void pollEvents()
    if (away > 10_000) { void loadCandles(); void loadMarkets(true); void loadSessions(); void loadTradeHistory(true); void loadChartMarks() }
  }
  document.addEventListener('visibilitychange', onVisibility)
  return () => { clearInterval(fast); clearInterval(slow); clearInterval(titles); clearInterval(detail); document.removeEventListener('visibilitychange', onVisibility) }
}

/**
 * Queue an order or cancel intent into the active trading conversation.
 * The ticket never signs or submits an exchange action directly.
 */
export function queueToAgent(text: string): boolean {
  const ref = getActiveRef()
  if (!ref?.binding?.session?.prompt) {
    notify(t('desk.noSession', '先在左侧选择一个交易会话'))
    return false
  }
  void ref.binding.session.prompt([{ type: 'text', text }], 'queue')
    .catch((e) => notify(String((e as Error)?.message ?? e)))
  notify(t('desk.queued', '已把请求送入交易会话，agent 将核对后处理'))
  return true
}

/** Stage a chart quote for the native composer; the trader edits it before sending. */
export function insertChartReference(selection: ChartSelection, coin: string, interval: Interval): void {
  const sessionId = store.get().activeSessionId
  if (!sessionId) { notify(tr('请先选择交易会话', 'Choose a trading session first')); return }
  const text = formatChartReference(selection, coin, interval, tr('zh', 'en') === 'en')
  const quote = { id: Date.now() + Math.random(), sessionId, text, label: chartReferenceLabel(selection, coin, interval), coin, interval, t: selection.candle.t }
  store.patch((current) => ({ chartReferences: [...current.chartReferences, quote] }))
  if (store.get().workspace?.layout?.chatCollapsed) notify(tr('点位已暂存，展开对话栏后可编辑', 'Chart point saved; open the chat panel to edit it'))
}

/** One authoritative UI → host focus path, including the active session. */
/** Reopen a quoted chart point: switch market / interval when needed, then let the chart focus it. */
export async function focusChartReference(ref: Pick<ChartReferenceRef, 'coin' | 'interval' | 't'>): Promise<void> {
  if (store.get().activeCoin !== ref.coin) await setDeskCoin(ref.coin)
  if (store.get().interval !== ref.interval) {
    store.patch({ interval: ref.interval })
    pushDeskInterval(ref.interval)
    void loadCandles()
  }
  store.patch({ chartFocus: { coin: ref.coin, interval: ref.interval, t: ref.t, at: Date.now() } })
}

export function setDeskCoin(coin: string): Promise<void> {
  const version = ++focusVersion
  const sessionId = store.get().activeSessionId
  const task = focusQueue.catch(() => {}).then(async () => {
    if (version !== focusVersion) return
    try {
      if (sessionId) await hyperCall('bindCoin', { sessionId, coin, source: 'ui', clientId: focusClientId })
      else await hyperCall('deskState', { coin, sessionId: null, clientId: focusClientId })
      if (version === focusVersion) applyLocalCoin(coin)
    } catch (e) {
      notify(tr('交易台币种同步失败', 'Could not sync desk market') + '：' + String((e as Error)?.message ?? e))
      throw e
    }
  })
  focusQueue = task.catch(() => {})
  return task
}

export function pushDeskInterval(interval: Interval): void {
  if (store.get().activeSessionId) saveSessionWorkspace({ interval })
  else void hyperCall('deskState', { interval }).catch((e) => notify(tr('K 线周期同步失败', 'Could not sync chart interval') + '：' + String((e as Error)?.message ?? e)))
}
