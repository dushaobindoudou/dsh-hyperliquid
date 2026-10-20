/** Deterministic indicators over exchange candles; no price prediction. */

function sma(values, period) {
  if (values.length < period) return null
  return values.slice(-period).reduce((sum, value) => sum + value, 0) / period
}

function emaSeries(values, period) {
  if (values.length < period) return []
  const alpha = 2 / (period + 1)
  let value = values.slice(0, period).reduce((sum, point) => sum + point, 0) / period
  const result = [value]
  for (const point of values.slice(period)) {
    value = point * alpha + value * (1 - alpha)
    result.push(value)
  }
  return result
}

function wilder(values, period) {
  if (values.length < period) return null
  let result = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period
  for (const value of values.slice(period)) result = (result * (period - 1) + value) / period
  return result
}

function swings(rows, kind) {
  const picks = []
  for (let i = 2; i < rows.length - 2; i += 1) {
    const field = kind === 'low' ? 'l' : 'h'
    const value = rows[i][field]
    const neighbors = [rows[i - 2][field], rows[i - 1][field], rows[i + 1][field], rows[i + 2][field]]
    if (neighbors.every((point) => kind === 'low' ? value <= point : value >= point)) picks.push({ price: value, time: rows[i].t })
  }
  return picks
}

function closeTime(row, interval) {
  if (Number.isFinite(Number(row.T)) && Number(row.T) >= row.t) return Number(row.T)
  if (interval === '1M') {
    const opened = new Date(row.t)
    return Date.UTC(opened.getUTCFullYear(), opened.getUTCMonth() + 1, 1) - 1
  }
  const minutes = { '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '2h': 120,
    '4h': 240, '8h': 480, '12h': 720, '1d': 1440, '3d': 4320, '1w': 10080 }[interval]
  return minutes ? row.t + minutes * 60_000 - 1 : row.t
}

/** Valid, de-duplicated, ascending candles split into closed rows and the count of still-forming ones. */
export function closedCandles(candles, { now = Date.now(), interval } = {}) {
  const valid = (candles ?? []).map((c) => ({ t: Number(c.t), T: c.T, o: Number(c.o), h: Number(c.h), l: Number(c.l), c: Number(c.c), v: Number(c.v) }))
    .filter((c) => [c.t, c.o, c.h, c.l, c.c, c.v].every(Number.isFinite) && c.t > 0 && c.h >= c.l && c.c > 0)
    .sort((a, b) => a.t - b.t)
  const unique = [...new Map(valid.map((row) => [row.t, row])).values()]
  const rows = unique.filter((row) => closeTime(row, interval) < now)
  return { rows, excludedOpen: unique.length - rows.length, closeTime: (row) => closeTime(row, interval) }
}

export function computeIndicators(candles, { now = Date.now(), interval } = {}) {
  const { rows, excludedOpen } = closedCandles(candles, { now, interval })
  if (rows.length < 50) return { ready: false, candlesUsed: rows.length, excludedOpen, reason: '至少需要 50 根已收盘的有效 K 线' }
  const close = rows.map((c) => c.c)
  const volume = rows.map((c) => c.v)
  const ema12 = emaSeries(close, 12)
  const ema26 = emaSeries(close, 26)
  const macdLine = ema12.slice(14).map((value, i) => value - ema26[i])
  const signal = emaSeries(macdLine, 9)
  const deltas = close.slice(1).map((value, i) => value - close[i])
  const avgGain = wilder(deltas.map((value) => Math.max(value, 0)), 14)
  const avgLoss = wilder(deltas.map((value) => Math.max(-value, 0)), 14)
  const rsi = avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss)
  const trueRanges = rows.slice(1).map((c, i) => Math.max(c.h - c.l, Math.abs(c.h - rows[i].c), Math.abs(c.l - rows[i].c)))
  const atr14 = wilder(trueRanges, 14)
  const close20 = close.slice(-20)
  const mean20 = sma(close, 20)
  const deviation = Math.sqrt(close20.reduce((sum, value) => sum + (value - mean20) ** 2, 0) / 20)
  const latest = rows.at(-1)
  const recent = rows.slice(-100)
  const supportFallback = rows.slice(-20).reduce((best, row) => row.l < best.l ? row : best)
  const resistanceFallback = rows.slice(-20).reduce((best, row) => row.h > best.h ? row : best)
  const support = swings(recent, 'low').filter((point) => point.price < latest.c).sort((a, b) => b.price - a.price)[0]
    ?? { price: supportFallback.l, time: supportFallback.t }
  const resistance = swings(recent, 'high').filter((point) => point.price > latest.c).sort((a, b) => a.price - b.price)[0]
    ?? { price: resistanceFallback.h, time: resistanceFallback.t }
  return {
    ready: true, candlesUsed: rows.length, excludedOpen, observedAt: closeTime(latest, interval), candleOpenedAt: latest.t, close: latest.c,
    sma20: mean20, ema20: emaSeries(close, 20).at(-1), ema50: emaSeries(close, 50).at(-1),
    rsi14: rsi, macd: { line: macdLine.at(-1), signal: signal.at(-1), histogram: macdLine.at(-1) - signal.at(-1) },
    bollinger20: { lower: mean20 - 2 * deviation, middle: mean20, upper: mean20 + 2 * deviation },
    atr14, volumeRatio20: latest.v / (sma(volume.slice(0, -1), 20) || 1),
    support, resistance,
  }
}
