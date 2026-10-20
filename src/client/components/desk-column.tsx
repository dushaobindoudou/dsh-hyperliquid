/** Market workspace: contract strip, chart/funding, depth and account. */
import * as React from 'react'
import { Select } from './select'
import { hyperCall, t, tr } from '../remote'
import { fmt, fmtPrice, INTERVALS, MORE_INTERVALS } from '../format'
import { notify, store, useStore } from '../store'
import { insertChartReference, openSession, loadCandles, loadChartMarks, loadOlderCandles, loadFunding, loadTradeHistory, pushDeskInterval, saveSessionWorkspace } from '../data'
import { CandleChart, type ClonePayload, type DrawPayload, type MagnetMode } from './candle-chart'
import { useDrawingHistory } from '../drawing-history'
import { loadStyleTemplate } from '../drawing-templates'
import { DrawingList } from './drawing-list'
import { StickerPicker } from './sticker-picker'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { DRAWING_TOOLS, ToolIcon, drawingLabel, isTextKind, toolOf, type DrawPoint, type DrawingKind } from '../drawing-tools'
import { MaEditor } from './ma-editor'
import type { MaLine } from '../types'
import { MarketTape } from './market-tape'
import { BottomTable } from './bottom-table'
import type { ChartMark, Interval, SessionWorkspace } from '../types'
import { FoldIcon, UiIcon } from './panel-icons'
import { MarketPicker } from './market-picker'
import { MarketIcon } from './market-icon'
import { StrategyMenu } from './strategy-menu'
import type { IndicatorId } from '../chart-indicators'
import { chartTradeEvents, type TradeEvent } from '../trade-events'
import { IndicatorEditor } from './indicator-editor'
import { normalizeIndicatorSettings } from '../../../lib/studies.js'
import { ResearchPane } from './research-pane'
import { normalizeResearch } from '../../../lib/workspace-settings.js'
import type { ChartLink } from './candle-chart'
import { queueToAgent } from '../data'
import { ChartNavigation } from './chart-navigation'
import { candlesCsv, downloadBlob, type ChartCommand, type ChartType } from '../chart-basics'

const INDICATOR_CHOICES: Array<[IndicatorId, string, string]> = [
  ['volume', '成交量', 'K 线下方的成交量柱'],
  ['sma20', 'SMA 20', '20 根收盘价的简单均线'],
  ['sma60', 'MA 60', '60 根收盘价的简单均线'],
  ['ema20', 'EMA 20', '20 根收盘价的指数均线'],
  ['ema50', 'EMA 50', '50 根收盘价的指数均线'],
  ['bollinger20', '布林带 20', '均线及上下两倍标准差'],
  ['rsi14', 'RSI 14', '相对强弱指数副图'],
  ['macd', 'MACD', '12 / 26 / 9 动量副图'],
  ['stochastic', 'Stochastic', '%K 与 %D 随机指标'],
  ['adx', 'ADX / DMI', '趋势强度与正负方向指标'],
  ['obv', 'OBV', '以加载窗口首根为零点的累积能量潮'],
  ['atr14', 'ATR 14', 'Wilder 平滑的真实波幅，衡量价格波动'],
  ['vwap', 'VWAP · UTC', 'UTC 每日重置，以 HLC3 和成交量计算；自动补取当日 K 线'],
]
const INDICATOR_EN: Partial<Record<IndicatorId, [string, string]>> = {
  volume: ['Volume', 'Volume bars below the candles'], sma20: ['SMA 20', '20-close simple moving average'],
  sma60: ['MA 60', '60-close simple moving average'],
  ema20: ['EMA 20', '20-close exponential moving average'], ema50: ['EMA 50', '50-close exponential moving average'],
  bollinger20: ['Bollinger 20', 'Mean and two standard deviation bands'], rsi14: ['RSI 14', 'Relative strength index'],
  macd: ['MACD', '12 / 26 / 9 momentum panel'],
  stochastic: ['Stochastic', '%K and %D oscillator'], adx: ['ADX / DMI', 'Trend strength and directional movement'], obv: ['OBV', 'Cumulative signed volume; zero starts at the first loaded candle'],
  atr14: ['ATR 14', 'Wilder average true range, a measure of volatility'],
  vwap: ['VWAP · UTC', 'Daily UTC session, HLC3 weighted by volume; loads today’s bars as needed'],
}

/** A per-browser drawing preference, safe when storage is unavailable. */
function usePreference<T>(name: string, fallback: T, parse: (value: unknown) => T): [T, (value: T) => void] {
  const key = `dsh-hyperliquid.draw.${name}`
  const [value, setValue] = React.useState<T>(() => { try { const raw = localStorage.getItem(key); return raw == null ? fallback : parse(JSON.parse(raw)) } catch { return fallback } })
  const update = React.useCallback((next: T) => { setValue(next); try { localStorage.setItem(key, JSON.stringify(next)) } catch { /* storage unavailable */ } }, [key])
  return [value, update]
}

function finite(value: unknown): number | null {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function DeskColumn({ onCollapse }: { onCollapse: () => void }) {
  const s = useStore()
  const coin = s.activeCoin
  const row = (s.selectedMarket?.name === coin ? s.selectedMarket : null) ?? s.marketCatalog.find((u) => u.name === coin) ?? s.markets.find((u) => u.name === coin)
  const ctx = row?.ctx
  const liveMid = s.snapshot?.observedAt?.mids && Date.now() - s.snapshot.observedAt.mids < 10_000
    ? finite(s.snapshot?.mids?.mids?.[coin] ?? s.snapshot?.mids?.[coin]) : null
  const book = s.snapshot?.book?.levels
  const bid = finite(book?.[0]?.[0]?.px)
  const ask = finite(book?.[1]?.[0]?.px)
  const bookMid = bid != null && ask != null ? (bid + ask) / 2 : bid ?? ask
  const mark = row?.kind === 'outcome' ? bookMid ?? finite(ctx?.markPx)
    : row?.kind === 'perp' ? liveMid ?? finite(ctx?.markPx)
      : finite(ctx?.markPx) ?? liveMid
  const prev = finite(ctx?.prevDayPx)
  const volume = finite(ctx?.dayNtlVlm)
  const openInterest = finite(ctx?.openInterest)
  const funding = finite(ctx?.funding)
  const change = mark != null && mark > 0 && prev != null && prev > 0 ? (mark / prev - 1) * 100 : null
  const chartTab = s.workspaceSessionId === s.activeSessionId ? s.workspace?.chartTab ?? 'chart' : 'chart'
  const indicators = React.useMemo(() => new Set<IndicatorId>(s.workspaceSessionId === s.activeSessionId ? s.workspace?.indicators ?? ['volume'] : ['volume']), [s.workspace, s.workspaceSessionId, s.activeSessionId])
  const [drawMode, setDrawMode] = React.useState<DrawingKind | null>(null)
  const [favorites, setFavorites] = usePreference<DrawingKind[]>('favorites', ['trend', 'level', 'fib', 'rect', 'measure', 'long', 'short'], (value) => Array.isArray(value) ? [...new Set(value.filter((kind) => DRAWING_TOOLS.some((tool) => tool.kind === kind)))].slice(0, 12) : [])
  const chartScope = `${s.activeSessionId}:${coin}:${s.interval}`
  const [chartCommand, setChartCommand] = React.useState<{ scope: string; command: ChartCommand } | null>(null)
  const chartType = s.workspace?.chartType ?? 'candles'
  const studySettings = React.useMemo(() => normalizeIndicatorSettings(s.workspace?.indicatorSettings), [s.workspace?.indicatorSettings])
  const research = React.useMemo(() => normalizeResearch(s.workspace?.research), [s.workspace?.research])
  const researchScope = `${s.activeSessionId}:${s.workspaceSessionId}:${s.status?.network}:${coin}`
  const [cursorEvent, setCursorEvent] = React.useState<{ scope: string; value: NonNullable<ChartLink['cursor']> } | null>(null)
  const [rangeEvent, setRangeEvent] = React.useState<{ scope: string; value: NonNullable<ChartLink['range']> } | null>(null)
  const makeLink = (id: string): ChartLink => ({ id,
    cursor: research.syncCursor && cursorEvent?.scope === researchScope ? cursorEvent.value : null,
    range: research.syncTime && rangeEvent?.scope === researchScope ? rangeEvent.value : null,
    onCursor: (time) => { if (research.syncCursor) setCursorEvent((old) => old?.scope === researchScope && old.value.source === id && old.value.time === time ? old : { scope: researchScope, value: { source: id, time, at: performance.now() } }) },
    onRange: (range) => { if (research.syncTime) setRangeEvent({ scope: researchScope, value: { source: id, at: performance.now(), ...range } }) },
  })
  const researchCount = research.layout === 'quad' ? 3 : research.layout === 'dual' ? 1 : 0


  const drawMenu = React.useRef<HTMLDetailsElement>(null)
  /**
   * Keep the drawing menu inside its column: on a narrow column (an iPad in landscape) the right-aligned
   * popover spilled past the column's left edge, was clipped by it and sat under the sessions divider.
   */
  const popoverWatch = React.useRef<ResizeObserver | null>(null)
  const fitPopover = (details: HTMLDetailsElement) => {
    const pop = details.querySelector<HTMLElement>('.dhl-draw-popover')
    if (!pop) return
    const columnEl = details.closest('.dhl-col-desk') ?? document.body
    const fit = () => {
      pop.style.right = ''; pop.style.width = ''
      if (!details.open) return
      const column = columnEl.getBoundingClientRect()
      const room = column.width - 8
      if (pop.getBoundingClientRect().width > room) pop.style.width = `${Math.max(200, room)}px`
      const rect = pop.getBoundingClientRect()
      if (rect.left < column.left + 4) pop.style.right = `${rect.left - (column.left + 4)}px`
    }
    fit()
    // While open, follow the column as the window or the layout changes.
    popoverWatch.current?.disconnect(); popoverWatch.current = null
    if (details.open && typeof ResizeObserver !== 'undefined') { popoverWatch.current = new ResizeObserver(fit); popoverWatch.current.observe(columnEl) }
  }
  React.useEffect(() => () => popoverWatch.current?.disconnect(), [])
  // Tool preferences are per browser (TradingView keeps them global); drawings themselves are per session.
  const [magnet, setMagnet] = usePreference<MagnetMode>('magnet', 'off', (value) => value === 'weak' || value === 'strong' ? value : 'off')
  const [stayDrawing, setStayDrawing] = usePreference<boolean>('stayDrawing', false, (value) => value === true)
  const [drawingsLocked, setDrawingsLocked] = usePreference<boolean>('drawingsLocked', false, (value) => value === true)
  const [textAt, setTextAt] = React.useState<{ kind: DrawingKind; points: DrawPoint[]; screenX?: number; screenY?: number } | null>(null)
  const [selectRequest, setSelectRequest] = React.useState<{ id: string; at: number } | null>(null)
  const [textValue, setTextValue] = React.useState('')
  // 66 tools: a search box narrows the menu by Chinese name, English name or kind.
  const [toolQuery, setToolQuery] = React.useState('')
  const [confirmClear, setConfirmClear] = React.useState(false)
  const [pickerOpen, setPickerOpen] = React.useState(false)
  const [chartExpanded, setChartExpanded] = React.useState(false)
  // Expanded = real browser fullscreen when the browser allows it (else the in-page expanded panel).
  // The whole page goes fullscreen, not just the chart, so dialogs (text entry, market picker) still show.
  const [fullscreen, setFullscreen] = React.useState(false)
  type KeyboardLock = { lock?: (keys: string[]) => Promise<void>; unlock?: () => void }
  const keyboard = () => (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard
  // Each request gets a number; leaving bumps it, so a request that finishes after the trader left is undone.
  const fullscreenRequest = React.useRef(0)
  const enterExpanded = React.useCallback(() => {
    setChartExpanded(true)
    const root = document.documentElement
    if (!document.fullscreenElement && root.requestFullscreen) {
      const request = ++fullscreenRequest.current
      // Keep Esc for the chart (cancel drawing → deselect → leave) where the browser lets us lock it.
      void root.requestFullscreen({ navigationUI: 'hide' }).then(async () => {
        if (request !== fullscreenRequest.current) { await document.exitFullscreen().catch(() => {}); return }
        await keyboard()?.lock?.(['Escape'])
        // Left while the lock was pending: release it again.
        if (request !== fullscreenRequest.current) keyboard()?.unlock?.()
      }).catch(() => { /* not allowed: stay in-page */ })
    }
  }, [])
  const leaveExpanded = React.useCallback(() => {
    fullscreenRequest.current += 1
    setChartExpanded(false)
    keyboard()?.unlock?.()
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
  }, [])
  React.useEffect(() => {
    // Leaving fullscreen from the browser (Esc without a keyboard lock, F11, system UI) also leaves the expanded chart.
    const onChange = () => {
      const on = Boolean(document.fullscreenElement)
      setFullscreen(on)
      if (!on) { fullscreenRequest.current += 1; keyboard()?.unlock?.(); setChartExpanded(false) }
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])
  const [chartResetToken, setChartResetToken] = React.useState(0)
  const sessionMaLines = s.workspaceSessionId === s.activeSessionId ? s.workspace?.maLines : undefined
  const maLines = React.useMemo<MaLine[]>(() => sessionMaLines ?? [], [sessionMaLines])
  const toggleIndicator = (id: IndicatorId) => {
    const next = new Set(indicators)
    if (next.has(id)) next.delete(id); else next.add(id)
    saveSessionWorkspace({ indicators: [...next] })
  }
  React.useEffect(() => { setDrawMode(null); leaveExpanded() }, [s.activeSessionId, leaveExpanded])
  const marks = s.chartMarksKey === `${s.activeSessionId ?? ''}:${coin}` ? s.chartMarks : []
  const layers = { orders: true, fills: true, drawings: true, reasons: false, ...s.workspace?.chartLayers }
  const tradeEvents = React.useMemo(() => chartTradeEvents(s.candles, coin,
    layers.orders ? s.tradeHistory?.orders ?? [] : [], layers.fills ? s.tradeHistory?.fills ?? [] : []),
  [s.candles, coin, s.tradeHistory, layers.orders, layers.fills])
  const stayRef = React.useRef(stayDrawing)
  stayRef.current = stayDrawing
  const history = useDrawingHistory(`${s.activeSessionId ?? ''}:${coin}`)
  const historyRef = React.useRef(history)
  historyRef.current = history
  /** New drawings take the tool's saved default style. */
  const save = React.useCallback((mark: DrawPayload, label: string) => {
    void historyRef.current.create({ ...loadStyleTemplate(mark.kind), ...mark, label })
  }, [])
  const draw = React.useCallback((mark: DrawPayload) => {
    if (!stayRef.current) setDrawMode(null)
    if ((isTextKind(mark.kind) || mark.kind === 'icon') && 'points' in mark) { setTextValue(''); setTextAt({ kind: mark.kind, points: mark.points, screenX: mark.screenX, screenY: mark.screenY }); return }
    void save(mark, mark.kind === 'level' ? drawingLabel('level', [], mark.price)
      : mark.kind === 'trend' ? drawingLabel('trend', [{ time: mark.fromTime, price: mark.fromPrice }])
        : drawingLabel(mark.kind, mark.points))
  }, [save])
  /** A fill goes back to the conversation that decided it, as a quote chip with its rationale. */
  const analyzeFill = React.useCallback((event: TradeEvent) => {
    const state = store.get()
    const known = (id: string | null) => Boolean(id && state.sessions.some((row) => row.sessionId === id) && !state.archivedSessionIds.includes(id))
    const target = known(event.sessionId) ? event.sessionId! : state.activeSessionId
    if (!target) { notify(tr('请先选择交易会话', 'Choose a trading session first')); return }
    const side = event.isBuy ? tr('买入', 'Buy') : tr('卖出', 'Sell')
    const when = new Date(event.time).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')
    const text = [
      tr(`【成交复盘】${event.coin} ${side} ${event.sz} @ ${event.px}（${when}，图表周期 ${state.interval}）`, `[Fill review] ${event.coin} ${side} ${event.sz} @ ${event.px} (${when}, chart ${state.interval})`),
      event.reason ? tr(`当时的决策原因：${event.reason}`, `Rationale at the time: ${event.reason}`) : tr('这笔成交没有记录决策原因。', 'No rationale was recorded for this fill.'),
      tr('请结合成交之后的走势复盘：依据是否仍然成立、执行是否到位、接下来如何管理这笔仓位。', 'Review it against what happened since: does the thesis still hold, was execution sound, and how should the position be managed now?'),
    ].join('\n')
    store.patch((current) => ({ chartReferences: [...current.chartReferences, { id: Date.now() + Math.random(), sessionId: target, text,
      label: `${tr('成交', 'Fill')} ${side} ${event.sz} ${event.coin} @ ${fmtPrice(event.px)}`, coin: event.coin, interval: state.interval, t: event.candleTime }] }))
    if (target !== state.activeSessionId) {
      void openSession(target, event.coin)
      notify(tr('已切换到做出这笔决策的会话，复盘引用已放入输入框', 'Switched to the session that made this decision; the review is in the composer'))
    }
  }, [])
  const editMark = React.useCallback((id: string, patch: Record<string, unknown>) => historyRef.current.edit(id, patch), [])
  const erase = React.useCallback((id: string) => historyRef.current.remove(id), [])
  const selectMark = React.useCallback((id: string) => setSelectRequest({ id, at: Date.now() }), [])
  const cloneMark = React.useCallback((copy: ClonePayload) => {
    void historyRef.current.create({ kind: copy.kind, label: copy.label, ...copy.geometry, ...copy.style })
  }, [])
  // Shortcuts act on the chart the trader last pressed: a read-only research pane must not undo or draw on the main chart.
  const onSecondaryChart = React.useRef(false)
  React.useEffect(() => {
    const track = (event: PointerEvent) => {
      const target = event.target as Element | null
      onSecondaryChart.current = Boolean(target?.closest?.('.dhl-research-pane') && !target.closest('.dhl-primary-pane'))
    }
    window.addEventListener('pointerdown', track, true)
    return () => window.removeEventListener('pointerdown', track, true)
  }, [])
  // Ctrl/Cmd+Z undo, Shift+Ctrl/Cmd+Z or Ctrl+Y redo — never while typing (the chat composer keeps its own undo).
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || onSecondaryChart.current) return
      const element = event.target as HTMLElement | null
      if (element?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(element?.tagName ?? '')) return
      const key = event.key.toLowerCase()
      if (key === 'z' && !event.shiftKey) { event.preventDefault(); void historyRef.current.undo() }
      else if ((key === 'z' && event.shiftKey) || key === 'y') { event.preventDefault(); void historyRef.current.redo() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || pickerOpen) return
      const element = event.target as HTMLElement
      if (element.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName)) return
      event.preventDefault()
      setPickerOpen(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pickerOpen])
  React.useEffect(() => {
    if (!chartExpanded) return undefined
    // Esc peels one layer at a time: cancel drawing → deselect (both consume the key) → leave the expanded chart.
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pickerOpen && !event.defaultPrevented) { event.preventDefault(); leaveExpanded() }
    }
    window.addEventListener('keydown', onEscape)
    return () => window.removeEventListener('keydown', onEscape)
  }, [chartExpanded, pickerOpen, leaveExpanded])
  // TradingView drawing shortcuts (physical keys, so Option+letter works on macOS).
  React.useEffect(() => {
    const keys: Record<string, DrawingKind> = { KeyT: 'trend', KeyH: 'level', KeyJ: 'hray', KeyV: 'vline', KeyC: 'crossline', KeyF: 'fib' }
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || chartTab !== 'chart' || onSecondaryChart.current) return
      const element = event.target as HTMLElement | null
      if (element?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(element?.tagName ?? '')) return
      const kind = event.shiftKey ? (event.code === 'KeyR' ? 'rect' : undefined) : keys[event.code]
      if (!kind) return
      event.preventDefault()
      setDrawMode(kind)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [chartTab])
  React.useEffect(() => {
    if (!drawMode) return undefined
    const cancel = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setDrawMode(null) } }
    window.addEventListener('keydown', cancel, true)
    return () => window.removeEventListener('keydown', cancel, true)
  }, [drawMode])

  React.useEffect(() => {
    if (chartTab === 'funding' && row?.kind !== 'spot' && row?.kind !== 'outcome' && store.get().fundingCoin !== coin) void loadFunding()
    if (chartTab === 'funding' && (row?.kind === 'spot' || row?.kind === 'outcome')) saveSessionWorkspace({ chartTab: 'chart' })
  }, [chartTab, coin, row?.kind])
  React.useEffect(() => {
    if (!indicators.has('vwap') || s.candlesOlder !== 'idle' || s.candles.length < 2) return
    const start = Math.floor(s.candles.at(-1)!.t / 86_400_000) * 86_400_000
    if (s.candles[0].t > start) void loadOlderCandles()
  }, [indicators, s.candles, s.candlesOlder])
  // Range studies (volume profile, regression, anchored VWAP / profile) need every bar in their range: page in history they start before.
  React.useEffect(() => {
    if (s.candlesOlder !== 'idle' || s.candles.length < 2) return
    const earliest = Math.min(...s.chartMarks.filter((mark) => !mark.hidden && ['vprofile', 'regression', 'avwap', 'avprofile'].includes(mark.kind)).map((mark) => Math.min(...(mark.points ?? []).map((point) => point.time))))
    if (Number.isFinite(earliest) && s.candles[0].t > earliest) void loadOlderCandles()
  }, [s.chartMarks, s.candles, s.candlesOlder])
  React.useEffect(() => { void loadChartMarks() }, [s.activeSessionId, coin, s.interval])
  React.useEffect(() => { void loadTradeHistory() }, [s.status?.network, s.status?.tradingMode])
  const changeInterval = React.useCallback((next: Interval) => {
    store.patch({ interval: next })
    pushDeskInterval(next)
    void loadCandles()
  }, [])

  const stats: Array<[string, string, string?]> = [
    [tr('标记价格', 'Mark'), fmtPrice(mark)],
    [tr('预言机', 'Oracle'), fmtPrice(ctx?.oraclePx)],
    [tr('24h 涨跌', '24h change'), change == null ? '—' : `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`, change == null ? '' : change >= 0 ? 'dhl-up' : 'dhl-down'],
    [tr('24h 成交额', '24h volume'), volume == null ? '—' : `$${fmt(volume, 0)}`],
    [tr('未平仓量', 'Open interest'), openInterest == null || mark == null ? '—' : `$${fmt(openInterest * mark, 0)}`],
    [tr('资金费 / h', 'Funding / h'), funding == null ? '—' : `${(funding * 100).toFixed(4)}%`],
  ]

  return (
    <main id="dhl-panel-desk" className="dhl-col-desk">
      <header className="dhl-market-strip">
        <div className="dhl-market-name">
          <button type="button" className="dhl-market-trigger" aria-haspopup="dialog" aria-expanded={pickerOpen} onClick={() => setPickerOpen(true)}>
            <MarketIcon market={row ?? { name: coin, label: `${coin}-USDC`, kind: 'perp' }} />
            <strong>{row?.label ?? `${coin}-USDC`}</strong>
            <span className="dhl-market-chevron"><UiIcon name="chevronDown" size={16} /></span>
          </button>
          <span className="dhl-market-kind">{row?.kind === 'spot' ? 'SPOT' : row?.kind === 'hip3' ? 'HIP-3' : row?.kind === 'outcome' ? 'OUTCOME' : 'PERP'}</span>
          {row?.maxLeverage ? <span className="dhl-market-tag">{row.maxLeverage}x</span> : null}
          {row?.tradable === false ? <span className="dhl-market-readonly">{tr('只读', 'View only')}</span> : null}
        </div>
        <div className="dhl-market-stats">
          {stats.map(([label, value, tone]) => (
            <div className="dhl-market-stat" key={label}>
              <span>{label}</span><strong className={tone ?? ''}>{value}</strong>
            </div>
          ))}
        </div>
        <button className="dhl-panel-iconbtn" type="button" onClick={onCollapse} aria-label={tr('收起行情区', 'Collapse market panel')} title={tr('收起行情区', 'Collapse market panel')}><FoldIcon direction="right" /></button>
      </header>
      <Modal open={Boolean(textAt)} onClose={() => setTextAt(null)} title={textAt?.kind === 'icon' ? tr('选择图标', 'Pick an icon') : textAt?.kind === 'callout' ? tr('添加标注', 'Add callout') : textAt?.kind === 'table' ? tr('添加表格（| 分隔单元格，; 分隔行）', 'Add table (| between cells, ; between rows)') : tr('添加文本', 'Add text')} closeLabel={tr('关闭', 'Close')} className="dhl-rename-modal"
        footer={<><Button variant="outline" onClick={() => setTextAt(null)}>{tr('取消', 'Cancel')}</Button><Button variant="primary" disabled={!textValue.trim()} onClick={() => { if (textAt && textValue.trim()) void save({ kind: textAt.kind as 'text', points: textAt.points, ...(textAt.screenX != null ? { screenX: textAt.screenX, screenY: textAt.screenY } : {}) }, textValue.trim()); setTextAt(null) }}>{tr('添加', 'Add')}</Button></>}>
        {textAt?.kind === 'icon' ? <StickerPicker onPick={(name) => { if (textAt) void save({ kind: 'icon', points: textAt.points }, name); setTextAt(null) }} /> :         <Input data-modal-autofocus className="dhl-rename-input" value={textValue} maxLength={200} placeholder={tr('输入要标在图上的文字', 'Text to place on the chart')} aria-label={tr('文本内容', 'Text')}
          onChange={(event) => setTextValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && textAt && textValue.trim()) { event.preventDefault(); void save({ kind: textAt.kind as 'text', points: textAt.points, ...(textAt.screenX != null ? { screenX: textAt.screenX, screenY: textAt.screenY } : {}) }, textValue.trim()); setTextAt(null) } }} />}
      </Modal>
      {pickerOpen ? <MarketPicker activeCoin={coin} onClose={() => setPickerOpen(false)} /> : null}

      <div className={'dhl-market-workspace' + (s.tapePlacement === 'below' ? ' dhl-tape-below' : '')}>
        <section className={'dhl-chart-panel' + (chartExpanded ? ' dhl-chart-panel-expanded' : '') + (chartExpanded && fullscreen ? ' is-fullscreen' : '')} aria-label={tr('行情图表', 'Market chart')}>
          <div className="dhl-chart-tabs" role="tablist" aria-label={tr('图表内容', 'Chart content')}>
            <button type="button" role="tab" aria-selected={chartTab === 'chart'} className={chartTab === 'chart' ? 'on' : ''} onClick={() => saveSessionWorkspace({ chartTab: 'chart' })}>{tr('K 线', 'Chart')}</button>
            {row?.kind !== 'spot' && row?.kind !== 'outcome' ? <button type="button" role="tab" aria-selected={chartTab === 'funding'} className={chartTab === 'funding' ? 'on' : ''} onClick={() => saveSessionWorkspace({ chartTab: 'funding' })}>{tr('资金费历史', 'Funding history')}</button> : null}
          </div>
          {chartTab === 'chart' ? (
            <div role="tabpanel">
              <div className="dhl-chart-tools">
                <div className="dhl-intervals" aria-label={tr('K 线周期', 'Chart interval')}>
                  {INTERVALS.map((iv) => <button key={iv} type="button" className={s.interval === iv ? 'on' : ''} onClick={() => changeInterval(iv)}>{iv}</button>)}
                  <Select aria-label={tr('更多 K 线周期', 'More chart intervals')} value={MORE_INTERVALS.includes(s.interval) ? s.interval : ''} onChange={(event) => changeInterval(event.target.value as Interval)}>
                    <option value="" disabled>{tr('更多', 'More')}</option>
                    {MORE_INTERVALS.map((iv) => <option key={iv} value={iv}>{iv}</option>)}
                  </Select>
                </div>
                <div className="dhl-chart-actions">
                  <Select aria-label={tr('图表类型', 'Chart type')} value={chartType} onChange={(event) => saveSessionWorkspace({ chartType: event.target.value as ChartType })}>
                    {([['candles', '蜡烛图', 'Candles'], ['bars', '美国线', 'OHLC bars'], ['line', '折线图', 'Line'], ['area', '面积图', 'Area'], ['heikinAshi', '平均K线', 'Heikin Ashi']] as const).map(([value, zh, en]) => <option key={value} value={value}>{tr(zh, en)}</option>)}
                  </Select>
                  <details className="dhl-layer-menu">
                    <summary>{tr('显示', 'Show')}<UiIcon name="chevronDown" size={12} /></summary>
                    <div className="dhl-layer-popover">
                      {([['orders', tr('委托', 'Orders')], ['fills', tr('成交', 'Fills')], ['reasons', tr('成交原因', 'Fill reasons')], ['drawings', tr('画线', 'Drawings')]] as const).map(([id, label]) => <label key={id}><input type="checkbox" checked={layers[id]} onChange={(event) => saveSessionWorkspace({ chartLayers: { ...layers, [id]: event.target.checked } })} />{label}</label>)}
                    </div>
                  </details>
                  <details className="dhl-indicator-menu">
                    <summary aria-label={tr('选择图表指标', 'Choose chart indicators')}>{tr('指标', 'Indicators')} <span className="dhl-indicator-count">{indicators.size + maLines.length}</span></summary>
                    <div className="dhl-indicator-popover" role="group" aria-label={tr('图表指标', 'Chart indicators')}>
                      <strong>{tr('图表指标', 'Chart indicators')}</strong>
                      {INDICATOR_CHOICES.map(([id, label, description]) => <button type="button" key={id} className={indicators.has(id) ? 'on' : ''} aria-pressed={indicators.has(id)} onClick={() => toggleIndicator(id)}>
                        <span className="dhl-indicator-check" aria-hidden="true">{indicators.has(id) ? <UiIcon name="check" size={13} /> : null}</span>
                        <span><b>{id === 'rsi14' ? `RSI ${studySettings.rsi.period}` : id === 'bollinger20' ? `BOLL ${studySettings.bollinger.period} × ${studySettings.bollinger.multiplier}` : tr(label, INDICATOR_EN[id]?.[0] ?? label)}</b><small>{id === 'macd' ? `${studySettings.macd.fast} / ${studySettings.macd.slow} / ${studySettings.macd.signal}` : id === 'bollinger20' ? tr('均线与标准差通道', 'Mean and standard deviation bands') : tr(description, INDICATOR_EN[id]?.[1] ?? description)}</small></span>
                      </button>)}
                      <IndicatorEditor key={s.activeSessionId} settings={s.workspace?.indicatorSettings} indicators={[...indicators]} maLines={maLines} onApply={saveSessionWorkspace} />
                      <MaEditor lines={maLines} onChange={(next) => saveSessionWorkspace({ maLines: next })} />
                    </div>
                  </details>
                  <button type="button" className={s.workspace?.showDataWindow ? 'on' : ''} aria-pressed={s.workspace?.showDataWindow ?? false} onClick={() => saveSessionWorkspace({ showDataWindow: !s.workspace?.showDataWindow })}>{tr('数据窗口', 'Data window')}</button>
                  <StrategyMenu candles={s.candles} coin={coin} interval={s.interval} />
                  <details className={'dhl-draw-menu' + (drawMode ? ' active' : '')} ref={drawMenu} onToggle={(event) => fitPopover(event.currentTarget)}>
                    <summary aria-label={tr('画线工具', 'Drawing tools')}>{drawMode ? <><ToolIcon kind={drawMode} size={14} />{tr(toolOf(drawMode).zh, toolOf(drawMode).en)}</> : tr('画线', 'Draw')}<UiIcon name="chevronDown" size={12} /></summary>
                    <div className="dhl-draw-popover" role="menu" aria-label={tr('画线工具', 'Drawing tools')}>
                      <input className="dhl-draw-search" type="search" value={toolQuery} placeholder={tr(`搜索 ${DRAWING_TOOLS.length} 种画线工具`, `Search ${DRAWING_TOOLS.length} drawing tools`)} aria-label={tr('搜索画线工具', 'Search drawing tools')}
                        onChange={(event) => setToolQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape' && toolQuery) { event.stopPropagation(); setToolQuery('') } }} />
                      {(() => {
                        const query = toolQuery.trim().toLowerCase()
                        const shown = query ? DRAWING_TOOLS.filter((tool) => `${tool.zh} ${tool.en} ${tool.kind}`.toLowerCase().includes(query)) : DRAWING_TOOLS
                        return shown.length ? null : <p className="dhl-draw-empty">{tr('没有匹配的画线工具', 'No matching tools')}</p>
                      })()}
                      {DRAWING_TOOLS.filter((tool) => { const query = toolQuery.trim().toLowerCase(); return !query || `${tool.zh} ${tool.en} ${tool.kind}`.toLowerCase().includes(query) }).map((tool, index, shown) => <React.Fragment key={tool.kind}>
                        {index > 0 && shown[index - 1].group !== tool.group ? <hr /> : null}
                        <div className="dhl-draw-tool-row">
                          <button type="button" role="menuitemradio" aria-checked={drawMode === tool.kind} className={drawMode === tool.kind ? 'on' : ''}
                            onClick={() => { setDrawMode(drawMode === tool.kind ? null : tool.kind); drawMenu.current?.removeAttribute('open') }}>
                            <ToolIcon kind={tool.kind} /><span><b>{tr(tool.zh, tool.en)}</b><small>{tr(tool.hintZh, tool.hintEn)}</small></span>
                          </button>
                          <button type="button" className="dhl-draw-favorite" aria-label={`${favorites.includes(tool.kind) ? tr('取消收藏', 'Unfavorite') : tr('收藏', 'Favorite')} ${tr(tool.zh, tool.en)}`} aria-pressed={favorites.includes(tool.kind)} disabled={!favorites.includes(tool.kind) && favorites.length >= 12}
                            onClick={() => setFavorites(favorites.includes(tool.kind) ? favorites.filter((kind) => kind !== tool.kind) : [...favorites, tool.kind])}>
                            <UiIcon name="star" filled={favorites.includes(tool.kind)} size={14} />
                          </button>
                        </div>
                      </React.Fragment>)}
                      <div className="dhl-draw-settings">
                        <div className="dhl-draw-setting"><span>{tr('磁吸', 'Magnet')}</span>
                          <span className="dhl-draw-seg" role="radiogroup" aria-label={tr('磁吸', 'Magnet')}>
                            {([['off', '关', 'Off'], ['weak', '弱', 'Weak'], ['strong', '强', 'Strong']] as const).map(([value, zh, en]) => <button type="button" role="radio" key={value} aria-checked={magnet === value} className={magnet === value ? 'on' : ''} onClick={() => setMagnet(value)}>{tr(zh, en)}</button>)}
                          </span></div>
                        <label className="dhl-draw-setting"><span>{tr('连续绘制', 'Stay in drawing mode')}</span><input type="checkbox" checked={stayDrawing} onChange={(event) => setStayDrawing(event.target.checked)} /></label>
                        <label className="dhl-draw-setting"><span>{tr('锁定所有画线', 'Lock all drawings')}</span><input type="checkbox" checked={drawingsLocked} onChange={(event) => setDrawingsLocked(event.target.checked)} /></label>
                        <button type="button" className={'dhl-draw-clear' + (confirmClear ? ' confirm' : '')} disabled={!marks.length || drawingsLocked}
                          onClick={() => { if (!confirmClear) { setConfirmClear(true); return } setConfirmClear(false); drawMenu.current?.removeAttribute('open'); void history.removeMany(marks.filter((item) => !item.locked).map((item) => item.id)) }}
                          onBlur={() => setConfirmClear(false)}>
                          {confirmClear ? tr(`确认删除 ${marks.filter((item) => !item.locked).length} 条画线`, `Delete ${marks.filter((item) => !item.locked).length} drawings`) : tr('删除所有画线', 'Remove all drawings')}
                        </button>
                      </div>
                    </div>
                  </details>
                  <button type="button" className="dhl-chart-iconbtn" disabled={!history.canUndo} aria-label={tr('撤销', 'Undo')} title={tr('撤销画线操作（Ctrl/Cmd+Z）', 'Undo drawing change (Ctrl/Cmd+Z)')} onClick={() => void history.undo()}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M9 14 4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></svg>
                  </button>
                  <button type="button" className="dhl-chart-iconbtn" disabled={!history.canRedo} aria-label={tr('重做', 'Redo')} title={tr('重做（Shift+Ctrl/Cmd+Z）', 'Redo (Shift+Ctrl/Cmd+Z)')} onClick={() => void history.redo()}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m15 14 5-5-5-5" /><path d="M20 9H10a6 6 0 0 0 0 12h3" /></svg>
                  </button>
                  <Select aria-label={tr('价格刻度', 'Price scale')} value={s.workspace?.priceScale ?? 'normal'} onChange={(event) => saveSessionWorkspace({ priceScale: event.target.value as SessionWorkspace['priceScale'] })}>
                    <option value="normal">{tr('线性', 'Linear')}</option><option value="log">{tr('对数', 'Log')}</option><option value="percentage">%</option>
                  </Select>
                  <span className="dhl-chart-action-separator" aria-hidden="true" />
                  <button type="button" className="dhl-chart-iconbtn" aria-label={tr('复位图表视图', 'Reset chart view')} title={tr('复位图表视图', 'Reset chart view')} onClick={() => setChartResetToken((value) => value + 1)}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M3 11a9 9 0 1 0 2.6-6.4M3 4v6h6" /><path d="M12 7v5l3 2" /></svg>
                  </button>
                  <button type="button" className="dhl-chart-iconbtn" aria-label={chartExpanded ? tr('退出全屏图表', 'Exit fullscreen chart') : tr('全屏图表', 'Fullscreen chart')} aria-pressed={chartExpanded} title={chartExpanded ? tr('退出全屏 (Esc)', 'Exit fullscreen (Esc)') : tr('全屏图表', 'Fullscreen chart')} onClick={() => chartExpanded ? leaveExpanded() : enterExpanded()}>
                    {chartExpanded
                      ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M9 3v6H3m18 6h-6v6M3 9h6V3m12 12h-6v6" /></svg>
                      : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6" /></svg>}
                  </button>
                </div>
              </div>
              <div className="dhl-favorite-tools" role="toolbar" aria-label={tr('常用画线', 'Favorite drawing tools')}>
                <button type="button" aria-label={tr('光标（取消绘制）', 'Cursor (cancel drawing)')} title={tr('光标 · Esc 取消绘制', 'Cursor · Esc cancels drawing')} aria-pressed={!drawMode} className={!drawMode ? 'on' : ''} onClick={() => setDrawMode(null)}><UiIcon name="cursor" size={16} /></button>
                <span className="dhl-chart-action-separator" aria-hidden="true" />
                {favorites.map((kind) => <button key={kind} type="button" title={tr(toolOf(kind).zh, toolOf(kind).en)} aria-label={`${tr('常用', 'Favorite')} ${tr(toolOf(kind).zh, toolOf(kind).en)}`} aria-pressed={drawMode === kind} className={drawMode === kind ? 'on' : ''} onClick={() => setDrawMode(drawMode === kind ? null : kind)}><ToolIcon kind={kind} size={16} /></button>)}
                <small>{tr('在画线菜单中收藏常用工具', 'Star tools in the Draw menu')}</small>
              </div>
              <div className="dhl-research-controls">
                <Select aria-label={tr('多周期布局', 'Research layout')} value={research.layout} onChange={(e) => saveSessionWorkspace({ research: { ...research, layout: e.target.value as 'single' | 'dual' | 'quad' } })}><option value="single">{tr('单图', 'Single chart')}</option><option value="dual">{tr('双图研究', 'Two charts')}</option><option value="quad">{tr('四图研究', 'Four charts')}</option></Select>
                <label><input type="checkbox" checked={research.syncTime} onChange={(e) => { setRangeEvent(null); saveSessionWorkspace({ research: { ...research, syncTime: e.target.checked } }) }} />{tr('时间联动', 'Sync time')}</label>
                <label><input type="checkbox" checked={research.syncCursor} onChange={(e) => { setCursorEvent(null); saveSessionWorkspace({ research: { ...research, syncCursor: e.target.checked } }) }} />{tr('光标联动', 'Sync cursor')}</label>
                {researchCount > 0 ? <button type="button" className="dhl-ghost" onClick={() => queueToAgent(tr(`请研究 ${coin} 的 ${[s.interval, ...research.intervals.slice(0, researchCount)].join('、')} 多周期结构。先读取 hyper_context 的指标参数，再逐周期调用 hyper_market action=indicators；只对已收盘 K 线作比较，说明大周期趋势、小周期动量与冲突，以及数据时效。`, `Research ${coin} across ${[s.interval, ...research.intervals.slice(0, researchCount)].join(', ')}. Read hyper_context for configured indicators, then query hyper_market action=indicators for each interval. Compare closed bars, trend, momentum, conflicts and freshness.`))}>{tr('讨论多周期', 'Discuss timeframes')}</button> : null}
              </div>
              <div className="dhl-chart">
                <div className={`dhl-research-grid ${research.layout}`}>
                <section className="dhl-research-pane dhl-primary-pane">
                {researchCount > 0 ? <header><b>{coin} · {s.interval}</b><small>{tr('主图 · 编辑画线', 'Main chart · edit drawings')}</small></header> : null}
                <CandleChart link={researchCount > 0 ? makeLink('primary') : undefined} compact={researchCount > 0} indicatorSettings={s.workspace?.indicatorSettings} showDataWindow={s.workspace?.showDataWindow ?? false} chartType={chartType} command={chartCommand?.scope === chartScope ? chartCommand.command : null} caption={`${coin} ${s.interval} · ${chartType}`} candles={s.candles} marks={layers.drawings ? marks : []} tradeEvents={tradeEvents} indicators={indicators} expanded={chartExpanded} resetToken={chartResetToken}
                  interval={s.interval} drawMode={drawMode} onDraw={draw} onSelect={(selection) => insertChartReference(selection, coin, s.interval)} onNeedOlder={loadOlderCandles} olderState={s.candlesOlder}
                  showReasons={layers.fills && layers.reasons} onAnalyzeFill={analyzeFill}
                  onCloneMark={cloneMark} selectRequest={selectRequest}
                  magnet={magnet} drawingsLocked={drawingsLocked} onEditMark={(id, patch) => void editMark(id, patch)} onRemoveMark={(id) => void erase(id)} onRemoveMarks={(ids) => void history.removeMany(ids)} onEditMarks={(ids, patch) => void history.editMany(ids, patch)} onEditEach={(patches) => void history.editEach(patches)}
                  focus={s.chartFocus && s.chartFocus.coin === coin && s.chartFocus.interval === s.interval ? s.chartFocus : null} maLines={maLines} priceScale={s.workspace?.priceScale ?? 'normal'}
                  visibleRange={s.workspace?.chartRanges?.[`${coin}:${s.interval}`] ?? null}
                  onVisibleRange={(range) => saveSessionWorkspace({ chartRanges: { [`${coin}:${s.interval}`]: range } })}
                  key={`${s.activeSessionId ?? ''}:${s.workspaceSessionId === s.activeSessionId ? 'ready' : 'pending'}:${coin}:${s.interval}`} />
                </section>
                {research.intervals.slice(0, researchCount).map((iv, index) => <ResearchPane key={`${researchScope}:${index}`} coin={coin} interval={iv} indicators={indicators} marks={layers.drawings ? marks : []} chartType={chartType} link={makeLink(`secondary-${index}`)} onAnalyzeFill={analyzeFill}
                  onInterval={(next) => saveSessionWorkspace({ research: { ...research, intervals: research.intervals.map((value, i) => i === index ? next : value) } })} />)}
                </div>
                <div className="dhl-chart-click-hint">{drawMode
                  ? `${tr(toolOf(drawMode).zh, toolOf(drawMode).en)}：${tr(toolOf(drawMode).hintZh, toolOf(drawMode).hintEn)} · ${tr('Esc 取消', 'Esc to cancel')}`
                  : tr('点击 K 线、成交量柱或指标线，将该点数据加入聊天输入框', 'Click a candle, volume bar or study line to add its data to the chat draft')}</div>
                {marks.length > 0 ? <DrawingList marks={marks} locked={drawingsLocked} language={tr('zh', 'en')} onSelect={selectMark}
                  onEdit={editMark} onRemove={erase} /> : null}
                <ChartNavigation disabled={s.candles.length < 2}
                  onNavigate={(action) => setChartCommand({ scope: chartScope, command: { ...action, at: performance.now() } })}
                  onCsv={() => downloadBlob(new Blob([candlesCsv(s.candles, coin, s.interval)], { type: 'text/csv;charset=utf-8' }), `${coin.replace(/[^a-zA-Z0-9_-]/g, '_')}_${s.interval}.csv`)} />
                {s.candlesState === 'error' ? <div className="dhl-inline-error">{tr('K 线暂时不可用。切换周期可重试。', 'Chart data is unavailable. Change interval to retry.')}</div> : null}
              </div>
            </div>
          ) : (
            <div className="dhl-funding-panel" role="tabpanel">
              <div className="dhl-funding-summary">
                <span>{tr('当前小时资金费', 'Current hourly funding')}</span>
                <strong>{funding == null ? '—' : `${(funding * 100).toFixed(4)}%`}</strong>
                <span>{tr('最近 7 天 · 按小时结算', 'Last 7 days · hourly settlement')}</span>
              </div>
              {s.fundingState === 'loading' ? <div className="dhl-empty">{tr('正在读取资金费历史…', 'Loading funding history…')}</div> : null}
              {s.fundingState === 'error' ? <button type="button" className="dhl-ghost" onClick={() => void loadFunding()}>{tr('加载失败，重试', 'Load failed, retry')}</button> : null}
              {s.fundingState === 'ready' && s.fundingRows.length === 0 ? <div className="dhl-empty">{tr('暂无资金费记录', 'No funding records')}</div> : null}
              <div className="dhl-funding-list">
                {s.fundingRows.slice(-30).reverse().map((item) => {
                  const rate = Number(item.fundingRate) * 100
                  return <div className="dhl-funding-row" key={item.time}>
                    <time>{new Date(item.time).toLocaleString(tr('zh-CN', 'en-US'), { hour12: false })}</time>
                    <span className={rate >= 0 ? 'dhl-up' : 'dhl-down'}>{`${rate >= 0 ? '+' : ''}${rate.toFixed(5)}%`}</span>
                  </div>
                })}
              </div>
            </div>
          )}
        </section>
        <MarketTape snapshot={s.snapshot} />
      </div>
      <div className="dhl-desk-foot">
        <div className="dhl-banner">
          <span className="dhl-banner-signal" aria-hidden="true" />
          <span><b>{t('banner.title', '会话驱动交易')}</b> · {t('banner.body', '在右侧会话中讨论行情、风险与交易决策；盘口价格可用于辅助填写票据。')}</span>
        </div>
        <BottomTable account={s.account} accountError={s.accountError} />
      </div>
    </main>
  )
}
