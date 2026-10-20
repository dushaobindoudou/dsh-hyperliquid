/**
 * dsh-hyperliquid — candle chart on the real TradingView Lightweight Charts
 * (npm `lightweight-charts`, Apache-2.0, version-pinned in package.json).
 *
 * Replaces the hand-rolled SVG chart AND the abandoned base64-vendored
 * bundle. The library source ships through esbuild; upgrading is a
 * package.json bump + `npm run build`, never a re-vendor.
 *
 * Colors: up=green / down=red (Hyperliquid convention) read from the shell
 * theme tokens, re-applied when the shell theme flips.
 * @module src/client/components/candle-chart
 */

import * as React from 'react'
import {
  createChart,
  CandlestickSeries,
  BarSeries,
  AreaSeries,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createSeriesMarkers,
  PriceScaleMode,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type Logical,
} from 'lightweight-charts'
import { t, tr } from '../remote'
import { fmtPrice } from '../format'
import type { Candle, ChartMark } from '../types'
import { chartIndicators, type IndicatorId, type ChartPoint } from '../chart-indicators'
import { selectChartCandle, type ChartHit, type ChartSelection } from '../chart-reference'
import type { TradeEvent } from '../trade-events'
import { maLabel, maSeries, type MaLine } from '../../../lib/moving-average.js'
import { DrawingShape, isMultiKind, clicksNeeded, completePoints, constrainPoints, geometryPatch, markPoints, type DrawPoint, type DrawingKind, type Projector } from '../drawing-tools'
import { BRUSH_MAX, FREEHAND_KINDS, PATH_MAX, SCREEN_KINDS, volumeProfile } from '../../../lib/chart-drawings.js'
import { DrawToolbar, DRAW_COLORS } from './draw-toolbar'
import { DrawingEditor } from './drawing-editor'
import { UiIcon } from './panel-icons'
import { pressStillAClick } from '../click-guard'
import { chartBars, candleIndex, downloadBlob, type ChartType, type ChartCommand } from '../chart-basics'
import { chartImage } from '../chart-export'
import { notify } from '../store'
import { normalizeIndicatorSettings, studyDefinitions, type IndicatorSettings } from '../../../lib/studies.js'
import { feed } from '../chart-feed'

export type MagnetMode = 'off' | 'weak' | 'strong'
/** Weak magnet radius in pixels (TradingView snaps within roughly this distance). */
const MAGNET_PX = 14

/** What a finished drawing hands back: level a price, trend its flat fields, the rest anchor points. */
export type DrawPayload = { kind: 'level'; price: number } | { kind: 'trend'; fromTime: number; fromPrice: number; toTime: number; toPrice: number } | { kind: Exclude<DrawingKind, 'level' | 'trend'>; points: DrawPoint[]; screenX?: number; screenY?: number }
/** A copy of an existing drawing: geometry already shifted, style and label kept. */
export type ClonePayload = { kind: DrawingKind; geometry: Record<string, unknown>; style: Record<string, unknown>; label: string }

/** Distinct from the fixed studies' colors (mint / amber / violet / blue). */
const MA_PALETTE = ['#29b6f6', '#ff7eb6', '#c6e377', '#ffb74d', '#b39ddb', '#4dd0e1', '#f48fb1', '#aed581']
export const maColor = (line: MaLine, index: number) => line.color ?? MA_PALETTE[index % MA_PALETTE.length]

const CHART_HEIGHT = 410
/** Load older history once fewer than this many bars remain left of the view. */
const OLDER_THRESHOLD_BARS = 30
const FALLBACK_UP = '#3b9c6d'
const FALLBACK_DOWN = '#e24b4a'
const SMA20_COLOR = '#269c89'
const DRAW_COLOR = '#4c82d8'
const FALLBACK_TEXT = '#888780'
const FALLBACK_BORDER = 'rgba(128,128,128,.25)'

/** Positions preview with their default 2R target as soon as entry and stop exist. */
function completePreview(kind: DrawingKind, points: DrawPoint[]): DrawPoint[] {
  if ((kind === 'long' || kind === 'short') && points.length === 2) return completePoints(kind, points) ?? points.slice(0, 1)
  return points
}

/** Candles with open time in [from, to] (ms), by binary search (bars are sorted by time). */
function candlesIn(candles: Candle[], from: number, to: number): Candle[] {
  const first = (time: number) => { let lo = 0, hi = candles.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (candles[mid].t < time) lo = mid + 1; else hi = mid } return lo }
  const end = to >= Number.MAX_SAFE_INTEGER ? candles.length : first(to + 1)
  return candles.slice(first(from), end)
}

/** The candle whose open time is `time` (ms), by binary search. */
function barAt(candles: Candle[], time: number): Candle | null {
  const t = Math.floor(time / 1000)
  let lo = 0, hi = candles.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, value = Math.floor(candles[mid].t / 1000)
    if (value === t) return candles[mid]
    if (value < t) lo = mid + 1; else hi = mid - 1
  }
  return null
}

function cssVar(el: HTMLElement, name: string, fallback: string): string {
  const v = getComputedStyle(el).getPropertyValue(name).trim()
  return v || fallback
}

export interface ChartLink {
  id: string
  cursor?: { source: string; at: number; time: number | null } | null
  range?: { source: string; at: number; from: number; to: number } | null
  onCursor: (time: number | null) => void
  onRange: (range: { from: number; to: number }) => void
}

interface ChartRefs {
  chart: IChartApi
  candles: ISeriesApi<'Candlestick' | 'Bar' | 'Line' | 'Area'>
  volume: ISeriesApi<'Histogram'>
  sma: ISeriesApi<'Line'>
  basis: ISeriesApi<'Line'>
  extra: Record<string, ISeriesApi<'Line'>>
  rsiBounds?: IPriceLine[]
  stochBounds?: IPriceLine[]
  sma60: ISeriesApi<'Line'>
  ema20: ISeriesApi<'Line'>
  ema50: ISeriesApi<'Line'>
  upper: ISeriesApi<'Line'>
  lower: ISeriesApi<'Line'>
  rsi?: ISeriesApi<'Line'>
  atr?: ISeriesApi<'Line'>
  vwap?: ISeriesApi<'Line'>
  macd?: ISeriesApi<'Line'>
  signal?: ISeriesApi<'Line'>
  histogram?: ISeriesApi<'Histogram'>
}

function chartData(points: ChartPoint[]): Array<{ time: UTCTimestamp; value: number }> {
  return points.map((point) => ({ time: point.time as UTCTimestamp, value: point.value }))
}

interface ChartProps {
  candles: Candle[]; marks: ChartMark[]; indicators: Set<IndicatorId>; expanded: boolean; resetToken: number
  indicatorSettings?: IndicatorSettings
  showDataWindow?: boolean
  link?: ChartLink
  compact?: boolean
  readOnly?: boolean
  chartType?: ChartType
  command?: ChartCommand | null
  caption?: string
  drawMode: DrawingKind | null
  onDraw: (payload: DrawPayload) => void
  onSelect: (selection: ChartSelection) => void
  priceScale: 'normal' | 'log' | 'percentage'
  visibleRange: { from: number; to: number } | null
  onVisibleRange: (range: { from: number; to: number }) => void
  tradeEvents: TradeEvent[]
  onNeedOlder: () => void
  olderState: 'idle' | 'loading' | 'done' | 'error'
  /** Bring this candle into view and mark it, once per `at`. */
  focus: { t: number; at: number } | null
  /** Configurable moving averages drawn over the candles. */
  maLines: MaLine[]
  /** Snap drawing anchors to the nearest open/high/low/close. */
  magnet: MagnetMode
  /** Lock every drawing against dragging (selection and styling still work). */
  drawingsLocked: boolean
  onEditMark: (id: string, patch: Record<string, unknown>) => void
  onRemoveMark: (id: string) => void
  /** Current interval: drawings limited to other intervals are not drawn (they stay in the list). */
  interval?: string
  /** Batch actions for a multi-selection (one undo step each). */
  onRemoveMarks?: (ids: string[]) => void
  onEditMarks?: (ids: string[], patch: Record<string, unknown>) => void
  onEditEach?: (patches: Array<[string, Record<string, unknown>]>) => void
  /** Show each fill's decision reason next to its dot. */
  showReasons: boolean
  /** Take a fill (and its reason) back to the conversation that decided it. */
  onAnalyzeFill: (event: TradeEvent) => void
  onCloneMark: (payload: ClonePayload) => void
  /** Select a drawing and bring it into view (from the drawings list), once per `at`. */
  selectRequest: { id: string; at: number } | null
}

/** Drawings that end at their anchors (no ray, line or fan running to the plot edge), so they can be culled. */
// Not here: anything that can reach past its anchors — circles (radius), fib extensions (projection), the
// head-and-shoulders neckline, callouts (long text) — or runs to the plot edge (lines, rays, channels, fans).
/** Overlay height the top toolbar occupies (top offset + one row + margin). */
const TOOLBAR_CLEARANCE = 84
// Only drawings whose geometry stays within their anchors (plus the margin): rotated rectangles and arcs do not.
const FINITE_KINDS = new Set(['ghostfeed', 'highlighter', 'path', 'polyline', 'pin', 'ellipse', 'curve', 'note', 'pricenote', 'signpost', 'forecast', 'cypher', 'threedrives', 'elliotttri', 'elliottwxy', 'elliottwxyxz', 'trend', 'rect', 'measure', 'fib', 'long', 'short', 'text', 'arrow', 'triangle', 'brush',
  'infoline', 'trendangle', 'pricerange', 'daterange', 'elliott', 'elliottabc', 'xabcd', 'abcd', 'gannbox', 'gannsquare', 'icon', 'vprofile', 'regression'])
/** Every anchor beyond the same side of the plot (with a margin for labels and handles). */
function offscreen(points: DrawPoint[], view: { project: (time: number, price: number) => { x: number } | null; width: number }): boolean {
  if (!points.length) return false
  const xs = points.map((point) => view.project(point.time, point.price)?.x)
  if (xs.some((x) => x == null)) return false
  return xs.every((x) => x! < -320) || xs.every((x) => x! > view.width + 320)
}

/** Volume profiles per candle set: panning, crosshair moves and drags reuse the result until the bars change. */
const profileCache = new WeakMap<Candle[], Map<string, ReturnType<typeof volumeProfile>>>()
function cachedProfile(candles: Candle[], from: number, to: number, options: { rows?: number; valueArea?: number } = {}): ReturnType<typeof volumeProfile> {
  let byRange = profileCache.get(candles)
  if (!byRange) { byRange = new Map(); profileCache.set(candles, byRange) }
  const key = `${from}:${to}:${options.rows ?? ''}:${options.valueArea ?? ''}`
  if (!byRange.has(key)) byRange.set(key, volumeProfile(candles.filter((c) => c.t >= from && c.t <= to).map((c) => ({ open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v })), options))
  return byRange.get(key)!
}

export function CandleChart({ candles, marks, indicators, expanded, resetToken, drawMode, onDraw, onSelect, priceScale, visibleRange, onVisibleRange, tradeEvents, onNeedOlder, olderState, focus, maLines, magnet, drawingsLocked, onEditMark, onRemoveMark, interval, onRemoveMarks, onEditMarks, onEditEach, showReasons, onAnalyzeFill, onCloneMark, selectRequest, chartType = 'candles', command = null, caption = '', indicatorSettings, showDataWindow = false, link, compact = false, readOnly = false }: ChartProps) {
  const boxRef = React.useRef<HTMLDivElement>(null)
  const clipId = React.useRef('dhl-plot-' + Math.random().toString(36).slice(2))
  const linkRef = React.useRef(link); linkRef.current = link
  const syncingCursor = React.useRef(false)
  const externalRangeUntil = React.useRef(0)
  const settings = React.useMemo(() => normalizeIndicatorSettings(indicatorSettings), [indicatorSettings])
  const refs = React.useRef<ChartRefs | null>(null)
  const priceLines = React.useRef(new Map<string, IPriceLine>())
  const tradeMarkers = React.useRef<ISeriesMarkersPluginApi<Time> | null>(null)
  const fitted = React.useRef(false)
  const firstBarTime = React.useRef<number | null>(null)
  const handledFocus = React.useRef(0)
  const handledCommand = React.useRef(0)
  const maRefs = React.useRef(new Map<string, { main: ISeriesApi<'Line'>; smooth?: ISeriesApi<'Line'> }>())
  const restoring = React.useRef(false)
  const initialRange = React.useRef(visibleRange)
  const drawModeRef = React.useRef(drawMode)
  const onDrawRef = React.useRef(onDraw)
  const onSelectRef = React.useRef(onSelect)
  const selectionData = React.useRef({ candles, indicators, maLines, settings })
  const onRangeRef = React.useRef(onVisibleRange)
  const onNeedOlderRef = React.useRef(onNeedOlder)
  onNeedOlderRef.current = onNeedOlder
  const pending = React.useRef<DrawPoint[]>([])
  const magnetRef = React.useRef(magnet)
  magnetRef.current = magnet
  const candlesRef = React.useRef(candles)
  candlesRef.current = candles
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const selectedRef = React.useRef<string | null>(null)
  selectedRef.current = selectedId
  /** Shift / Ctrl / ⌘-click builds a group selection (two or more drawings). */
  const [group, setGroup] = React.useState<string[]>([])
  const groupRef = React.useRef<string[]>([])
  groupRef.current = group
  const [hoverSnapped, setHoverSnapped] = React.useState(false)
  const lastSnapped = React.useRef(false)
  /** Live geometry of the drawing being dragged; saved once on release. */
  const [draft, setDraft] = React.useState<{ id: string; points: DrawPoint[] } | null>(null)
  /** Live positions while a group selection is dragged. */
  const [groupDraft, setGroupDraft] = React.useState<Map<string, DrawPoint[]> | null>(null)
  const [selectedFill, setSelectedFill] = React.useState<string | null>(null)
  const selectedFillRef = React.useRef<string | null>(null)
  selectedFillRef.current = selectedFill
  const snapRef = React.useRef<((event: MouseEvent, previous?: DrawPoint, useMagnet?: boolean) => DrawPoint | null) | null>(null)
  const hoveredHit = React.useRef<ChartHit>(null)
  drawModeRef.current = drawMode
  onDrawRef.current = onDraw
  onSelectRef.current = onSelect
  selectionData.current = { candles, indicators, maLines, settings }
  onRangeRef.current = (range) => {
    onVisibleRange(range)
    if (performance.now() > externalRangeUntil.current) linkRef.current?.onRange(range)
  }
  const [crosshair, setCrosshair] = React.useState<Candle | null>(null)
  const [selectedTime, setSelectedTime] = React.useState<number | null>(null)
  const [themeVersion, setThemeVersion] = React.useState(0)
  const [viewportVersion, setViewportVersion] = React.useState(0)
  const projectionStamp = React.useRef<Array<number | null>>([])
  const readProjection = (r: ChartRefs, box: HTMLDivElement) => {
    const base = candlesRef.current[0]?.c ?? 1
    return [r.chart.timeScale().logicalToCoordinate(0 as Logical), r.chart.timeScale().logicalToCoordinate(1 as Logical),
      r.candles.priceToCoordinate(base), r.candles.priceToCoordinate(base * 1.01), box.clientWidth, box.clientHeight, base]
  }
  const [pendingPoints, setPendingPoints] = React.useState<DrawPoint[]>([])
  const [drawingHover, setDrawingHover] = React.useState<DrawPoint | null>(null)
  const showVolume = indicators.has('volume')
  const studies = React.useMemo(() => chartIndicators(candles, settings), [candles, settings])
  const maComputed = React.useMemo(() => maLines.map((line, index) => ({ line, color: maColor(line, index), ...maSeries(candles, line) })), [candles, maLines])
  // Bar index ↔ time, extrapolated beyond both ends so drawings can reach empty space.
  // A live tick only changes the last bar's prices; the time axis (and every drawing's x) stays put, so
  // the mapping is rebuilt only when bars are added, prepended or replaced.
  const axisKey = `${candles.length}:${candles[0]?.t ?? 0}:${candles.at(-1)?.t ?? 0}`
  const timeline = React.useMemo(() => {
    const times = [...new Set(candles.map((candle) => Math.floor(candle.t / 1000)))].sort((a, b) => a - b)
    const step = times.length > 1 ? times[times.length - 1] - times[times.length - 2] : 60
    const toLogical = (ms: number) => {
      const t = ms / 1000
      if (!times.length) return 0
      if (t <= times[0]) return (t - times[0]) / step
      if (t >= times[times.length - 1]) return times.length - 1 + (t - times[times.length - 1]) / step
      let lo = 0, hi = times.length - 1
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (times[mid] <= t) lo = mid; else hi = mid }
      return lo + (t - times[lo]) / (times[hi] - times[lo])
    }
    const toTime = (logical: number) => {
      if (!times.length) return Date.now()
      const i = Math.round(logical)
      if (i < 0) return (times[0] + i * step) * 1000
      if (i >= times.length) return (times[times.length - 1] + (i - times.length + 1) * step) * 1000
      return times[i] * 1000
    }
    return { toLogical, toTime }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [axisKey])
  const timelineRef = React.useRef(timeline)
  timelineRef.current = timeline

  // ── chart lifecycle: create once per mount, tear down on unmount ──────
  React.useEffect(() => {
    const box = boxRef.current
    if (!box) return undefined

    const readTheme = () => ({
      up: cssVar(box, '--dsw-alias-state-success-primary', FALLBACK_UP),
      down: cssVar(box, '--dsw-alias-state-error-primary', FALLBACK_DOWN),
      text: cssVar(box, '--dsw-alias-label-secondary', FALLBACK_TEXT),
      border: cssVar(box, '--dsw-alias-border-l1', FALLBACK_BORDER),
    })

    const theme = readTheme()
    const chart = createChart(box, {
      width: box.clientWidth || 720,
      height: CHART_HEIGHT,
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: theme.text, fontFamily: 'inherit' },
      grid: { vertLines: { color: theme.border }, horzLines: { color: theme.border } },
      rightPriceScale: { borderColor: theme.border },
      timeScale: { borderColor: theme.border, timeVisible: true, secondsVisible: false },
    })

    const candleSeries: ChartRefs['candles'] = chartType === 'line'
      ? chart.addSeries(LineSeries, { color: '#4c82d8', lineWidth: 2 })
      : chartType === 'area' ? chart.addSeries(AreaSeries, { lineColor: '#4c82d8', topColor: 'rgba(76,130,216,.28)', bottomColor: 'rgba(76,130,216,0)' })
      : chartType === 'bars' ? chart.addSeries(BarSeries, { upColor: theme.up, downColor: theme.down })
      : chart.addSeries(CandlestickSeries, {
        upColor: theme.up, downColor: theme.down, borderUpColor: theme.up, borderDownColor: theme.down,
        wickUpColor: theme.up, wickDownColor: theme.down,
      })
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'dhl-vol',
      lastValueVisible: false,
      priceLineVisible: false,
    })
    const smaSeries = chart.addSeries(LineSeries, {
      color: SMA20_COLOR,
      lineWidth: 2, lastValueVisible: false, priceLineVisible: false,
    })
    const basis = chart.addSeries(LineSeries, { color: '#7aa4d4', lineWidth: 1, lastValueVisible: false, priceLineVisible: false })
    const sma60 = chart.addSeries(LineSeries, { color: '#d78c78', lineWidth: 2, lastValueVisible: false, priceLineVisible: false })
    const ema20 = chart.addSeries(LineSeries, { color: '#e2a943', lineWidth: 2, lastValueVisible: false, priceLineVisible: false })
    const ema50 = chart.addSeries(LineSeries, { color: '#9b86db', lineWidth: 2, lastValueVisible: false, priceLineVisible: false })
    const upper = chart.addSeries(LineSeries, { color: '#7aa4d4', lineWidth: 1, lineStyle: LineStyle.Dashed, lastValueVisible: false, priceLineVisible: false })
    const lower = chart.addSeries(LineSeries, { color: '#7aa4d4', lineWidth: 1, lineStyle: LineStyle.Dashed, lastValueVisible: false, priceLineVisible: false })
    chart.priceScale('dhl-vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } })
    refs.current = { chart, candles: candleSeries, volume: volumeSeries, sma: smaSeries, basis, extra: {}, sma60, ema20, ema50, upper, lower }
    tradeMarkers.current = createSeriesMarkers(candleSeries, [])
    fitted.current = false
    const identifyHit = (hovered: unknown): ChartHit => {
      const r = refs.current
      if (!r || !hovered) return null
      if (hovered === r.volume) return 'volume'
      if (hovered === r.sma) return 'sma20'
      if (hovered === r.sma60) return 'sma60'
      if (hovered === r.ema20) return 'ema20'
      if (hovered === r.ema50) return 'ema50'
      if (hovered === r.upper) return 'bollingerUpper'
      if (hovered === r.lower) return 'bollingerLower'
      if (hovered === r.basis) return 'bollinger20'
      if (hovered === r.extra.stochK || hovered === r.extra.stochD) return 'stochastic'
      if (hovered === r.extra.adx || hovered === r.extra.plusDI || hovered === r.extra.minusDI) return 'adx'
      if (hovered === r.extra.obv) return 'obv'
      if (hovered === r.rsi) return 'rsi14'
      if (hovered === r.atr) return 'atr14'
      if (hovered === r.vwap) return 'vwap'
      if (hovered === r.macd) return 'macd'
      if (hovered === r.signal) return 'macdSignal'
      if (hovered === r.histogram) return 'macdHistogram'
      return null
    }
    chart.subscribeCrosshairMove((param) => {
      hoveredHit.current = identifyHit(param.hoveredSeries)
      // Always quote the real exchange candle, including on synthetic HA / line charts.
      const time = typeof param.time === 'number' ? param.time * 1000 : null
      setCrosshair(time != null ? barAt(candlesRef.current, time) : null)
      if (!syncingCursor.current) linkRef.current?.onCursor(time)
    })
    // Browsers still dispatch click after a pointer drag. Keep the press
    // trajectory so panning and scaling never turn into a chart quote or mark.
    let press: { id: number; x: number; y: number; dragged: boolean; range: { from: number; to: number } | null } | null = null
    const down = (event: PointerEvent) => {
      const range = chart.timeScale().getVisibleLogicalRange()
      press = event.button === 0 && event.target instanceof HTMLCanvasElement
        ? { id: event.pointerId, x: event.clientX, y: event.clientY, dragged: false,
            range: range ? { from: range.from, to: range.to } : null } : null
    }
    const move = (event: PointerEvent) => {
      if (press?.id === event.pointerId && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 5) press.dragged = true
      if (drawModeRef.current && event.target instanceof HTMLCanvasElement) {
        const point = pointAt(event, pending.current.at(-1))
        if (point) { setDrawingHover(point); setHoverSnapped(lastSnapped.current) }
      }
    }
    const cancel = () => { press = null }
    /**
     * Pointer → anchor: time snaps to a bar slot (also in the empty future
     * area); the magnet pulls the price onto that bar's O/H/L/C (weak: within
     * MAGNET_PX, strong: always); Shift keeps the previous anchor's price.
     */
    const snapPoint = (event: MouseEvent, previous?: DrawPoint, useMagnet = true): DrawPoint | null => {
      const rect = box.getBoundingClientRect()
      const y = event.clientY - rect.top
      const logical = chart.timeScale().coordinateToLogical(event.clientX - rect.left)
      let price = Number(candleSeries.coordinateToPrice(y))
      if (logical == null || !Number.isFinite(price) || price <= 0) return null
      const time = timelineRef.current.toTime(Number(logical))
      // Holding Ctrl/⌘ inverts the magnet for this pointer move (TradingView behaviour).
      const mode = event.ctrlKey || event.metaKey ? (magnetRef.current === 'off' ? 'strong' : 'off') : magnetRef.current
      lastSnapped.current = false
      if (useMagnet && mode !== 'off') {
        const bar = barAt(candlesRef.current, time)
        if (bar) {
          let best = { price, distance: Infinity }
          for (const value of [bar.o, bar.h, bar.l, bar.c]) {
            const coordinate = candleSeries.priceToCoordinate(value)
            if (coordinate != null && Math.abs(coordinate - y) < best.distance) best = { price: value, distance: Math.abs(coordinate - y) }
          }
          if (mode === 'strong' || best.distance <= MAGNET_PX) { price = best.price; lastSnapped.current = true }
        }
      }
      if (event.shiftKey && previous) {
        // Shift constrains the segment from the previous anchor to 0° or ±45° on screen (never vertical:
        // two-point lines need two different times).
        const px = chart.timeScale().logicalToCoordinate(timelineRef.current.toLogical(previous.time) as Logical)
        const py = candleSeries.priceToCoordinate(previous.price)
        const x = event.clientX - rect.left
        if (px == null || py == null) return { time, price: previous.price }
        const dx = x - px, dy = y - py
        const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4)
        if (Math.abs(Math.abs(angle) - Math.PI / 2) < 1e-6 || Math.abs(angle) < 1e-6 || Math.abs(Math.abs(angle) - Math.PI) < 1e-6) return { time, price: previous.price }
        const along = dx * Math.cos(angle) + dy * Math.sin(angle)
        const tx = px + Math.cos(angle) * along, ty = py + Math.sin(angle) * along
        const snappedLogical = chart.timeScale().coordinateToLogical(tx)
        const snappedPrice = Number(candleSeries.coordinateToPrice(ty))
        if (snappedLogical == null || !Number.isFinite(snappedPrice) || snappedPrice <= 0) return { time, price: previous.price }
        return { time: timelineRef.current.toTime(Number(snappedLogical)), price: snappedPrice }
      }
      return { time, price }
    }
    snapRef.current = snapPoint
    /** Pointer → time (snapped to a bar slot, also in the empty future area) and price. */
    const pointAt = (event: MouseEvent, previous?: DrawPoint): DrawPoint | null => snapPoint(event, previous)
    box.addEventListener('pointerdown', down, true)
    box.addEventListener('pointermove', move, true)
    box.addEventListener('pointerup', move, true)
    box.addEventListener('pointercancel', cancel, true)
    // Native click, not LWC subscribeClick: lightweight-charts counts clicks within its 500ms
    // double-click window and fires no click callback for the second one (a dblclick only if
    // within 5px). The second anchor of a quickly drawn line was dropped that way (verified
    // against 0.1.0: 100ms between clicks missed 20/20, 700ms missed 0/20).
    let touchTapAt = -Infinity
    let lastMultiClick: { x: number; y: number; at: number } | null = null, multiFinishedAt: { x: number; y: number; at: number } | null = null
    /** Whether a click came from a finger (Chrome reports it as a touch PointerEvent). */
    const fromTouch = (event: MouseEvent) => (event as PointerEvent).pointerType === 'touch' ||
      Boolean((event as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } }).sourceCapabilities?.firesTouchEvents)
    /** Returns false when the event did not count as a click on the chart. */
    const chartClick = (event: MouseEvent): false | void => {
      // A touch tap was already handled on pointerup; ignore only the click that tap may still produce.
      if (event.type === 'click' && fromTouch(event) && performance.now() - touchTapAt < 800) return false
      const visible = chart.timeScale().getVisibleLogicalRange()
      // A live bar arriving mid-click must not cancel it (see click-guard).
      const panned = !pressStillAClick(press?.range ?? null, visible ? { from: visible.from, to: visible.to } : null)
      const clicked = Boolean(press && !press.dragged && !panned && event.button === 0)
      press = null
      if (!clicked) return false
      if (!(event.target instanceof HTMLCanvasElement)) return false
      const rect = box.getBoundingClientRect()
      const x = event.clientX - rect.left
      const y = event.clientY - rect.top
      const barTime = chart.timeScale().coordinateToTime(x)
      const mode = drawModeRef.current
      if (mode) {
        void y
        const point = pointAt(event, pending.current.at(-1))
        if (!point) return
        if (mode === 'level') { onDrawRef.current({ kind: 'level', price: point.price }); return }
        if (mode === 'anchoredtext') {
          // Anchored text is pinned to where it was placed on screen.
          const v = viewRef.current, at = v?.project(point.time, point.price)
          onDrawRef.current({ kind: 'anchoredtext', points: [point], ...(v && at && v.width && v.height ? { screenX: Math.min(1, Math.max(0, at.x / v.width)), screenY: Math.min(1, Math.max(0, at.y / v.height)) } : {}) })
          return
        }
        if (isMultiKind(mode)) {
          // Path / polyline: a second click within 6px of the previous one (raw pointer positions, so the
          // magnet cannot move it out of range) is the double-click that finishes. The click after that
          // finishing click is the rest of the same double-click: it must not start the next path.
          const now = performance.now(), here = { x: event.clientX, y: event.clientY }
          const near = (other: { x: number; y: number; at: number } | null, within = Infinity) => Boolean(other && now - other.at < within && Math.hypot(here.x - other.x, here.y - other.y) <= 6)
          if (near(multiFinishedAt, 500)) { multiFinishedAt = null; return }
          if (pending.current.length && near(lastMultiClick)) { multiFinishedAt = { ...here, at: now }; lastMultiClick = null; finishMultiRef.current(); return }
          lastMultiClick = { ...here, at: now }
          pending.current = [...pending.current, point]; setPendingPoints(pending.current)
          if (pending.current.length >= PATH_MAX) finishMultiRef.current()
          return
        }
        const clicks = [...pending.current, point]
        if (clicks.length < clicksNeeded(mode)) { pending.current = clicks; setPendingPoints(clicks); return }
        pending.current = []
        setPendingPoints([])
        const points = completePoints(mode, clicks)
        if (!points) return
        if (mode === 'trend') {
          if (points[0].time === points[1].time) return
          const [from, to] = points[0].time < points[1].time ? points : [points[1], points[0]]
          onDrawRef.current({ kind: 'trend', fromTime: from.time, fromPrice: from.price, toTime: to.time, toPrice: to.price })
        } else onDrawRef.current({ kind: mode, points })
        return
      }
      if (groupRef.current.length) { setGroup([]); return }
      if (selectedRef.current) { setSelectedId(null); return }
      if (selectedFillRef.current) { setSelectedFill(null); return }
      if (typeof barTime !== 'number') return
      const selection = selectChartCandle(selectionData.current.candles, barTime * 1000, selectionData.current.indicators, hoveredHit.current, selectionData.current.maLines, selectionData.current.settings)
      if (selection) { setSelectedTime(selection.candle.t); onSelectRef.current(selection) }
    }
    box.addEventListener('click', chartClick)
    // Touch: lightweight-charts calls preventDefault on touchend when it handles a tap, which
    // suppresses the click a finger tap would produce (see its MouseEventHandler). Treat a
    // touch pointerup that did not drag as the click.
    const touchTap = (event: PointerEvent) => {
      if (event.pointerType !== 'touch' || press?.id !== event.pointerId) return
      // Only a tap that counted as a click suppresses the browser's follow-up click.
      if (chartClick(event) !== false) touchTapAt = performance.now()
    }
    box.addEventListener('pointerup', touchTap)
    let rangeTimer: ReturnType<typeof setTimeout> | null = null
    let viewportFrame = 0
    const refreshOverlay = () => {
      if (viewportFrame) cancelAnimationFrame(viewportFrame)
      // React can yield between shapes while projecting a dense overlay;
      // pointer handling and the exchange canvas keep their frame budget.
      viewportFrame = requestAnimationFrame(() => React.startTransition(() => setViewportVersion((value) => value + 1)))
    }
    chart.timeScale().subscribeVisibleLogicalRangeChange(refreshOverlay)
    // Price-axis drags, wheel scaling and double-click resets move the y mapping without a time-range event.
    // Time pans already emit range events. A drawing drag must only repaint
    // that drawing, rather than invalidating the projection of all 100 shapes.
    let scalingPrice = false
    // Once the canvas owns a gesture, drawing hit targets cannot be used until release.
    // Suspend their duplicate SVG geometry to avoid layout work during dense-chart pans.
    const endCanvasGesture = () => box.classList.remove('dhl-canvas-gesture')
    const beginCanvasGesture = (event: PointerEvent) => {
      if (event.target instanceof HTMLCanvasElement) box.classList.add('dhl-canvas-gesture')
    }
    box.addEventListener('pointerdown', beginCanvasGesture, { passive: true })
    window.addEventListener('pointerup', endCanvasGesture)
    window.addEventListener('pointercancel', endCanvasGesture)
    window.addEventListener('blur', endCanvasGesture)
    const scaleDown = (event: PointerEvent) => {
      scalingPrice = event.target instanceof HTMLCanvasElement &&
        event.clientX >= box.getBoundingClientRect().right - chart.priceScale('right').width()
    }
    const scaleDrag = (event: PointerEvent) => { if (event.buttons && scalingPrice) refreshOverlay() }
    box.addEventListener('pointerdown', scaleDown, { passive: true })
    box.addEventListener('pointermove', scaleDrag, { passive: true })
    box.addEventListener('wheel', refreshOverlay, { passive: true })
    // A wheel / trackpad gesture over a drawing lands on the SVG overlay, which the chart does not
    // listen to: hand it to the chart canvas underneath so zooming and panning work everywhere.
    const forwardWheel = (event: WheelEvent) => {
      const target = event.target as Element | null
      if (!target?.closest?.('.dhl-chart-drawing-overlay')) return
      const canvas = document.elementsFromPoint(event.clientX, event.clientY).find((element) => element instanceof HTMLCanvasElement && box.contains(element))
      if (!canvas) return
      event.preventDefault(); event.stopPropagation()
      canvas.dispatchEvent(new WheelEvent('wheel', { deltaX: event.deltaX, deltaY: event.deltaY, deltaZ: event.deltaZ, deltaMode: event.deltaMode, clientX: event.clientX, clientY: event.clientY,
        screenX: event.screenX, screenY: event.screenY, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey, altKey: event.altKey, bubbles: true, cancelable: true }))
    }
    box.addEventListener('wheel', forwardWheel, { capture: true, passive: false })
    box.addEventListener('dblclick', refreshOverlay)
    const sizeObserver = new ResizeObserver(refreshOverlay)
    sizeObserver.observe(box)
    // Pane separators resize the main canvas while the outer box stays fixed.
    box.querySelectorAll('canvas').forEach((canvas) => sizeObserver.observe(canvas))
    chart.timeScale().subscribeVisibleTimeRangeChange((range) => {
      if (!fitted.current || restoring.current || !range || typeof range.from !== 'number' || typeof range.to !== 'number') return
      if (rangeTimer) clearTimeout(rangeTimer)
      rangeTimer = setTimeout(() => {
        // History restoration can suppress newer range events. Never let an
        // earlier debounced event overwrite the viewport a date jump just saved.
        const current = chart.timeScale().getVisibleRange()
        if (current && typeof current.from === 'number' && typeof current.to === 'number') onRangeRef.current({ from: current.from, to: current.to })
      }, 650)
    })
    // Scrolling toward the oldest loaded bar pages in more history.
    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (!fitted.current || restoring.current || !range) return
      if (range.from < OLDER_THRESHOLD_BARS) onNeedOlderRef.current()
    })

    // Shell theme flip (class/attr toggle) → re-read tokens and re-apply.
    const applyTheme = () => {
      const th = readTheme()
      candleSeries.applyOptions({
        upColor: th.up, downColor: th.down,
        borderUpColor: th.up, borderDownColor: th.down,
        wickUpColor: th.up, wickDownColor: th.down,
      })
      chart.applyOptions({
        layout: { textColor: th.text },
        grid: { vertLines: { color: th.border }, horzLines: { color: th.border } },
        rightPriceScale: { borderColor: th.border },
        timeScale: { borderColor: th.border },
      })
      smaSeries.applyOptions({ color: SMA20_COLOR })
      setThemeVersion((value) => value + 1)
    }
    const observer = new MutationObserver(applyTheme)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] })

    return () => {
      observer.disconnect()
      box.removeEventListener('pointerdown', down, true)
      box.removeEventListener('pointermove', move, true)
      box.removeEventListener('pointerup', move, true)
      box.removeEventListener('pointercancel', cancel, true)
      box.removeEventListener('click', chartClick); box.removeEventListener('pointerup', touchTap)
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(refreshOverlay)
      box.removeEventListener('pointermove', scaleDrag)
      box.removeEventListener('pointerdown', beginCanvasGesture)
      window.removeEventListener('pointerup', endCanvasGesture)
      window.removeEventListener('pointercancel', endCanvasGesture)
      window.removeEventListener('blur', endCanvasGesture)
      endCanvasGesture()
      box.removeEventListener('pointerdown', scaleDown)
      box.removeEventListener('wheel', refreshOverlay); box.removeEventListener('wheel', forwardWheel, { capture: true })
      box.removeEventListener('dblclick', refreshOverlay)
      sizeObserver.disconnect()
      if (viewportFrame) cancelAnimationFrame(viewportFrame)
      if (rangeTimer) clearTimeout(rangeTimer)
      const range = chart.timeScale().getVisibleRange()
      if (range && typeof range.from === 'number' && typeof range.to === 'number') initialRange.current = { from: range.from, to: range.to }
      refs.current = null
      maRefs.current.clear()
      priceLines.current.clear()
      chart.remove()
      tradeMarkers.current = null
    }
  }, [chartType])

  // ── data: host candles (ms) → LWC series (UTC seconds, unique, ascending)
  React.useEffect(() => {
    const markers: SeriesMarker<UTCTimestamp>[] = tradeEvents.filter((event) => event.kind === 'order').map((event) => ({
      time: Math.floor(event.candleTime / 1000) as UTCTimestamp,
      position: event.isBuy ? 'belowBar' : 'aboveBar',
      color: event.kind === 'order' ? '#dda64d' : event.isBuy ? FALLBACK_UP : FALLBACK_DOWN,
      shape: event.kind === 'order' ? 'circle' : event.isBuy ? 'arrowUp' : 'arrowDown',
      text: event.kind === 'order' ? tr('委托', 'Order') : tr('成交', 'Fill'),
    }))
    if (selectedTime != null && candles.some((candle) => candle.t === selectedTime)) markers.push({
      time: Math.floor(selectedTime / 1000) as UTCTimestamp,
      position: 'inBar', color: '#e2a943', shape: 'circle', text: tr('引用', 'Quote'),
    })
    markers.sort((a, b) => Number(a.time) - Number(b.time))
    tradeMarkers.current?.setMarkers(markers)
  }, [tradeEvents, selectedTime, candles, chartType])

  React.useEffect(() => {
    const r = refs.current
    if (!r) return
    const rows = chartBars(candles, chartType)
    if (rows.length < 2) return
    const seen = new Set<number>()
    const bars: Array<{ time: UTCTimestamp; open: number; high: number; low: number; close: number }> = []
    const vols: Array<{ time: UTCTimestamp; value: number; color: string }> = []
    for (const c of rows) {
      const time = Math.floor(c.t / 1000) as UTCTimestamp
      if (seen.has(time)) continue
      seen.add(time)
      const up = c.c >= c.o
      bars.push({ time, open: c.o, high: c.h, low: c.l, close: c.c })
      vols.push({ time, value: c.v, color: up ? FALLBACK_UP : FALLBACK_DOWN })
    }
    if (bars.length < 2) return
    const th = { up: FALLBACK_UP, down: FALLBACK_DOWN }
    const box = boxRef.current
    if (box) {
      th.up = cssVar(box, '--dsw-alias-state-success-primary', FALLBACK_UP)
      th.down = cssVar(box, '--dsw-alias-state-error-primary', FALLBACK_DOWN)
    }
    // Prepending history shifts every logical index; keep the trader's view on the same bars.
    const viewBefore = fitted.current ? r.chart.timeScale().getVisibleLogicalRange() : null
    const prevFirst = firstBarTime.current
    const prepended = prevFirst != null && bars[0].time < prevFirst ? Math.max(0, bars.findIndex((bar) => bar.time >= prevFirst)) : 0
    firstBarTime.current = bars[0].time
    const studySig = JSON.stringify(settings), colorSig = `${chartType}|${th.up}|${th.down}`
    feed(r.candles, chartType === 'line' || chartType === 'area' ? bars.map((bar) => ({ time: bar.time, value: bar.close })) : bars, chartType)
    if (showVolume) feed(r.volume, vols.map((v) => ({ ...v, color: v.color === FALLBACK_UP ? th.up : th.down })), colorSig)
    if (r.volume.options().visible !== showVolume) r.volume.applyOptions({ visible: showVolume })
    // Hidden overlays need neither 5000-point conversions nor series updates
    // on every tick. Enabling one feeds the current data before it is shown.
    for (const [series, key, indicator] of [
      [r.sma, 'sma20', 'sma20'], [r.sma60, 'sma60', 'sma60'],
      [r.ema20, 'ema20', 'ema20'], [r.ema50, 'ema50', 'ema50'],
      [r.basis, 'basis', 'bollinger20'], [r.upper, 'upper', 'bollinger20'], [r.lower, 'lower', 'bollinger20'],
    ] as const) {
      const visible = indicators.has(indicator)
      if (visible) feed(series, chartData(studies[key]), studySig)
      if (series.options().visible !== visible) series.applyOptions({ visible })
    }
    if (indicators.has('vwap')) {
      r.vwap ??= r.chart.addSeries(LineSeries, { color: '#e89a56', lineWidth: 2, lastValueVisible: false, priceLineVisible: false })
      feed(r.vwap, chartData(studies.vwap), studySig)
    } else if (r.vwap) { r.chart.removeSeries(r.vwap); r.vwap = undefined }
    if (indicators.has('atr14')) {
      if (!r.atr) {
        const pane = r.chart.addPane(); pane.setStretchFactor(0.28)
        r.atr = pane.addSeries(LineSeries, { color: '#56bca7', lineWidth: 2, priceLineVisible: false })
      }
      feed(r.atr, chartData(studies.atr14), studySig)
    } else if (r.atr) { r.chart.removeSeries(r.atr); r.atr = undefined }
    if (indicators.has('rsi14')) {
      if (!r.rsi) {
        const pane = r.chart.addPane()
        pane.setStretchFactor(0.28)
        r.rsi = pane.addSeries(LineSeries, { color: '#a788df', lineWidth: 2, priceLineVisible: false, lastValueVisible: true })
        r.rsiBounds = [settings.rsi.lower, settings.rsi.upper].map((price) => r.rsi!.createPriceLine({ price, color: '#8d8d8d', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false }))
      }
      r.rsiBounds?.forEach((line, index) => line.applyOptions({ price: index ? settings.rsi.upper : settings.rsi.lower }))
      feed(r.rsi, chartData(studies.rsi14), studySig)
    } else if (r.rsi) { r.chart.removeSeries(r.rsi); r.rsi = undefined }
    if (indicators.has('macd')) {
      if (!r.macd) {
        const pane = r.chart.addPane()
        pane.setStretchFactor(0.28)
        r.histogram = pane.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false })
        r.macd = pane.addSeries(LineSeries, { color: '#55a6ce', lineWidth: 2, priceLineVisible: false, lastValueVisible: false })
        r.signal = pane.addSeries(LineSeries, { color: '#e2a943', lineWidth: 2, priceLineVisible: false, lastValueVisible: false })
      }
      feed(r.macd, chartData(studies.macd), studySig)
      feed(r.signal!, chartData(studies.signal), studySig)
      feed(r.histogram!, studies.histogram.map((point) => ({ time: point.time as UTCTimestamp, value: point.value, color: point.value >= 0 ? th.up : th.down })), studySig + colorSig)
    } else if (r.macd) {
      r.chart.removeSeries(r.macd); r.chart.removeSeries(r.signal!); r.chart.removeSeries(r.histogram!)
      r.macd = undefined; r.signal = undefined; r.histogram = undefined
    }
    for (const group of [
      { id: 'stochastic' as const, keys: ['stochK', 'stochD'] as const, colors: ['#55a6ce', '#e2a943'] },
      { id: 'adx' as const, keys: ['adx', 'plusDI', 'minusDI'] as const, colors: ['#a788df', '#2fd3a0', '#ef5f6c'] },
      { id: 'obv' as const, keys: ['obv'] as const, colors: ['#56bca7'] },
    ]) {
      if (indicators.has(group.id)) {
        if (!r.extra[group.keys[0]]) {
          const pane = r.chart.addPane(); pane.setStretchFactor(0.28)
          group.keys.forEach((key, index) => { r.extra[key] = pane.addSeries(LineSeries, { color: group.colors[index], lineWidth: 2, priceLineVisible: false, lastValueVisible: false }) })
          if (group.id === 'stochastic') r.stochBounds = [settings.stochastic.lower, settings.stochastic.upper].map((price) => r.extra.stochK.createPriceLine({ price, color: '#8d8d8d', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false }))
          if (group.id === 'adx') r.extra.adx.createPriceLine({ price: 25, color: '#8d8d8d', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false })
        }
        for (const key of group.keys) feed(r.extra[key], chartData(studies[key]), studySig)
        if (group.id === 'stochastic') r.stochBounds?.forEach((line, index) => line.applyOptions({ price: index ? settings.stochastic.upper : settings.stochastic.lower }))
      } else for (const key of group.keys) { if (r.extra[key]) { r.chart.removeSeries(r.extra[key]); delete r.extra[key] } }
    }
    if (viewBefore && prepended > 0) {
      restoring.current = true
      r.chart.timeScale().setVisibleLogicalRange({ from: viewBefore.from + prepended, to: viewBefore.to + prepended })
      setTimeout(() => { restoring.current = false }, 100)
    }
    // Configurable MAs: one line series per definition (+ a dashed one for its smoothing).
    const live = new Set(maComputed.map((item) => item.line.id))
    for (const [id, entry] of maRefs.current) {
      if (live.has(id)) continue
      r.chart.removeSeries(entry.main); if (entry.smooth) r.chart.removeSeries(entry.smooth)
      maRefs.current.delete(id)
    }
    const toPoints = (values: Array<number | null>) => {
      const seenMa = new Set<number>(); const out: Array<{ time: UTCTimestamp; value: number }> = []
      values.forEach((value, index) => {
        const time = Math.floor(candles[index].t / 1000)
        if (value == null || seenMa.has(time)) return
        seenMa.add(time); out.push({ time: time as UTCTimestamp, value })
      })
      return out
    }
    for (const item of maComputed) {
      let entry = maRefs.current.get(item.line.id)
      if (!entry) {
        entry = { main: r.chart.addSeries(LineSeries, { lineWidth: 2, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false }) }
        maRefs.current.set(item.line.id, entry)
      }
      entry.main.applyOptions({ color: item.color })
      feed(entry.main, toPoints(item.values), JSON.stringify(item.line))
      if (item.smoothed) {
        entry.smooth ??= r.chart.addSeries(LineSeries, { lineWidth: 1, lineStyle: LineStyle.Dashed, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false })
        entry.smooth.applyOptions({ color: item.color })
        feed(entry.smooth, toPoints(item.smoothed), JSON.stringify(item.line))
      } else if (entry.smooth) { r.chart.removeSeries(entry.smooth); entry.smooth = undefined }
    }
    // A live candle must not reset a trader's manual zoom or pan.
    if (!fitted.current) {
      restoring.current = true
      r.chart.timeScale().fitContent()
      // A linked chart that receives the shared range before its first data must open on that range,
      // not on fit-content (which would undo the link and be saved as this chart's viewport).
      const linked = linkRef.current?.range && linkRef.current.range.source !== linkRef.current.id ? linkRef.current.range : null
      const saved = linked ?? initialRange.current
      if (saved && saved.from < saved.to) {
        try { r.chart.timeScale().setVisibleRange({ from: saved.from as UTCTimestamp, to: saved.to as UTCTimestamp }) }
        catch { /* historical range may no longer overlap loaded candles */ }
      }
      fitted.current = true
      setTimeout(() => { restoring.current = false }, 100)
    }
    // Tail updates can change auto-scale and data-derived drawings without a
    // time-range event. Project after LWC has painted the new data.
    const overlayFrame = requestAnimationFrame(() => {
      const box = boxRef.current
      if (box && readProjection(r, box).some((value, index) => value !== projectionStamp.current[index])) React.startTransition(() => setViewportVersion((value) => value + 1))
    })
    return () => cancelAnimationFrame(overlayFrame)
  }, [candles, studies, indicators, showVolume, maComputed, chartType, settings])

  // A reopened quote chip: page in history until the candle exists, then center and mark it.
  React.useEffect(() => {
    const r = refs.current
    if (!r || !focus || focus.at === handledFocus.current || candles.length < 2) return
    if (focus.t < candles[0].t) {
      if (olderState === 'done' || olderState === 'error') handledFocus.current = focus.at
      else if (olderState === 'idle') onNeedOlderRef.current()
      return
    }
    let index = candleIndex(candles, focus.t)
    if (index > 0 && candles[index].t > focus.t) index--
    if (index < 0) return
    handledFocus.current = focus.at
    const view = r.chart.timeScale().getVisibleLogicalRange()
    const half = view ? (view.to - view.from) / 2 : 40
    restoring.current = true
    r.chart.timeScale().setVisibleLogicalRange({ from: index - half, to: index + half })
    setTimeout(() => { restoring.current = false }, 100)
    setSelectedTime(candles[index].t)
  }, [focus, candles, olderState])

  React.useEffect(() => {
    refs.current?.chart.priceScale('right').applyOptions({ mode: priceScale === 'log' ? PriceScaleMode.Logarithmic : priceScale === 'percentage' ? PriceScaleMode.Percentage : PriceScaleMode.Normal })
    setViewportVersion((value) => value + 1)
  }, [priceScale, chartType])

  React.useEffect(() => {
    const r = refs.current, box = boxRef.current
    if (!command || command.at === handledCommand.current || !r || !box || candles.length < 2) return
    const last = candles.at(-1)!
    if (command.kind === 'snapshot') {
      handledCommand.current = command.at
      void chartImage(r.chart, box, caption).then((blob) => downloadBlob(blob, `${caption.replace(/[^a-zA-Z0-9_-]/g, '_')}.png`))
        .catch(() => notify(tr('图表图片导出失败，请重试', 'Chart image export failed; please retry')))
      return
    }
    if (command.kind === 'live') {
      r.chart.priceScale('right').applyOptions({ autoScale: true })
      r.chart.timeScale().scrollToPosition(0, false)
    } else if (command.kind === 'fit') r.chart.timeScale().fitContent()
    else {
      const target = command.kind === 'date' ? command.time : last.t - command.duration
      if (target > Date.now()) { handledCommand.current = command.at; notify(tr('请选择已发生的日期', 'Choose a past date')); return }
      if (target < candles[0].t && olderState !== 'done' && olderState !== 'error') {
        if (olderState === 'idle') onNeedOlderRef.current()
        return
      }
      if (target < candles[0].t) notify(olderState === 'error'
        ? tr('历史加载失败，仅显示已加载的数据；可重新定位重试', 'History load failed; showing loaded data. Select the date again to retry.')
        : tr('已到可用历史边界，显示最早可用的数据', 'History limit reached; showing the earliest available data'))
      const index = candleIndex(candles, target)
      if (command.kind === 'date') {
        const view = r.chart.timeScale().getVisibleLogicalRange()
        const half = Math.max(15, view ? (view.to - view.from) / 2 : 40)
        r.chart.timeScale().setVisibleLogicalRange({ from: index - half, to: index + half })
      } else r.chart.timeScale().setVisibleLogicalRange({ from: index, to: candles.length - 1 + 3 })
    }
    handledCommand.current = command.at
    // LWC applies a target range in its render frame, not in setVisibleLogicalRange.
    // Prepending also suspends range events: read AFTER rendering to save the new
    // range rather than re-saving the viewport from before this navigation.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (refs.current !== r || handledCommand.current !== command.at) return
      const range = r.chart.timeScale().getVisibleRange()
      if (range && typeof range.from === 'number' && typeof range.to === 'number') onRangeRef.current({ from: range.from, to: range.to })
    }))
    setViewportVersion((value) => value + 1)
  }, [command, candles, olderState, caption])

  React.useEffect(() => {
    const r = refs.current, cursor = link?.cursor
    if (!r || !cursor || cursor.source === link?.id) return
    syncingCursor.current = true
    try {
      if (cursor.time == null || !candles.length || cursor.time < candles[0].t || cursor.time >= candles[candles.length - 1].t + (candles.length > 1 ? candles[1].t - candles[0].t : 60_000)) { r.chart.clearCrosshairPosition(); setCrosshair(null); return }
      let lo = 0, hi = candles.length - 1
      while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (candles[mid].t <= cursor.time) lo = mid; else hi = mid - 1 }
      const candle = candles[lo]
      r.chart.setCrosshairPosition(candle.c, Math.floor(candle.t / 1000) as UTCTimestamp, r.candles)
      setCrosshair(candle)
    } finally { syncingCursor.current = false }
  }, [link?.cursor, candles, chartType])
  const handledLinkRange = React.useRef('')
  React.useEffect(() => {
    const r = refs.current, range = link?.range
    if (!r || !range || range.source === link?.id || candles.length < 2 || handledLinkRange.current === `${range.at}:${chartType}`) return
    if (range.from * 1000 < candles[0].t && olderState === 'idle') { onNeedOlderRef.current(); return }
    handledLinkRange.current = `${range.at}:${chartType}`
    externalRangeUntil.current = performance.now() + 900
    restoring.current = true
    // Fractional logical positions keep a coarse linked chart (e.g. 4h showing ~8 bars) within one bar of the
    // source; setVisibleRange snaps both ends to whole bars and can drift by two.
    const line = timelineRef.current
    r.chart.timeScale().setVisibleLogicalRange({ from: line.toLogical(range.from * 1000), to: line.toLogical(range.to * 1000) })
    const actual = r.chart.timeScale().getVisibleRange()
    if (actual && typeof actual.from === 'number' && typeof actual.to === 'number') onRangeRef.current({ from: actual.from, to: actual.to })
    const timer = setTimeout(() => { restoring.current = false }, 120)
    return () => { clearTimeout(timer); restoring.current = false }
  }, [link?.range, candles, olderState, chartType])

  React.useEffect(() => { pending.current = []; setPendingPoints([]); setDrawingHover(null) }, [drawMode])
  /** Commits a path / polyline from its clicks so far (needs two). */
  const finishMulti = () => {
    const mode = drawModeRef.current
    const points = pending.current
    pending.current = []; setPendingPoints([])
    if (mode && isMultiKind(mode) && points.length >= 2) onDrawRef.current({ kind: mode as Exclude<DrawingKind, 'level' | 'trend'>, points })
  }
  const finishMultiRef = React.useRef(finishMulti)
  finishMultiRef.current = finishMulti
  React.useEffect(() => {
    if (!drawMode || !isMultiKind(drawMode)) return undefined
    const onKey = (event: KeyboardEvent) => {
      const element = event.target as HTMLElement | null
      if (event.key !== 'Enter' || element?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(element?.tagName ?? '')) return
      event.preventDefault(); finishMultiRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [drawMode])

  React.useEffect(() => {
    if (resetToken > 0) refs.current?.chart.timeScale().fitContent()
  }, [resetToken])

  React.useEffect(() => {
    const r = refs.current
    const box = boxRef.current
    if (!r || !box) return
    for (const line of priceLines.current.values()) r.candles.removePriceLine(line)
    priceLines.current.clear()
    const colorOf = (mark: ChartMark) => mark.color ?? (mark.source === 'user' ? DRAW_COLOR : mark.role === 'support'
      ? cssVar(box, '--dsw-alias-state-success-primary', FALLBACK_UP)
      : mark.role === 'resistance'
        ? cssVar(box, '--dsw-alias-state-error-primary', FALLBACK_DOWN)
        : DRAW_COLOR)
    const styleOf = (mark: ChartMark) => mark.lineStyle === 'dotted' ? LineStyle.Dotted : mark.lineStyle === 'dashed' || (!mark.lineStyle && mark.source !== 'user') ? LineStyle.Dashed : LineStyle.Solid
    // Levels keep an axis price label; every other drawing is projected by the SVG overlay.
    for (const mark of marks) {
      if (mark.kind !== 'level' || mark.hidden || !Number.isFinite(mark.price) || Number(mark.price) <= 0) continue
      // Limited to other intervals: no axis line or price label here either.
      if (interval && mark.visibleIntervals?.length && !mark.visibleIntervals.includes(interval)) continue
      priceLines.current.set(mark.id, r.candles.createPriceLine({ price: Number(mark.price), color: colorOf(mark),
        lineWidth: (mark.lineWidth ?? (mark.source === 'user' ? 2 : 1)) as 1 | 2 | 3 | 4, lineStyle: styleOf(mark),
        axisLabelVisible: true, title: mark.label }))
    }
    ;(window as unknown as { __dhlPriceLines?: () => number }).__dhlPriceLines = () => priceLines.current.size
  }, [marks, themeVersion, chartType, interval])

  const warming = candles.length < 2

  /** The floating toolbar sits at the top; it moves to the bottom when it would cover the selected drawing's anchors. */
  const toolbarPlacement = (mark: ChartMark): 'top' | 'bottom' => {
    if (!view) return 'top'
    const ys = markPoints(mark).map((point) => view.project(point.time, point.price)?.y).filter((y): y is number => y != null)
    // Anchors under each position; take the side that covers fewer (top on a tie).
    const top = ys.filter((y) => y < TOOLBAR_CLEARANCE).length, bottom = ys.filter((y) => y > view.height - TOOLBAR_CLEARANCE).length
    return bottom < top ? 'bottom' : 'top'
  }

  // ── drawings: projection, selection and direct manipulation ─────────
  const markById = React.useMemo(() => new Map(marks.map((mark) => [mark.id, mark])), [marks])
  const markByIdRef = React.useRef(markById)
  markByIdRef.current = markById
  const lockedRef = React.useRef(drawingsLocked)
  lockedRef.current = drawingsLocked
  const onEditRef = React.useRef(onEditMark)
  onEditRef.current = onEditMark
  const onRemoveRef = React.useRef(onRemoveMark)
  onRemoveRef.current = onRemoveMark
  const onRemoveMarksRef = React.useRef(onRemoveMarks)
  onRemoveMarksRef.current = onRemoveMarks
  const onEditEachRef = React.useRef(onEditEach)
  onEditEachRef.current = onEditEach
  const shapes = React.useMemo(() => marks.filter((mark) => !mark.hidden).map((mark) => ({ mark, points: markPoints(mark) })), [marks])
  const lastTime = candles.at(-1)?.t ?? Date.now()
  // Recomputed on viewport/scale changes and new candles, not on crosshair moves.
  const view = React.useMemo<Projector | null>(() => {
    const chartApi = refs.current, box = boxRef.current
    if (!chartApi || !box) return null
    const stamp = readProjection(chartApi, box)
    projectionStamp.current = stamp
    const [x0, x1, y0, y1] = stamp
    const base = candlesRef.current[0]?.c ?? 1
    const ys = new Map<number, number | null>()
    return {
      project: (time, price) => {
        const x = x0 == null || x1 == null ? null : x0 + (x1 - x0) * timeline.toLogical(time)
        if (!ys.has(price)) ys.set(price, priceScale === 'log' ? chartApi.candles.priceToCoordinate(price)
          : y0 == null || y1 == null ? null : y0 + (y1 - y0) * (price - base) / (base * .01))
        const y = ys.get(price)
        return x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y) ? null : { x, y }
      },
      width: Math.max(0, box.clientWidth - chartApi.chart.priceScale('right').width()),
      height: chartApi.chart.panes()[0]?.getHeight() ?? box.clientHeight,
      bars: (from, to) => timeline.toLogical(to) - timeline.toLogical(from),
      closes: (from, to) => candlesIn(candlesRef.current, from, to).map((candle) => ({ time: candle.t, price: candle.c })),
      candles: (from, to) => candlesIn(candlesRef.current, from, to).map((candle) => ({ time: candle.t, open: candle.o, high: candle.h, low: candle.l, close: candle.c, volume: candle.v })),
      profile: (from, to, options) => cachedProfile(candlesRef.current, from, to, options),
      firstTime: candlesRef.current[0]?.t,
      barMs: candlesRef.current.length > 1 ? candlesRef.current[1].t - candlesRef.current[0].t : undefined,
    }
  }, [viewportVersion, timeline, themeVersion, expanded, indicators, priceScale])
  const viewRef = React.useRef(view)
  viewRef.current = view
  /** Pinning converts between a screen spot (fractions of the plot) and the time / price under it. */
  const pinPatch = (mark: ChartMark): Record<string, unknown> | null => {
    const v = viewRef.current, api = refs.current
    if (!v || !api || !v.width || !v.height) return null
    if (mark.screenX != null && mark.screenY != null) {
      const logical = api.chart.timeScale().coordinateToLogical(mark.screenX * v.width)
      const price = Number(api.candles.coordinateToPrice(mark.screenY * v.height))
      if (logical == null || !Number.isFinite(price) || price <= 0) return { screenX: null, screenY: null }
      return { screenX: null, screenY: null, points: [{ time: timelineRef.current.toTime(Number(logical)), price }] }
    }
    const at = v.project(markPoints(mark)[0].time, markPoints(mark)[0].price)
    return at ? { screenX: Math.min(1, Math.max(0, at.x / v.width)), screenY: Math.min(1, Math.max(0, at.y / v.height)) } : null
  }

  React.useEffect(() => { if (selectedId && !markById.has(selectedId)) setSelectedId(null) }, [markById, selectedId])
  // A drawing limited to other intervals is not drawn here, so it cannot stay selected either.
  React.useEffect(() => {
    const hiddenHere = (id: string) => { const limit = markById.get(id)?.visibleIntervals; return Boolean(interval && limit?.length && !limit.includes(interval)) }
    if (selectedId && hiddenHere(selectedId)) setSelectedId(null)
    setGroup((current) => { const next = current.filter((id) => !hiddenHere(id)); return next.length === current.length ? current : next })
  }, [interval, markById, selectedId])
  React.useEffect(() => { if (drawMode) setSelectedId(null) }, [drawMode])
  // Dragging a level moves its axis price label with it.
  React.useEffect(() => {
    if (!draft) return
    const mark = markById.get(draft.id)
    if (mark?.kind === 'level') priceLines.current.get(draft.id)?.applyOptions({ price: draft.points[0].price })
  }, [draft, markById])
  React.useEffect(() => { setGroup((current) => { const next = current.filter((id) => markById.has(id)); return next.length === current.length ? current : next }) }, [markById])
  React.useEffect(() => { if (drawMode) setGroup([]) }, [drawMode])
  React.useEffect(() => {
    if (group.length < 2) return undefined
    const onKey = (event: KeyboardEvent) => {
      const element = event.target as HTMLElement | null
      if (element?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(element?.tagName ?? '')) return
      if (event.key === 'Escape') { event.preventDefault(); setGroup([]); return }
      if (event.key !== 'Delete' && event.key !== 'Backspace') return
      if (lockedRef.current) return
      event.preventDefault()
      const ids = groupRef.current.filter((id) => !markByIdRef.current.get(id)?.locked)
      if (ids.length) onRemoveMarksRef.current?.(ids)
      setGroup([])
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [group.length])
  React.useEffect(() => {
    if (!selectedId) return undefined
    const onKey = (event: KeyboardEvent) => {
      const element = event.target as HTMLElement | null
      if (element?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(element?.tagName ?? '')) return
      if (event.key === 'Escape') { event.preventDefault(); setSelectedId(null); return }
      if (event.key !== 'Delete' && event.key !== 'Backspace') return
      const mark = markByIdRef.current.get(selectedId)
      if (!mark || mark.locked || lockedRef.current) return
      event.preventDefault()
      onRemoveRef.current(selectedId)
      setSelectedId(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [selectedId])

  /** Ends the pointer gesture in progress without committing it (pointercancel, Esc, unmount). */
  const abortGesture = React.useRef<(() => void) | null>(null)
  React.useEffect(() => () => abortGesture.current?.(), [])
  const [brushPoints, setBrushPoints] = React.useState<DrawPoint[]>([])
  /** Live position of a screen-pinned drawing while it is dragged. */
  const [screenDraft, setScreenDraft] = React.useState<{ id: string; x: number; y: number } | null>(null)
  /** Freehand: the overlay captures the pointer (so the chart does not pan) and samples every ~4px. */
  const beginBrush = (event: React.PointerEvent<SVGSVGElement>, freehandKind: DrawingKind) => {
    const snap = snapRef.current
    const first = snap?.(event.nativeEvent, undefined, false)
    if (!snap || !first) return
    event.preventDefault(); event.stopPropagation()
    const collected = [first]
    let lastXY = { x: event.clientX, y: event.clientY }, frame = 0
    setBrushPoints(collected)
    const move = (ev: PointerEvent) => {
      if (Math.hypot(ev.clientX - lastXY.x, ev.clientY - lastXY.y) < 4) return
      const point = snap(ev, undefined, false)
      if (!point) return
      lastXY = { x: ev.clientX, y: ev.clientY }
      collected.push(point)
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setBrushPoints([...collected]))
    }
    const detach = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel); window.removeEventListener('keydown', onKey, true)
      cancelAnimationFrame(frame)
      setBrushPoints([])
      abortGesture.current = null
    }
    const cancel = () => detach()
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.stopPropagation(); detach() } }
    const up = () => {
      detach()
      if (collected.length < 2) return
      const stride = Math.ceil(collected.length / BRUSH_MAX)
      const points = collected.filter((_, index) => index % stride === 0 || index === collected.length - 1).slice(-BRUSH_MAX)
      onDrawRef.current({ kind: freehandKind as Exclude<DrawingKind, 'level' | 'trend'>, points })
    }
    abortGesture.current?.()
    abortGesture.current = cancel
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancel); window.addEventListener('keydown', onKey, true)
  }

  /** A copy shifted 5 bars right, with the same style and label. */
  const cloneOf = React.useCallback((mark: ChartMark): ClonePayload => {
    const line = timelineRef.current
    const shifted = markPoints(mark).map((point) => ({ time: line.toTime(line.toLogical(point.time) + 5), price: point.price }))
    // Tool settings (fib levels, volume profile rows / value area) travel with the copy.
    const style = Object.fromEntries(Object.entries({ color: mark.color, lineWidth: mark.lineWidth, lineStyle: mark.lineStyle, levels: mark.levels, rows: mark.rows, valueArea: mark.valueArea, fontSize: mark.fontSize, bold: mark.bold, italic: mark.italic, extendLeft: mark.extendLeft, extendRight: mark.extendRight, fillOpacity: mark.fillOpacity, visibleIntervals: mark.visibleIntervals }).filter(([, value]) => value != null))
    return { kind: mark.kind, geometry: geometryPatch(mark.kind, shifted), style, label: mark.label }
  }, [])
  const clipboard = React.useRef<ChartMark | null>(null)
  const onCloneRef = React.useRef(onCloneMark)
  onCloneRef.current = onCloneMark
  // Ctrl/Cmd+C copies the selected drawing; Ctrl/Cmd+V pastes a shifted copy (TradingView-style).
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      const element = event.target as HTMLElement | null
      if (element?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(element?.tagName ?? '')) return
      const key = event.key.toLowerCase()
      if (key === 'c' && selectedRef.current) { clipboard.current = markByIdRef.current.get(selectedRef.current) ?? null; if (clipboard.current) event.preventDefault() }
      if (key === 'v' && clipboard.current) {
        event.preventDefault()
        const copy = cloneOf(clipboard.current)
        onCloneRef.current(copy)
        clipboard.current = { ...clipboard.current, ...(copy.geometry as object) } as ChartMark
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cloneOf])
  const handledSelect = React.useRef(0)
  React.useEffect(() => {
    const r = refs.current
    if (!selectRequest || selectRequest.at === handledSelect.current || !r) return
    const mark = markById.get(selectRequest.id)
    if (!mark) return
    handledSelect.current = selectRequest.at
    setSelectedId(mark.id)
    const first = mark.kind === 'level' ? null : markPoints(mark)[0]
    if (first) {
      const view = r.chart.timeScale().getVisibleLogicalRange()
      const half = view ? (view.to - view.from) / 2 : 40
      const center = timeline.toLogical(first.time)
      restoring.current = true
      r.chart.timeScale().setVisibleLogicalRange({ from: center - half, to: center + half })
      setTimeout(() => { restoring.current = false }, 100)
    }
  }, [selectRequest, markById, timeline])

  /** Press on a drawing: select it; drag a handle to reshape or the body to move. Saved once on release. */
  const beginDrag = React.useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    if (drawModeRef.current && (FREEHAND_KINDS as string[]).includes(drawModeRef.current) && event.button === 0) { beginBrush(event, drawModeRef.current); return }
    if (drawModeRef.current || event.button !== 0) return
    const target = event.target as Element
    const fillId = target.closest('[data-fill-id]')?.getAttribute('data-fill-id')
    if (fillId) { event.preventDefault(); event.stopPropagation(); setSelectedId(null); setSelectedFill((current) => current === fillId ? null : fillId); return }
    const id = target.closest('[data-mark-id]')?.getAttribute('data-mark-id')
    const mark = id ? markByIdRef.current.get(id) : undefined
    if (!id || !mark) return
    event.preventDefault()
    event.stopPropagation()
    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      const base = groupRef.current.length ? groupRef.current : selectedRef.current ? [selectedRef.current] : []
      const next = base.includes(id) ? base.filter((item) => item !== id) : [...base, id]
      if (next.length >= 2) { setGroup(next); setSelectedId(null) } else { setGroup([]); setSelectedId(next[0] ?? null) }
      return
    }
    const anchorHit = target.getAttribute('data-anchor') != null
    if (groupRef.current.includes(id) && groupRef.current.length >= 2 && !anchorHit) {
      // Drag the whole group by one time/price offset; locked members and drawings pinned to the screen stay put.
      const snapGroup = snapRef.current
      if (lockedRef.current || !snapGroup) return
      const startGroup = snapGroup(event.nativeEvent, undefined, false)
      if (!startGroup) return
      const line = timelineRef.current, startLogical = line.toLogical(startGroup.time)
      const originals = new Map(groupRef.current.map((member) => markByIdRef.current.get(member)).filter((item): item is ChartMark => Boolean(item) && !item!.locked && item!.screenX == null).map((item) => [item.id, item] as const))
      const origin = { x: event.clientX, y: event.clientY }
      let moved = false, frame = 0, latest: Map<string, DrawPoint[]> | null = null
      const compute = (ev: PointerEvent) => {
        const point = snapGroup(ev, undefined, false)
        if (!point) return
        const shift = Math.round(line.toLogical(point.time) - startLogical), delta = point.price - startGroup.price
        const next = new Map<string, DrawPoint[]>()
        for (const [memberId, member] of originals) {
          const moved = markPoints(member).map((item) => ({ time: line.toTime(line.toLogical(item.time) + shift), price: item.price + delta }))
          if (moved.some((item) => item.price <= 0)) return
          next.set(memberId, moved)
        }
        latest = next; setGroupDraft(next)
        for (const [memberId, member] of originals) if (member.kind === 'level') priceLines.current.get(memberId)?.applyOptions({ price: next.get(memberId)![0].price })
      }
      const move = (ev: PointerEvent) => {
        if (!moved && Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y) < 3) return
        moved = true
        cancelAnimationFrame(frame)
        frame = requestAnimationFrame(() => compute(ev))
      }
      const detach = () => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel); window.removeEventListener('keydown', onKey, true)
        cancelAnimationFrame(frame); abortGesture.current = null
      }
      const cancel = () => {
        detach()
        for (const [memberId, member] of originals) if (member.kind === 'level') priceLines.current.get(memberId)?.applyOptions({ price: Number(member.price) })
        setGroupDraft(null)
      }
      const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape' && moved) { ev.stopPropagation(); cancel() } }
      const up = (ev: PointerEvent) => {
        detach()
        if (moved) compute(ev)
        const final = latest
        if (moved && final) onEditEachRef.current?.([...final].map(([memberId, points]) => [memberId, geometryPatch(originals.get(memberId)!.kind, points)]))
        setGroupDraft(null)
      }
      abortGesture.current?.()
      abortGesture.current = cancel
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancel); window.addEventListener('keydown', onKey, true)
      return
    }
    setGroup([])
    setSelectedId(id)
    const snap = snapRef.current
    if (mark.locked || lockedRef.current || !snap) return
    if (mark.screenX != null && mark.screenY != null) {
      // Pinned to the screen: dragging moves its spot on the plot, not its time / price.
      const v = viewRef.current
      if (!v || !v.width || !v.height) return
      event.preventDefault(); event.stopPropagation()
      const origin = { x: event.clientX, y: event.clientY }, sx = mark.screenX, sy = mark.screenY
      let latest: { id: string; x: number; y: number } | null = null
      const move = (ev: PointerEvent) => {
        latest = { id, x: Math.min(1, Math.max(0, sx + (ev.clientX - origin.x) / v.width)), y: Math.min(1, Math.max(0, sy + (ev.clientY - origin.y) / v.height)) }
        setScreenDraft(latest)
      }
      const detach = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel); abortGesture.current = null }
      const cancel = () => { detach(); setScreenDraft(null) }
      const up = (ev: PointerEvent) => {
        detach()
        if (latest && Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y) >= 3) onEditRef.current(id, { screenX: latest.x, screenY: latest.y })
        setScreenDraft(null)
      }
      abortGesture.current?.(); abortGesture.current = cancel
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancel)
      return
    }
    const anchorAttr = target.getAttribute('data-anchor')
    const anchor = anchorAttr == null ? null : Number(anchorAttr)
    const startPoint = snap(event.nativeEvent, undefined, false)
    if (!startPoint) return
    const line = timelineRef.current
    const startLogical = line.toLogical(startPoint.time)
    const original = markPoints(mark)
    const origin = { x: event.clientX, y: event.clientY }
    let moved = false, frame = 0, last: PointerEvent | null = null, latest: DrawPoint[] | null = null
    const compute = (ev: PointerEvent) => {
      let next: DrawPoint[] | null
      if (anchor != null) {
        // Shift constrains relative to the neighbouring anchor in drawing order (as when it was drawn).
        const point = snap(ev, original[anchor === 0 ? 1 : anchor - 1])
        if (!point) return
        next = original.map((item) => ({ ...item }))
        if (mark.kind === 'level') next[0] = { ...next[0], price: point.price }
        else if (mark.kind === 'vline') next[0] = { time: point.time, price: next[0].price }
        else if ((mark.kind === 'long' || mark.kind === 'short') && anchor > 0) {
          next[anchor] = point
          next[1] = { ...next[1], time: point.time }; next[2] = { ...next[2], time: point.time }
        } else next[anchor] = point
        next = constrainPoints(mark.kind, next)
      } else {
        const point = snap(ev, undefined, false)
        if (!point) return
        const shift = Math.round(line.toLogical(point.time) - startLogical), delta = point.price - startPoint.price
        next = original.map((item) => ({ time: line.toTime(line.toLogical(item.time) + shift), price: item.price + delta }))
        if (next.some((item) => item.price <= 0)) next = null
      }
      if (next) { latest = next; setDraft({ id, points: next }) }
    }
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y) < 3) return
      moved = true
      last = ev
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => compute(ev))
    }
    const detach = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', onKey, true)
      cancelAnimationFrame(frame)
      abortGesture.current = null
    }
    // A cancelled gesture (system, Esc, unmount) puts the drawing back where it was.
    const cancel = () => {
      detach()
      // The native axis label followed the drag; put it back with the drawing.
      if (mark.kind === 'level') priceLines.current.get(id)?.applyOptions({ price: original[0].price })
      setDraft(null)
    }
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape' && moved) { ev.stopPropagation(); cancel() } }
    const up = () => {
      detach()
      if (moved && last) compute(last)
      if (moved && latest) onEditRef.current(id, geometryPatch(mark.kind, latest))
      setDraft(null)
    }
    abortGesture.current?.()
    abortGesture.current = cancel
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', onKey, true)
  }, [])

  const fills = React.useMemo(() => tradeEvents.filter((event) => event.kind === 'fill'), [tradeEvents])
  const fillCard = selectedFill ? fills.find((event) => event.id === selectedFill) ?? null : null
  React.useEffect(() => { if (selectedFill && !fills.some((event) => event.id === selectedFill)) setSelectedFill(null) }, [fills, selectedFill])
  React.useEffect(() => {
    if (!selectedFill) return undefined
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setSelectedFill(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedFill])
  const fillAt = fillCard && view ? view.project(fillCard.time, fillCard.px) : null

  const previewPoints = drawMode && drawingHover ? [...pendingPoints, drawingHover] : pendingPoints
  const roleClass = (mark: ChartMark) => mark.source === 'user' ? 'role-user' : `role-${mark.role}`
  const selectedMark = selectedId ? markById.get(selectedId) ?? null : null
  const editingMark = editingId ? markById.get(editingId) ?? null : null
  const inspected = crosshair ?? candles.at(-1)
  const inspectedTime = inspected ? Math.floor(inspected.t / 1000) : null
  const studyAt = (key: keyof typeof studies) => studies[key].find((point) => point.time === inspectedTime)?.value
  const inspectedStudies = studyDefinitions(settings).filter(([id]) => indicators.has(id as IndicatorId)).map(([, key, label]) => [label, studyAt(key)] as const)
  const paneCount = ['rsi14', 'macd', 'atr14', 'stochastic', 'adx', 'obv'].filter((id) => indicators.has(id as IndicatorId)).length

  return (
    <>
    <div className="dhl-chartbox" ref={boxRef} style={{ height: expanded && !compact ? undefined : (compact ? 310 : CHART_HEIGHT) + paneCount * (compact ? 65 : 125) }}>
      {view ? <svg className={'dhl-chart-drawing-overlay' + (drawMode ? ' drawing' : '') + (drawMode && (FREEHAND_KINDS as string[]).includes(drawMode) ? ' brushing' : '')} aria-hidden="true" onPointerDown={beginDrag}>
        <defs>
          <clipPath id={clipId.current}><rect x="0" y="0" width={view.width} height={view.height} /></clipPath>
          <marker id={`${clipId.current}-arrow`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" fill="currentColor" /></marker>
        </defs>
        <g clipPath={`url(#${clipId.current})`}>
          {shapes.map(({ mark, points }) => {
            const live = draft?.id === mark.id ? draft.points : groupDraft?.get(mark.id) ?? points
            const screen = screenDraft?.id === mark.id ? screenDraft : mark.screenX != null && mark.screenY != null ? { x: mark.screenX, y: mark.screenY } : null
            const shown = mark.kind === 'level' ? [{ time: lastTime, price: live[0].price }] : live
            const selected = selectedId === mark.id || group.includes(mark.id)
            if (interval && mark.visibleIntervals?.length && !mark.visibleIntervals.includes(interval)) return null
            // Off-screen culling: a bounded drawing entirely left or right of the plot renders nothing.
            // Kept: drawings whose label or alert / shared badge is clamped into the plot even when the anchors are not.
            const clampedDecoration = !(mark.source === 'user' || mark.kind === 'level') || Boolean(mark.alert) || Boolean(mark.shared)
            if (!selected && !clampedDecoration && !mark.extendLeft && !mark.extendRight && FINITE_KINDS.has(mark.kind) && offscreen(shown, view)) return null
            return <DrawingShape key={mark.id} id={mark.id} kind={mark.kind} points={shown} view={view} text={mark.label}
              dataVersion={mark.kind === 'vprofile' || mark.kind === 'regression' || mark.kind === 'avwap' || mark.kind === 'avprofile' || mark.kind === 'barspattern' || mark.kind === 'ghostfeed' ? candles : undefined}
              className={`dhl-drawing ${roleClass(mark)}${mark.kind === 'level' ? ' is-level' : ''}${selected ? ' selected' : ''}${mark.locked || drawingsLocked ? ' locked' : ''}`}
              label={mark.source === 'user' || mark.kind === 'level' ? undefined : mark.label} anchors={selected} interactive={!drawMode}
              color={mark.color} lineWidth={mark.lineWidth} lineStyle={mark.lineStyle} alert={mark.alert} shared={mark.shared} rows={mark.rows} valueArea={mark.valueArea} levels={mark.levels} fontSize={mark.fontSize} bold={mark.bold} italic={mark.italic} fillOpacity={mark.fillOpacity} extendLeft={mark.extendLeft} extendRight={mark.extendRight} screenX={screen?.x} screenY={screen?.y} />
          })}
          <g className="dhl-fills">
            {fills.map((event) => {
              const point = view.project(event.time, event.px)
              if (!point) return null
              const short = event.reason.length > 18 ? event.reason.slice(0, 17) + '…' : event.reason
              return <g key={event.id} className={`dhl-fill ${event.isBuy ? 'buy' : 'sell'}${event.reason ? ' has-reason' : ''}${selectedFill === event.id ? ' selected' : ''}`} data-fill-id={event.id}>
                {event.reason ? <circle className="dhl-fill-ring" cx={point.x} cy={point.y} r="9" /> : null}
                <circle className="dhl-fill-dot" cx={point.x} cy={point.y} r="5" />
                {showReasons && short ? <text className="dhl-fill-reason" x={point.x + 12} y={point.y + 4}>{short}</text> : null}
              </g>
            })}
          </g>
          {brushPoints.length > 1 ? <DrawingShape kind={drawMode === 'highlighter' ? 'highlighter' : 'brush'} points={brushPoints} view={view} className="dhl-drawing dhl-drawing-preview role-user" /> : null}
          {drawMode && drawingHover && hoverSnapped ? (() => { const at = view.project(drawingHover.time, drawingHover.price); return at ? <circle className="dhl-snap-ring" cx={at.x} cy={at.y} r="6" /> : null })() : null}
          {drawMode && !(FREEHAND_KINDS as string[]).includes(drawMode) && previewPoints.length ? <DrawingShape kind={drawMode} points={completePreview(drawMode, previewPoints)} view={view} className="dhl-drawing dhl-drawing-preview role-user" anchors /> : null}
        </g>
      </svg> : null}
      {fillCard && fillAt && view ? <div className="dhl-fill-card" role="dialog" aria-label={tr('成交详情', 'Fill details')}
        style={{ left: Math.max(8, Math.min(fillAt.x + 14, view.width - 300)), top: Math.max(8, Math.min(fillAt.y - 20, view.height - 190)) }}
        onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
        <header>
          <b className={fillCard.isBuy ? 'dhl-up' : 'dhl-down'}>{fillCard.isBuy ? tr('买入', 'Buy') : tr('卖出', 'Sell')} {Number.isFinite(fillCard.sz) ? fillCard.sz : '—'} {fillCard.coin} @ {fmtPrice(fillCard.px)}</b>
          <button type="button" aria-label={tr('关闭', 'Close')} onClick={() => setSelectedFill(null)}><UiIcon name="close" size={14} /></button>
        </header>
        <time>{new Date(fillCard.time).toLocaleString(tr('zh-CN', 'en-US'), { hour12: false })}</time>
        <strong>{tr('AI 交易决策原因', 'AI decision rationale')}</strong>
        {fillCard.reason ? <p>{fillCard.reason}</p> : <p className="muted">{tr('这笔成交没有记录原因（旧订单，或在其他客户端下单）。', 'No rationale recorded (older order or placed elsewhere).')}</p>}
        <footer>
          <button type="button" className="dhl-fill-analyze" onClick={() => { onAnalyzeFill(fillCard); setSelectedFill(null) }}>{fillCard.sessionId ? tr('回到决策会话分析', 'Analyze in its session') : tr('在当前会话分析', 'Analyze in this session')}</button>
        </footer>
      </div> : null}
      {group.length >= 2 && !drawMode && !readOnly ? (() => {
        const members = group.map((id) => markById.get(id)).filter((mark): mark is ChartMark => Boolean(mark))
        const editable = members.filter((mark) => !mark.locked).map((mark) => mark.id)
        const allHidden = members.every((mark) => mark.hidden), allLocked = members.every((mark) => mark.locked)
        const stop = (event: React.SyntheticEvent) => event.stopPropagation()
        return <div className="dhl-draw-toolbar" role="toolbar" aria-label={tr('批量编辑画线', 'Edit selected drawings')} onPointerDown={stop} onClick={stop}>
          <span className="dhl-draw-toolbar-name">{tr(`已选 ${members.length} 条画线`, `${members.length} drawings selected`)}</span>
          <span className="dhl-draw-toolbar-group" role="group" aria-label={tr('颜色', 'Color')}>
            {DRAW_COLORS.map((color) => <button type="button" key={color} className="dhl-swatch" style={{ background: color }} disabled={drawingsLocked || editable.length === 0} aria-label={`${tr('全部改为', 'Recolor all')} ${color}`} onClick={() => onEditMarks?.(editable, { color })} />)}
          </span>
          <span className="dhl-draw-toolbar-group">
            <button type="button" aria-label={allHidden ? tr('全部显示', 'Show all') : tr('全部隐藏', 'Hide all')} title={allHidden ? tr('全部显示', 'Show all') : tr('全部隐藏', 'Hide all')} disabled={drawingsLocked} onClick={() => onEditMarks?.(group, { hidden: !allHidden })}><UiIcon name={allHidden ? 'eye' : 'eyeOff'} size={15} /></button>
            <button type="button" className={allLocked ? 'on' : ''} aria-pressed={allLocked} aria-label={allLocked ? tr('全部解锁', 'Unlock all') : tr('全部锁定', 'Lock all')} title={allLocked ? tr('全部解锁', 'Unlock all') : tr('全部锁定', 'Lock all')} disabled={drawingsLocked} onClick={() => onEditMarks?.(group, { locked: !allLocked })}><UiIcon name={allLocked ? 'lock' : 'unlock'} size={15} /></button>
            <button type="button" aria-label={tr('删除所选画线', 'Delete selected drawings')} title={tr('删除（Delete）', 'Delete (Del)')} disabled={drawingsLocked || editable.length === 0} onClick={() => { onRemoveMarks?.(editable); setGroup([]) }}><UiIcon name="trash" size={15} /></button>
            <button type="button" aria-label={tr('取消选择', 'Deselect')} title={tr('取消选择（Esc）', 'Deselect (Esc)')} onClick={() => setGroup([])}><UiIcon name="close" size={14} /></button>
          </span>
        </div>
      })() : null}
      {selectedMark && !drawMode && !readOnly ? <DrawToolbar mark={selectedMark} globallyLocked={drawingsLocked} placement={toolbarPlacement(selectedMark)} onTogglePin={(SCREEN_KINDS as string[]).includes(selectedMark.kind) ? () => { const patch = pinPatch(selectedMark); if (patch) onEditMark(selectedMark.id, patch) } : undefined}
        onCoordinates={() => setEditingId(selectedMark.id)}
        onEdit={(patch) => onEditMark(selectedMark.id, patch)} onClone={() => onCloneMark(cloneOf(selectedMark))} onRemove={() => { onRemoveMark(selectedMark.id); setSelectedId(null) }} onClose={() => setSelectedId(null)} /> : null}
      {editingMark ? <DrawingEditor key={editingMark.id} mark={editingMark} onApply={(patch) => { if (!drawingsLocked && !editingMark.locked) onEditMark(editingMark.id, patch) }} onClose={() => setEditingId(null)} /> : null}
      {!warming && <div className="dhl-chart-ohlc" data-time={inspected?.t} aria-live="off">
        <span>{crosshair ? new Date(crosshair.t).toLocaleString(tr('zh-CN', 'en-US'), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : tr('最新 K 线', 'Latest candle')}</span>
        {(['o', 'h', 'l', 'c'] as const).map((key) => <span key={key}>{key.toUpperCase()} <b className={inspected && inspected.c < inspected.o ? 'dhl-down' : 'dhl-up'}>{fmtPrice(inspected?.[key])}</b></span>)}
        <span>{tr('量', 'Vol')} <b>{inspected?.v.toLocaleString(undefined, { maximumFractionDigits: 4 }) ?? '—'}</b></span>
        {inspected ? <span className={inspected.c >= inspected.o ? 'dhl-up' : 'dhl-down'}>{((inspected.c / inspected.o - 1) * 100).toFixed(2)}%</span> : null}
        {chartType === 'heikinAshi' ? <span>{tr('平均K线 · 数值为原始行情', 'Heikin Ashi · values show exchange OHLC')}</span> : null}
      </div>}
      {!warming && olderState === 'loading' ? <div className="dhl-chart-older" role="status">{tr('正在加载更早的 K 线…', 'Loading earlier candles…')}</div> : null}
      {!warming && olderState === 'error' ? <div className="dhl-chart-older" role="status">{tr('更早的 K 线加载失败，继续向左拖动可重试', 'Could not load earlier candles; drag left again to retry')}</div> : null}
      {!warming && maComputed.length > 0 ? <div className="dhl-chart-ma-legend" aria-label={tr('均线数值', 'Moving average values')}>
        {maComputed.map((item) => {
          const index = crosshair ? candles.findIndex((candle) => Math.floor(candle.t / 1000) === Math.floor(crosshair.t / 1000)) : candles.length - 1
          const at = (series: Array<number | null> | null) => series && index >= 0 ? series[index] : null
          return <span key={item.line.id} style={{ color: item.color }}>{maLabel(item.line)} <b>{fmtPrice(at(item.values))}</b>{item.smoothed ? <> / <b>{fmtPrice(at(item.smoothed))}</b></> : null}</span>
        })}
      </div> : null}
      {crosshair && tradeEvents.some((event) => event.candleTime === crosshair.t) ? <div className="dhl-chart-trade-detail" aria-live="off">
        {tradeEvents.filter((event) => event.candleTime === crosshair.t).slice(0, 4).map((event) => <div key={event.id}>
          <strong>{event.kind === 'order' ? tr('委托', 'Order') : tr('成交', 'Fill')} · {event.isBuy ? tr('买入', 'Buy') : tr('卖出', 'Sell')}</strong>
          <span>{Number.isFinite(event.sz) ? event.sz : '—'} @ {fmtPrice(event.px)} · {new Date(event.time).toLocaleString()}</span>
          {event.reason ? <span title={event.reason}>{tr('原因', 'Reason')}：{event.reason}</span> : null}
        </div>)}
      </div> : null}
      {inspectedStudies.length ? <div className="dhl-chart-study-legend" aria-label={tr('指标点位数值', 'Study values at crosshair')}>
        {inspectedStudies.map(([label, value]) => <span key={label} data-study={label}>{label} <b>{value == null ? '—' : Number(value.toPrecision(7)).toLocaleString(undefined, { maximumFractionDigits: 7 })}</b></span>)}
      </div> : null}
      {warming ? <div className="dhl-empty" style={{ height: CHART_HEIGHT }}>{t('chart.loading', 'K 线加载中…')}</div> : null}
    </div>
    {showDataWindow && inspected ? <section className="dhl-data-window" aria-label={tr('图表数据窗口', 'Chart data window')} data-time={inspected.t}>
      <header><strong>{tr('数据窗口', 'Data window')}</strong><span>{new Date(inspected.t).toLocaleString()} · {crosshair ? tr('光标 K 线', 'Cursor bar') : tr('最新 K 线（可能未收盘）', 'Latest bar (may be forming)')}</span></header>
      <dl>{[['Open', inspected.o], ['High', inspected.h], ['Low', inspected.l], ['Close', inspected.c], ['Volume', inspected.v], ...inspectedStudies,
        ...maComputed.flatMap((item) => { const index = candles.findIndex((bar) => bar.t === inspected.t); return [[maLabel(item.line), item.values[index]] as const, ...(item.smoothed ? [[maLabel(item.line) + ' smooth', item.smoothed[index]] as const] : [])] })
      ].map(([label, value]) => <div key={String(label)}><dt>{label}</dt><dd>{value == null ? '—' : Number(value).toLocaleString(undefined, { maximumSignificantDigits: 10 })}</dd></div>)}</dl>
      {indicators.has('obv') ? <small>{tr('OBV 以已加载首根为零点；补取历史后基准会变化。', 'OBV starts at zero on the first loaded bar; loading history changes its baseline.')}</small> : null}
    </section> : null}
    </>
  )
}
