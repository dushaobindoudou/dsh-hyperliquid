/**
 * dsh-hyperliquid — the client-side external store.
 *
 * One module-level store for the whole plugin (the dsh shell renders exactly
 * one panel instance per plugin); components read it through
 * useSyncExternalStore. `activeRef` is deliberately NOT React state: the desk
 * queues agent requests through the retained session without prop drilling.
 * @module src/client/store
 */

import { useSyncExternalStore } from 'react'
import type { DeskState, Notice, RetainedSession, TapePlacement } from './types'

export interface Store<T> {
  get: () => T
  patch: (p: Partial<T> | ((prev: T) => Partial<T>)) => void
  subscribe: (fn: () => void) => () => void
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial
  const subs = new Set<() => void>()
  return {
    get: () => state,
    patch(p) {
      const partial = typeof p === 'function' ? p(state) : p
      const next = { ...state, ...partial }
      if (next !== state) {
        state = next
        subs.forEach((f) => { try { f() } catch { /* a listener bug never breaks the store */ } })
      }
    },
    subscribe(fn) {
      subs.add(fn)
      return () => { subs.delete(fn) }
    },
  }
}

const TAPE_PLACEMENT_KEY = 'dsh-hyperliquid.tapePlacement'

function loadTapePlacement(): TapePlacement {
  try { return localStorage.getItem(TAPE_PLACEMENT_KEY) === 'below' ? 'below' : 'auto' } catch { return 'auto' }
}

/** Desk-wide display preference, remembered in this browser. */
export function setTapePlacement(placement: TapePlacement): void {
  try { localStorage.setItem(TAPE_PLACEMENT_KEY, placement) } catch { /* storage unavailable */ }
  store.patch({ tapePlacement: placement })
}

export const store = createStore<DeskState>({
  tapePlacement: loadTapePlacement(),
  resumedAt: 0,
  candlesOlder: 'idle',
  status: null,
  statusError: null,
  statusAt: 0,
  markets: [],
  marketsAt: 0,
  marketCatalog: [],
  marketCatalogAt: 0,
  selectedMarket: null,
  selectedMarketAt: 0,
  selectedMarketError: null,
  activeCoin: 'BTC',
  interval: '15m',
  bookGrouping: 'full',
  snapshot: null,
  snapshotAt: 0,
  snapshotError: null,
  candles: [],
  candlesState: 'idle',
  chartMarks: [],
  chartMarksKey: '',
  fundingRows: [],
  fundingCoin: null,
  fundingState: 'idle',
  account: null,
  accountError: null,
  accountAt: 0,
  tradeHistory: null,
  tradeHistoryAt: 0,
  tradeHistoryError: null,
  sessions: [],
  sessionsLoaded: false,
  sessionTitles: {},
  archivedSessionIds: [],
  nativeSessionIds: [],
  nativeSessionsReady: false,
  localeRevision: 0,
  activeSessionId: null,
  workspace: null,
  workspaceSessionId: null,
  notice: null,
  eventsSeq: 0,
  ticketDraft: null,
  chartReferences: [],
  chartFocus: null,
})

export function useStore(): DeskState {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}

// Debug/testing affordance: lets harnesses and devtools inspect desk state.
if (typeof window !== 'undefined') {
  try { (window as any).__dhlStore = store } catch { /* non-window env */ }
}

// ── retained active session (plain module state, see module doc) ─────────
let activeRef: RetainedSession | null = null

export function getActiveRef(): RetainedSession | null {
  return activeRef
}

export function setActiveRef(ref: RetainedSession | null): void {
  activeRef = ref
}

// ── transient notices ────────────────────────────────────────────────────
export function notify(text: string | null): void {
  if (!text) {
    store.patch({ notice: null })
    return
  }
  const notice: Notice = { text, at: Date.now() }
  store.patch({ notice })
  setTimeout(() => {
    const n = store.get().notice
    if (n && Date.now() - n.at >= 6000) store.patch({ notice: null })
  }, 6500)
}
