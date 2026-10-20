/**
 * dsh-hyperliquid — configurable moving-average lines, shared by the host
 * (hyper_market / hyper_chart) and the browser chart so both compute the
 * exact same values.
 *
 * Definitions follow TradingView Pine:
 *   SMA   ta.sma   arithmetic mean of the last n values
 *   EMA   ta.ema   alpha = 2/(n+1), seeded with the SMA of the first n values
 *   SMMA  ta.rma   alpha = 1/n (Wilder / smoothed MA), seeded with the SMA
 *   WMA   ta.wma   linear weights n, n-1, …, 1 (newest heaviest)
 * An optional smoothing applies a second MA to the first line, like the
 * "Smoothing" setting of TradingView's moving-average indicators.
 * @module lib/moving-average
 */

export const MA_KINDS = ['sma', 'ema', 'smma', 'wma']
export const MA_SOURCES = ['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4']
export const MA_MAX_LINES = 8
export const MA_MAX_PERIOD = 500
const COLOR = /^#[0-9a-fA-F]{6}$/

/**
 * Validate and canonicalize one line definition (throws on invalid input).
 * @param {object} input - { kind, period, source?, smoothing?: { kind, period }, color? }
 * @returns {{ id: string, kind: string, period: number, source: string, smoothing: { kind: string, period: number } | null, color?: string }}
 */
export function normalizeMaLine(input) {
  if (!input || typeof input !== 'object') throw new Error('均线定义无效')
  const kind = String(input.kind ?? '').toLowerCase()
  if (!MA_KINDS.includes(kind)) throw new Error(`均线类型必须为 ${MA_KINDS.join('/')}`)
  const period = Number(input.period)
  if (!Number.isInteger(period) || period < 1 || period > MA_MAX_PERIOD) throw new Error(`均线周期必须为 1-${MA_MAX_PERIOD} 的整数`)
  const source = String(input.source ?? 'close').toLowerCase()
  if (!MA_SOURCES.includes(source)) throw new Error(`均线价格源必须为 ${MA_SOURCES.join('/')}`)
  let smoothing = null
  if (input.smoothing != null) {
    const sKind = String(input.smoothing.kind ?? '').toLowerCase()
    const sPeriod = Number(input.smoothing.period)
    if (!MA_KINDS.includes(sKind)) throw new Error(`平滑类型必须为 ${MA_KINDS.join('/')}`)
    if (!Number.isInteger(sPeriod) || sPeriod < 1 || sPeriod > MA_MAX_PERIOD) throw new Error(`平滑周期必须为 1-${MA_MAX_PERIOD} 的整数`)
    smoothing = { kind: sKind, period: sPeriod }
  }
  const id = `${kind}${period}${source === 'close' ? '' : '-' + source}${smoothing ? `-${smoothing.kind}${smoothing.period}` : ''}`
  const line = { id, kind, period, source, smoothing }
  if (input.color != null) {
    if (typeof input.color !== 'string' || !COLOR.test(input.color)) throw new Error('均线颜色必须为 #RRGGBB')
    line.color = input.color.toLowerCase()
  }
  return line
}

/** Validate a whole set: at most MA_MAX_LINES, de-duplicated by id (last definition wins its slot). */
export function normalizeMaLines(list) {
  if (!Array.isArray(list)) throw new Error('均线列表无效')
  const byId = new Map()
  for (const item of list) { const line = normalizeMaLine(item); byId.set(line.id, line) }
  if (byId.size > MA_MAX_LINES) throw new Error(`最多同时显示 ${MA_MAX_LINES} 条均线`)
  return [...byId.values()]
}

/** "SMMA 7", "EMA 21 hl2", "SMA 20 · EMA 9". */
export function maLabel(line) {
  return `${line.kind.toUpperCase()} ${line.period}${line.source === 'close' ? '' : ' ' + line.source}${line.smoothing ? ` · ${line.smoothing.kind.toUpperCase()} ${line.smoothing.period}` : ''}`
}

function sourceOf(candle, source) {
  const o = Number(candle.o), h = Number(candle.h), l = Number(candle.l), c = Number(candle.c)
  switch (source) {
    case 'open': return o
    case 'high': return h
    case 'low': return l
    case 'hl2': return (h + l) / 2
    case 'hlc3': return (h + l + c) / 3
    case 'ohlc4': return (o + h + l + c) / 4
    default: return c
  }
}

/**
 * One MA over a series that may start with nulls (e.g. the input of a smoothing pass).
 * @param {Array<number|null>} values
 * @param {string} kind
 * @param {number} period
 * @returns {Array<number|null>} aligned with `values`; null until enough data.
 */
export function movingAverage(values, kind, period) {
  const out = new Array(values.length).fill(null)
  const window = []
  let prior = null
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i]
    if (value == null || !Number.isFinite(value)) { if (kind === 'sma' || kind === 'wma') window.length = 0; continue }
    if (kind === 'sma' || kind === 'wma') {
      window.push(value)
      if (window.length > period) window.shift()
      if (window.length < period) continue
      if (kind === 'sma') out[i] = window.reduce((sum, v) => sum + v, 0) / period
      else { let num = 0; for (let k = 0; k < period; k += 1) num += window[k] * (k + 1); out[i] = num / (period * (period + 1) / 2) }
      continue
    }
    // ema / smma: seed with the SMA of the first `period` values, then recurse.
    if (prior == null) {
      window.push(value)
      if (window.length < period) continue
      prior = window.reduce((sum, v) => sum + v, 0) / period
    } else {
      const alpha = kind === 'ema' ? 2 / (period + 1) : 1 / period
      prior = alpha * value + (1 - alpha) * prior
    }
    out[i] = prior
  }
  return out
}

/**
 * Values of one normalized line over candles (ascending by time).
 * @returns {{ values: Array<number|null>, smoothed: Array<number|null> | null }}
 */
export function maSeries(candles, line) {
  const input = candles.map((candle) => { const v = sourceOf(candle, line.source); return Number.isFinite(v) ? v : null })
  const values = movingAverage(input, line.kind, line.period)
  const smoothed = line.smoothing ? movingAverage(values, line.smoothing.kind, line.smoothing.period) : null
  return { values, smoothed }
}

/** Latest defined value of each line (and its smoothing) — what the agent reads. */
export function maLatest(candles, lines) {
  return lines.map((line) => {
    const { values, smoothed } = maSeries(candles, line)
    const last = (series) => { for (let i = series.length - 1; i >= 0; i -= 1) if (series[i] != null) return series[i]; return null }
    return { id: line.id, label: maLabel(line), value: last(values), smoothed: smoothed ? last(smoothed) : null, line }
  })
}
