import assert from 'node:assert/strict'
import { computeIndicators } from '../lib/indicators.js'

const candles = (direction) => Array.from({ length: 80 }, (_, i) => {
  const close = direction === 'up' ? i + 1 : direction === 'down' ? 80 - i : 42
  return { t: 1_700_000_000_000 + i * 3_600_000, o: close, h: close + 1, l: close - 1, c: close, v: 100 + i }
})

assert.equal(computeIndicators(candles('up').slice(0, 49)).ready, false)
const up = computeIndicators(candles('up'))
assert.equal(up.ready, true)
assert.equal(up.sma20, 70.5)
assert.equal(up.rsi14, 100)
assert.ok(up.macd.line > 0 && Number.isFinite(up.macd.histogram))
assert.equal(up.atr14, 2)
assert.ok(up.support.price < up.close)
assert.ok(up.resistance.price >= up.close)
assert.equal(up.support.time, candles('up')[60].t, 'fallback support points to the candle that set the low')
assert.equal(up.resistance.time, candles('up')[79].t, 'fallback resistance points to the candle that set the high')
assert.ok(up.bollinger20.lower < up.sma20 && up.bollinger20.upper > up.sma20)
const down = computeIndicators(candles('down'))
assert.equal(down.rsi14, 0)
assert.ok(down.macd.line < 0)
assert.equal(computeIndicators(candles('flat')).rsi14, 50)
const base = candles('flat').slice(0, 60)
const partial = { ...base.at(-1), c: 9000, h: 9001, v: 1_000_000 }
const now = partial.t + 30 * 60_000
const confirmed = computeIndicators(base.slice(0, -1), { interval: '1h', now })
const withPartial = computeIndicators([...base.slice(0, -1), partial], { interval: '1h', now })
assert.equal(withPartial.excludedOpen, 1)
assert.equal(withPartial.candlesUsed, 59)
assert.equal(withPartial.close, confirmed.close, 'forming candle must not move confirmed indicators')
assert.equal(withPartial.volumeRatio20, confirmed.volumeRatio20)
assert.equal(withPartial.observedAt, base.at(-2).t + 3_600_000 - 1)
assert.equal(computeIndicators([...base.slice(0, 49), partial], { interval: '1h', now }).ready, false)
const explicitClose = computeIndicators([{ ...partial, t: now - 7_200_000, T: now - 3_600_001 }, ...base.slice(0, 59)], { interval: '1h', now })
assert.equal(explicitClose.ready, true, 'official T close timestamp is accepted')
console.log('SMA/EMA、RSI、MACD、布林带、ATR 与支撑阻力指标通过')
