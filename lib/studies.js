/** Shared chart/agent study definitions. All values are derived from the supplied candle window. */
export const INDICATOR_IDS = ['volume', 'sma20', 'sma60', 'ema20', 'ema50', 'bollinger20', 'rsi14', 'macd', 'atr14', 'vwap', 'stochastic', 'adx', 'obv']
export const DEFAULT_INDICATOR_SETTINGS = {
  rsi: { period: 14, lower: 30, upper: 70 }, macd: { fast: 12, slow: 26, signal: 9 },
  bollinger: { period: 20, multiplier: 2 }, stochastic: { period: 14, smoothK: 3, smoothD: 3, lower: 20, upper: 80 },
  adx: { period: 14, smoothing: 14 },
}
export function normalizeIndicatorSettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !Object.hasOwn(DEFAULT_INDICATOR_SETTINGS, key))) throw Error('指标参数无效')
  const result = {}
  for (const [section, defaults] of Object.entries(DEFAULT_INDICATOR_SETTINGS)) {
    const supplied = input[section] ?? {}
    if (typeof supplied !== 'object' || Array.isArray(supplied) || Object.keys(supplied).some((key) => !Object.hasOwn(defaults, key))) throw Error('指标参数字段无效')
    const values = { ...defaults, ...supplied }
    for (const [key, value] of Object.entries(values)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw Error(`${section}.${key} 必须为数值`)
      if (key === 'multiplier') { if (value <= 0 || value > 10) throw Error('布林带倍数必须大于 0 且不超过 10') }
      else if (key === 'lower' || key === 'upper') { if (value < 0 || value > 100) throw Error('指标阈值必须为 0–100') }
      else if (!Number.isInteger(value) || value < 1 || value > 500) throw Error('指标周期必须为 1–500 的整数')
    }
    if ('lower' in values && values.lower >= values.upper) throw Error('指标下阈值必须小于上阈值')
    result[section] = values
  }
  if (result.macd.fast >= result.macd.slow) throw Error('MACD 快线周期必须小于慢线周期')
  return result
}
function nullableSma(values, period) {
  return values.map((_, i) => {
    if (i < period - 1) return null
    const window = values.slice(i - period + 1, i + 1)
    return window.some((value) => value == null) ? null : window.reduce((sum, value) => sum + value, 0) / period
  })
}
function rma(values, period) {
  let prior = null, seed = []
  return values.map((value) => {
    if (value == null) return null
    if (prior == null) { seed.push(value); if (seed.length < period) return null; prior = seed.reduce((sum, item) => sum + item, 0) / period }
    else prior = (prior * (period - 1) + value) / period
    return prior
  })
}
export function studyDefinitions(input) {
  const p = normalizeIndicatorSettings(input)
  return [
    ['sma20', 'sma20', 'SMA20'], ['sma60', 'sma60', 'MA60'], ['ema20', 'ema20', 'EMA20'], ['ema50', 'ema50', 'EMA50'],
    ['bollinger20', 'basis', `BOLL ${p.bollinger.period} × ${p.bollinger.multiplier}`], ['bollinger20', 'upper', 'BOLL upper'], ['bollinger20', 'lower', 'BOLL lower'],
    ['rsi14', 'rsi14', `RSI${p.rsi.period}`], ['macd', 'macd', p.macd.fast === 12 && p.macd.slow === 26 && p.macd.signal === 9 ? 'MACD' : `MACD ${p.macd.fast}/${p.macd.slow}/${p.macd.signal}`], ['macd', 'signal', 'Signal'], ['macd', 'histogram', 'Hist'],
    ['atr14', 'atr14', 'ATR14'], ['vwap', 'vwap', 'VWAP (UTC HLC3)'], ['stochastic', 'stochK', `Stoch %K ${p.stochastic.period}/${p.stochastic.smoothK}`], ['stochastic', 'stochD', `Stoch %D ${p.stochastic.smoothD}`],
    ['adx', 'adx', `ADX ${p.adx.period}/${p.adx.smoothing}`], ['adx', 'plusDI', '+DI'], ['adx', 'minusDI', '-DI'], ['obv', 'obv', 'OBV'],
  ]
}
function points(rows, values) {
  return values.flatMap((value, index) => value == null || !Number.isFinite(value)
    ? [] : [{ time: Math.floor(rows[index].t / 1000), value }])
}

function sma(values, period) {
  let sum = 0
  return values.map((value, index) => {
    sum += value
    if (index >= period) sum -= values[index - period]
    return index >= period - 1 ? sum / period : null
  })
}

function ema(values, period) {
  const result = Array(values.length).fill(null)
  const alpha = 2 / (period + 1)
  let seed = []
  let prior = null
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i]
    if (value == null) continue
    if (prior == null) {
      seed.push(value)
      if (seed.length < period) continue
      prior = seed.reduce((total, current) => total + current, 0) / period
    } else prior = value * alpha + prior * (1 - alpha)
    result[i] = prior
  }
  return result
}

export function computeStudies(candles, input) {
  const settings = normalizeIndicatorSettings(input)
  const rows = candles.filter((row) => Number.isFinite(row.c) && row.c > 0 && Number.isFinite(row.t))
  const closes = rows.map((row) => row.c)
  const mean = sma(closes, settings.bollinger.period)
  const ema12 = ema(closes, settings.macd.fast)
  const ema26 = ema(closes, settings.macd.slow)
  const macd = ema12.map((value, index) => value == null || ema26[index] == null ? null : value - ema26[index])
  const signal = ema(macd, settings.macd.signal)
  const deviation = mean.map((value, index) => value == null ? null : Math.sqrt(
    closes.slice(index - settings.bollinger.period + 1, index + 1).reduce((total, close) => total + (close - value) ** 2, 0) / settings.bollinger.period,
  ))
  const rsi = Array(rows.length).fill(null)
  let gain = 0; let loss = 0
  for (let i = 1; i < rows.length; i += 1) {
    const delta = closes[i] - closes[i - 1]
    const up = Math.max(delta, 0); const down = Math.max(-delta, 0)
    if (i <= settings.rsi.period) { gain += up; loss += down }
    else { gain = (gain * (settings.rsi.period - 1) + up) / settings.rsi.period; loss = (loss * (settings.rsi.period - 1) + down) / settings.rsi.period }
    if (i === settings.rsi.period) { gain /= settings.rsi.period; loss /= settings.rsi.period }
    if (i >= settings.rsi.period) rsi[i] = loss === 0 ? gain === 0 ? 50 : 100 : 100 - 100 / (1 + gain / loss)
  }
  const point = (values) => points(rows, values)
  const atr = Array(rows.length).fill(null)
  let rangeSum = 0
  for (let i = 1; i < rows.length; i += 1) {
    const range = Math.max(rows[i].h - rows[i].l, Math.abs(rows[i].h - rows[i - 1].c), Math.abs(rows[i].l - rows[i - 1].c))
    if (i <= 14) rangeSum += range
    if (i === 14) atr[i] = rangeSum / 14
    if (i > 14) atr[i] = (atr[i - 1] * 13 + range) / 14
  }
  // UTC sessions, HLC3 weighted by base volume. A partial first day is omitted.
  let day = -1, weighted = 0, volume = 0, complete = false
  const vwap = rows.map((row) => {
    const nextDay = Math.floor(row.t / 86_400_000)
    if (nextDay !== day) {
      // After the first observed day, the exchange can legitimately skip empty
      // midnight bars (e.g. closed HIP-3 markets); the next available bar starts it.
      complete = day >= 0 || row.t % 86_400_000 === 0
      day = nextDay; weighted = 0; volume = 0
    }
    if (!Number.isFinite(row.v) || row.v < 0) return null
    weighted += (row.h + row.l + row.c) / 3 * row.v
    volume += row.v
    return complete && volume > 0 ? weighted / volume : null
  })
  const rawK = rows.map((row, index) => {
    if (index < settings.stochastic.period - 1) return null
    const window = rows.slice(index - settings.stochastic.period + 1, index + 1)
    const low = Math.min(...window.map((bar) => bar.l)), high = Math.max(...window.map((bar) => bar.h))
    return high === low ? null : 100 * (row.c - low) / (high - low)
  })
  const stochK = nullableSma(rawK, settings.stochastic.smoothK)
  const stochD = nullableSma(stochK, settings.stochastic.smoothD)
  const tr = rows.map((row, i) => i === 0 ? null : Math.max(row.h - row.l, Math.abs(row.h - rows[i - 1].c), Math.abs(row.l - rows[i - 1].c)))
  const plus = rows.map((row, i) => { if (!i) return null; const up = row.h - rows[i - 1].h, down = rows[i - 1].l - row.l; return up > down && up > 0 ? up : 0 })
  const minus = rows.map((row, i) => { if (!i) return null; const up = row.h - rows[i - 1].h, down = rows[i - 1].l - row.l; return down > up && down > 0 ? down : 0 })
  const atrDm = rma(tr, settings.adx.period), plusRma = rma(plus, settings.adx.period), minusRma = rma(minus, settings.adx.period)
  const di = (values) => values.map((value, i) => value == null || atrDm[i] == null ? null : atrDm[i] === 0 ? 0 : 100 * value / atrDm[i])
  const plusDI = di(plusRma), minusDI = di(minusRma)
  const dx = plusDI.map((value, i) => value == null || minusDI[i] == null ? null : value + minusDI[i] === 0 ? 0 : 100 * Math.abs(value - minusDI[i]) / (value + minusDI[i]))
  let balance = 0
  const obv = rows.map((row, i) => { if (i) balance += Math.sign(row.c - rows[i - 1].c) * row.v; return balance })
  return {
    stochK: point(stochK), stochD: point(stochD), adx: point(rma(dx, settings.adx.smoothing)), plusDI: point(plusDI), minusDI: point(minusDI), obv: point(obv),
    sma20: point(sma(closes, 20)), basis: point(mean), sma60: point(sma(closes, 60)), ema20: point(ema(closes, 20)), ema50: point(ema(closes, 50)),
    upper: point(mean.map((value, index) => value == null ? null : value + settings.bollinger.multiplier * deviation[index])),
    lower: point(mean.map((value, index) => value == null ? null : value - settings.bollinger.multiplier * deviation[index])),
    rsi14: point(rsi), macd: point(macd), signal: point(signal),
    histogram: point(macd.map((value, index) => value == null || signal[index] == null ? null : value - signal[index])),
    atr14: point(atr), vwap: point(vwap),
  }
}
