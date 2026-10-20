/** A chart click becomes an editable, time-addressed quote in the native composer. */
import type { Candle, Interval } from './types'
import type { IndicatorId } from './chart-indicators'
import { chartIndicators } from './chart-indicators'
import { studyDefinitions, type IndicatorSettings } from '../../lib/studies.js'
import { maLabel, maSeries, type MaLine } from '../../lib/moving-average.js'

export type ChartHit = IndicatorId | 'bollingerUpper' | 'bollingerLower' | 'macdSignal' | 'macdHistogram' | null

export interface ChartSelection {
  candle: Candle
  /** The indicator line or pane the pointer hit, when the chart identifies one. */
  hit: ChartHit
  /** Displayed studies at the selected candle, with no guessed values. */
  values: Array<{ label: string; value: number }>
  priorVolumeMean20: number | null
  settings?: IndicatorSettings
}

/** Match the chart's candles and study windows exactly. */
export function selectChartCandle(candles: Candle[], time: number, active: ReadonlySet<IndicatorId>, hit: ChartHit, maLines: readonly MaLine[] = [], settings?: IndicatorSettings): ChartSelection | null {
  const rows = candles
  const index = rows.findIndex((candle) => Math.floor(candle.t / 1000) === Math.floor(time / 1000))
  if (index < 0) return null
  const candle = rows[index]
  const studies = chartIndicators(rows, settings)
  const epoch = Math.floor(candle.t / 1000)
  const values = studyDefinitions(settings).flatMap(([id, key, label]) => {
    if (!active.has(id as IndicatorId)) return []
    const point = studies[key as keyof typeof studies].find((item) => item.time === epoch)
    return point ? [{ label, value: point.value }] : []
  })
  // Configurable MAs at the same candle (and their smoothing), exactly as drawn.
  for (const line of maLines) {
    const { values: series, smoothed } = maSeries(rows, line)
    if (series[index] != null) values.push({ label: maLabel(line).split(' · ')[0], value: series[index]! })
    if (smoothed?.[index] != null) values.push({ label: maLabel(line), value: smoothed[index]! })
  }
  const previous = rows.slice(Math.max(0, index - 20), index).map((row) => row.v).filter((value) => Number.isFinite(value) && value >= 0)
  const priorVolumeMean20 = previous.length === 20 ? previous.reduce((sum, value) => sum + value, 0) / 20 : null
  return { candle, hit, values, priorVolumeMean20, settings }
}

export function formatChartReference(selection: ChartSelection, coin: string, interval: Interval, english = false): string {
  const { candle, hit, values, priorVolumeMean20 } = selection
  const number = (value: number) => String(value)
  const computed = (value: number) => String(Number(value.toPrecision(10)))
  const time = new Date(candle.t).toISOString().replace('T', ' ').replace('.000Z', ' UTC')
  const hitLabel: Partial<Record<Exclude<ChartHit, null>, string>> = {
    volume: english ? 'Volume' : '成交量', sma20: 'SMA20', sma60: 'MA60', ema20: 'EMA20', ema50: 'EMA50',
    bollingerUpper: english ? 'BOLL upper' : 'BOLL上轨', bollingerLower: english ? 'BOLL lower' : 'BOLL下轨',
    rsi14: `RSI${selection.settings?.rsi.period ?? 14}`, macd: 'MACD', macdSignal: english ? 'MACD signal' : '信号线', macdHistogram: english ? 'MACD histogram' : 'MACD柱',
    atr14: 'ATR14', vwap: 'VWAP (UTC HLC3)', stochastic: 'Stochastic', adx: 'ADX / DMI', obv: 'OBV',
  }
  const lines = [
    english ? `[Chart point] ${coin} ${interval} candle opened ${time}` : `【图表点位】${coin} ${interval} K 线开盘 ${time}`,
    english ? `OHLC: ${number(candle.o)} / ${number(candle.h)} / ${number(candle.l)} / ${number(candle.c)}`
      : `开/高/低/收：${number(candle.o)} / ${number(candle.h)} / ${number(candle.l)} / ${number(candle.c)}`,
    english ? `Volume: ${number(candle.v)}` : `成交量：${number(candle.v)}`,
  ]
  if (priorVolumeMean20 != null && priorVolumeMean20 > 0) {
    lines.push(english
      ? `Previous 20-candle mean volume: ${computed(priorVolumeMean20)}; current/mean: ${(candle.v / priorVolumeMean20).toFixed(2)}x`
      : `前 20 根均量：${computed(priorVolumeMean20)}；当前/均量：${(candle.v / priorVolumeMean20).toFixed(2)} 倍`)
  }
  if (selection.settings) lines.push(`${english ? 'Study parameters' : '指标参数'}：${JSON.stringify(selection.settings)}`)
  if (values.some((row) => row.label === 'OBV')) lines.push(english ? 'OBV starts at zero on the first loaded candle; its absolute value depends on the window.' : 'OBV 以已加载首根为零点，绝对值取决于历史窗口。')
  if (values.length) lines.push(`${english ? 'Displayed studies' : '已显示指标'}：${values.map(({ label, value }) => `${label}=${computed(value)}`).join('，')}`)
  if (hit && hit !== 'volume') lines.push(`${english ? 'Selected study' : '点击指标'}：${hitLabel[hit] ?? hit}`)
  return lines.join('\n')
}

/** Composer reference-source name; the chip's model text comes from this source's codec. */
export const CHART_REFERENCE_SOURCE = 'hyperliquid-chart'

export interface ChartReferenceRef { coin: string; interval: Interval; t: number; text: string }

/** Short chip label, e.g. "BTC 15m 10-15 13:45 · C 81397". */
export function chartReferenceLabel(selection: ChartSelection, coin: string, interval: Interval): string {
  const d = new Date(selection.candle.t)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${coin} ${interval} ${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} · C ${selection.candle.c}`
}

/** The chip's ref carries everything needed to serialize it and to reopen the point on the chart. */
export function encodeChartReference(ref: ChartReferenceRef): string {
  return JSON.stringify(ref)
}

export function decodeChartReference(raw: string): ChartReferenceRef | null {
  try {
    const value = JSON.parse(raw)
    return typeof value?.text === 'string' && typeof value?.coin === 'string' && Number.isFinite(value?.t) ? value : null
  } catch { return null }
}
