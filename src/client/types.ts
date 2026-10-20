/**
 * dsh-hyperliquid — client types.
 *
 * Wire payloads from the host `hyper` Remote namespace are plain JSON; the
 * shapes that the UI itself owns are typed precisely, remote payloads stay
 * `any` at the boundary (tighten per-field as the desk grows).
 * @module src/client/types
 */

export type Interval = '1m' | '3m' | '5m' | '15m' | '30m' | '1h' | '2h' | '4h' | '8h' | '12h' | '1d' | '3d' | '1w' | '1M'
export type BookGrouping = 'full' | '5' | '5x2' | '5x5' | '4' | '3' | '2'

export type CandleState = 'idle' | 'loading' | 'ready' | 'error'

import type { MaLine } from '../../lib/moving-average.js'
export type { MaLine }

export type TapePlacement = 'auto' | 'below'

export interface SessionWorkspace {
  coin: string
  interval: Interval
  bookGrouping: BookGrouping
  chartTab: 'chart' | 'funding'
  tapeTab: 'book' | 'trades'
  bottomTab: 'positions' | 'orders' | 'account' | 'review'
  indicators: import('./chart-indicators').IndicatorId[]
  showDataWindow?: boolean
  indicatorSettings?: import('../../lib/studies.js').IndicatorSettings
  research?: import('../../lib/workspace-settings.js').ResearchSettings
  chartType?: import('./chart-basics').ChartType
  priceScale: 'normal' | 'log' | 'percentage'
  /** Configurable moving averages (SMA / EMA / SMMA / WMA, optional smoothing). */
  maLines?: MaLine[]
  chartLayers?: { orders: boolean; fills: boolean; drawings: boolean; reasons?: boolean }
  chartRanges: Record<string, { from: number; to: number }>
  layout: { sessionsWidth: number; chatWidth: number; sessionsCollapsed: boolean; deskCollapsed: boolean; chatCollapsed: boolean }
}

export interface Candle {
  /** open time, epoch ms (host converts HL seconds) */
  t: number
  o: number
  h: number
  l: number
  c: number
  v: number
}

export interface Notice {
  text: string
  at: number
}

export interface SessionRow {
  sessionId: string
  coin: string | null
  title: string | null
  createdAt?: number
  updatedAt?: number
}

export interface MarketEntry {
  name: string
  label: string
  kind: 'perp' | 'hip3' | 'spot' | 'outcome'
  venue: string
  tradable: boolean
  /** Order size precision (core and HIP-3 perps). */
  szDecimals?: number
  /** Exchange-provided perpCategories label, if present. */
  category?: string | null
  ctx: any
  maxLeverage: number | null
}

export interface ChartMark {
  /** Shown only on these intervals (all when absent). */
  visibleIntervals?: string[]
  /** Text size and emphasis for text / callout. */
  fontSize?: number
  bold?: boolean
  italic?: boolean
  /** Pinned to the screen (fractions of the plot), for anchored text and tables. */
  screenX?: number
  screenY?: number
  /** Trend line extended past its anchors. */
  extendLeft?: boolean
  extendRight?: boolean
  /** Background fill opacity for shapes. */
  fillOpacity?: number
  /** Custom Fibonacci levels (fib, fibext, fibchannel). */
  levels?: number[]
  /** Volume profile rows and value-area share (vprofile only). */
  rows?: number
  valueArea?: number
  id: string
  sessionId: string
  coin: string
  interval: Interval
  kind: import('../../lib/chart-drawings.js').DrawingKind
  role: 'support' | 'resistance' | 'neutral'
  label: string
  price?: number
  fromTime?: number
  fromPrice?: number
  toTime?: number
  toPrice?: number
  /** Anchors of every kind other than level / trend, in click order. */
  points?: Array<{ time: number; price: number }>
  color?: string
  lineWidth?: number
  lineStyle?: 'solid' | 'dashed' | 'dotted'
  locked?: boolean
  hidden?: boolean
  /** Synced to every trading session of this coin. */
  shared?: boolean
  /** Price-cross alert armed (fires once). */
  alert?: boolean
  alertTriggeredAt?: number
  source: 'agent' | 'user'
  createdAt: number
}

/** A retained native dsh session handle (from the `sessions` service). */
export interface RetainedSession {
  sessionId?: string
  ready?: Promise<unknown>
  release?: () => void
  binding?: {
    ctx?: unknown
    session?: {
      prompt?: (content: Array<{ type: 'text'; text: string }>, mode?: string) => Promise<unknown>
    }
  }
}

export interface DeskState {
  status: any
  statusError: string | null
  statusAt: number
  markets: any[]
  marketsAt: number
  marketCatalog: MarketEntry[]
  marketCatalogAt: number
  selectedMarket: MarketEntry | null
  /** Source observation time returned by the host, not RPC receipt time. */
  selectedMarketAt: number
  selectedMarketError: string | null
  activeCoin: string
  interval: Interval
  bookGrouping: BookGrouping
  snapshot: any
  snapshotAt: number
  snapshotError: string | null
  candles: Candle[]
  candlesState: CandleState
  /** Back-fill of history older than the first loaded candle (left-scroll paging). */
  candlesOlder: 'idle' | 'loading' | 'done' | 'error'
  chartMarks: ChartMark[]
  chartMarksKey: string
  fundingRows: Array<{ time: number; fundingRate: string; premium?: string }>
  fundingCoin: string | null
  fundingState: CandleState
  account: any
  accountError: string | null
  accountAt: number
  tradeHistory: { mode: 'paper' | 'live'; orders: any[]; fills: any[] } | null
  tradeHistoryAt: number
  tradeHistoryError: string | null
  sessions: SessionRow[]
  sessionsLoaded: boolean
  sessionTitles: Record<string, string | null>
  archivedSessionIds: string[]
  nativeSessionIds: string[]
  nativeSessionsReady: boolean
  localeRevision: number
  activeSessionId: string | null
  workspace: SessionWorkspace | null
  workspaceSessionId: string | null
  notice: Notice | null
  eventsSeq: number
  ticketDraft: { coin: string; isBuy: boolean; px: string; at: number } | null
  chartReferences: Array<{ id: number; sessionId: string; text: string; label: string; coin: string; interval: Interval; t: number }>
  /** A chart point to bring into view, e.g. after the trader opens a quote chip. */
  chartFocus: { coin: string; interval: Interval; t: number; at: number } | null
  /** Order book / trades placement: beside the chart when wide enough, or always below it. */
  tapePlacement: TapePlacement
  /** When the panel last became visible; stale data right after this is a resync, not an outage. */
  resumedAt: number
}
