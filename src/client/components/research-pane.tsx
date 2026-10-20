/** Independent candle feeds; scope guards discard responses from a previous market or network. */
import * as React from 'react'
import { CandleChart, type ChartLink } from './candle-chart'
import { hyperCall, tr } from '../remote'
import { insertChartReference, saveSessionWorkspace } from '../data'
import { useStore } from '../store'
import { Select } from './select'
import { chartTradeEvents, type TradeEvent } from '../trade-events'
import type { Candle, Interval, ChartMark } from '../types'
import type { IndicatorId } from '../chart-indicators'
import type { ChartType } from '../chart-basics'

export const RESEARCH_INTERVALS: Interval[] = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d', '3d', '1w', '1M']
const durations = [60_000, 180_000, 300_000, 900_000, 1800_000, 3600_000, 7200_000, 14400_000, 28800_000, 43200_000, 86400_000, 259200_000, 604800_000, 2678400_000]
const merge = (a: Candle[], b: Candle[]) => [...new Map([...a, ...b].filter((c) => Number.isFinite(c.t) && [c.o,c.h,c.l,c.c,c.v].every(Number.isFinite)).map((c) => [c.t, c])).values()].sort((a,b) => a.t-b.t).slice(-5000)
export function ResearchPane({ coin, interval, onInterval, indicators, marks, link, chartType, onAnalyzeFill }: { coin: string; interval: Interval; onInterval: (iv: Interval) => void; indicators: Set<IndicatorId>; marks: ChartMark[]; link: ChartLink; chartType: ChartType; onAnalyzeFill: (event: TradeEvent) => void }) {
  const s = useStore(), scope = `${s.activeSessionId}:${s.status?.network}:${coin}:${interval}`
  const [state, setState] = React.useState<{ scope: string; candles: Candle[]; error: string; older: 'idle' | 'loading' | 'done' | 'error'; at: number }>({ scope: '', candles: [], error: '', older: 'idle', at: 0 })
  const currentScope = React.useRef(scope); currentScope.current = scope
  const feed = state.scope === scope ? state : { scope, candles: [], error: '', older: 'idle' as const, at: 0 }
  React.useEffect(() => {
    let alive = true, busy = false
    setState({ scope, candles: [], error: '', older: 'idle', at: 0 })
    const load = async () => {
      if (busy || document.hidden) return
      busy = true
      try {
        const result = await hyperCall('candles', { coin, interval })
        if (alive) setState((old) => ({ ...old, scope, candles: merge(old.scope === scope ? old.candles : [], result.candles), error: '', at: Date.now() }))
      } catch (cause) { if (alive) setState((old) => ({ ...old, scope, error: String((cause as Error)?.message ?? cause) })) }
      finally { busy = false }
    }
    void load(); const timer = setInterval(() => void load(), 12_000)
    return () => { alive = false; clearInterval(timer) }
  }, [scope])
  const olderBusy = React.useRef(false)
  const needOlder = async () => {
    if (olderBusy.current || feed.older !== 'idle' || !feed.candles.length) return
    olderBusy.current = true
    setState((old) => ({ ...old, older: 'loading' }))
    try {
      const first = feed.candles[0].t
      const result = await hyperCall('candles', { coin, interval, endMs: first - 1, startMs: first - durations[RESEARCH_INTERVALS.indexOf(interval)] * 500 })
      if (currentScope.current === scope) setState((old) => {
        const rows = merge(result.candles, old.candles)
        return { ...old, candles: rows, older: !rows.length || rows[0].t >= first || rows.length >= 5000 ? 'done' : 'idle' }
      })
    } catch (cause) { if (currentScope.current === scope) setState((old) => ({ ...old, older: 'error', error: String((cause as Error)?.message ?? cause) })) }
    finally { olderBusy.current = false }
  }
  const layers = { orders: true, fills: true, reasons: false, ...s.workspace?.chartLayers }
  const events = React.useMemo(() => chartTradeEvents(feed.candles, coin, layers.orders ? s.tradeHistory?.orders ?? [] : [], layers.fills ? s.tradeHistory?.fills ?? [] : []), [feed.candles, s.tradeHistory, layers.orders, layers.fills, coin])
  return <section className="dhl-research-pane" aria-label={`${coin} ${interval} ${tr('研究图表', 'research chart')}`}>
    <header><b>{coin}</b><Select aria-label={tr('研究周期', 'Research interval')} value={interval} onChange={(e) => onInterval(e.target.value as Interval)}>{RESEARCH_INTERVALS.map((iv) => <option key={iv} value={iv}>{iv}</option>)}</Select><small>{feed.at ? `${tr('更新', 'Updated')} ${new Date(feed.at).toLocaleTimeString()}` : tr('加载中…', 'Loading…')}</small></header>
    <CandleChart key={scope} candles={feed.candles} marks={marks} indicators={indicators} expanded={false} compact readOnly resetToken={0} chartType={chartType} caption={`${coin} ${interval}`} link={link}
      indicatorSettings={s.workspace?.indicatorSettings} showDataWindow={s.workspace?.showDataWindow} maLines={s.workspace?.maLines ?? []} priceScale={s.workspace?.priceScale ?? 'normal'}
      visibleRange={s.workspace?.chartRanges?.[`${coin}:${interval}`] ?? null} onVisibleRange={(range) => saveSessionWorkspace({ chartRanges: { [`${coin}:${interval}`]: range } })}
      drawMode={null} onDraw={() => {}} onSelect={(selection) => insertChartReference(selection, coin, interval)} onNeedOlder={() => void needOlder()} olderState={feed.older}
      tradeEvents={events} showReasons={layers.fills && layers.reasons} onAnalyzeFill={onAnalyzeFill} magnet="off" drawingsLocked onEditMark={() => {}} onRemoveMark={() => {}} onCloneMark={() => {}} selectRequest={null} focus={null} />
    {feed.error ? <button type="button" className="dhl-inline-error" onClick={() => setState((old) => ({ ...old, older: 'idle' }))}>{feed.error} · {tr('自动重试中；点击重试历史', 'Retrying; click to retry history')}</button> : null}
  </section>
}
