import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HyperStore } from '../lib/store.js'
import { HyperRemote } from '../lib/remote.js'
import { computeIndicators } from '../lib/indicators.js'

async function load(entry) {
  const built = await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', write: false })
  return import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'))
}
const { chartBars, candlesCsv, candleIndex } = await load('src/client/chart-basics.ts')
const { chartIndicators } = await load('src/client/chart-indicators.ts')
const { selectChartCandle } = await load('src/client/chart-reference.ts')
const midnight = Date.UTC(2026, 9, 15)
const bars = Array.from({ length: 80 }, (_, i) => ({ t: midnight + i * 60_000, o: 100 + i, h: 103 + i, l: 98 + i, c: 102 + i, v: 10 + i }))
const ha = chartBars(bars, 'heikinAshi')
assert.equal(ha[0].o, 101)
assert.equal(ha[0].c, 100.75)
assert.equal(ha[1].o, 100.875)
assert.equal(ha[1].h, 104)
assert.equal(ha[1].l, 99)
assert.equal(bars[0].o, 100, 'synthetic chart must not mutate exchange prices')
assert.deepEqual(chartBars(bars, 'line'), bars)
assert.equal(candleIndex(bars, -1), 0)
assert.equal(candleIndex(bars, bars[15].t), 15)
assert.equal(candleIndex(bars, Infinity), 79)
assert.equal(candleIndex([], midnight), -1)
const csv = candlesCsv(bars.slice(0, 1), 'xyz:XYZ100', '1m')
assert.ok(csv.includes('time_utc,open,high,low,close,volume'))
assert.ok(csv.includes('"xyz:XYZ100","1m",2026-10-15T00:00:00.000Z,100,103,98,102,10'))
assert.ok(candlesCsv([], 'A"B', '1m').startsWith('\ufeff'))
const studies = chartIndicators(bars)
assert.equal(studies.atr14[0].time, bars[14].t / 1000)
assert.equal(studies.atr14[0].value, 5)
assert.equal(studies.atr14.at(-1).value, computeIndicators(bars).atr14, 'chart and agent use the same ATR seed/smoothing')
assert.equal(studies.vwap[0].value, (103 + 98 + 102) / 3)
const typical = (bar) => (bar.h + bar.l + bar.c) / 3
assert.ok(Math.abs(studies.vwap[1].value - (typical(bars[0]) * 10 + typical(bars[1]) * 11) / 21) < 1e-10)
const following = { ...bars[0], t: midnight + 86_400_000, c: 200, v: 4 }
assert.equal(chartIndicators([...bars, following]).vwap.at(-1).value, typical(following), 'VWAP resets at the UTC day boundary')
assert.equal(chartIndicators([...bars, { ...following, t: following.t + 9 * 3600_000 }]).vwap.at(-1).value, typical(following), 'a market closed at midnight starts VWAP at its first available bar')
assert.equal(chartIndicators(bars.slice(1)).vwap.length, 0, 'a partial first day must not masquerade as a complete session VWAP')
assert.equal(chartIndicators(bars.map((row) => ({ ...row, v: 0 }))).vwap.length, 0)
const quoted = selectChartCandle(bars, bars[30].t, new Set(['atr14', 'vwap']), 'vwap')
assert.equal(quoted.candle.o, bars[30].o)
assert.deepEqual(quoted.values.map((value) => value.label), ['ATR14', 'VWAP (UTC HLC3)'])
assert.equal(quoted.values[0].value, 5)

const dir = mkdtempSync(join(tmpdir(), 'dhl-basics-'))
try {
  const store = new HyperStore(dir); store.registerSession('a', { coin: 'BTC' }); store.registerSession('b', { coin: 'ETH' })
  const remote = Object.create(HyperRemote.prototype); remote.store = store
  await remote.updateSessionWorkspace({ sessionId: 'a', patch: { chartType: 'heikinAshi', indicators: ['volume', 'atr14', 'vwap'] } })
  const reopened = new HyperStore(dir)
  assert.equal(reopened.getSessionWorkspace('a').chartType, 'heikinAshi')
  assert.deepEqual(reopened.getSessionWorkspace('a').indicators, ['volume', 'atr14', 'vwap'])
  assert.equal(reopened.getSessionWorkspace('b').chartType, 'candles')
  await assert.rejects(remote.updateSessionWorkspace({ sessionId: 'a', patch: { chartType: 'renko' } }), /图表类型/)
} finally { rmSync(dir, { recursive: true, force: true }) }
console.log('基础图表：HA 不改原始行情、ATR/VWAP 数值和边界、CSV、点位引用与设置持久化通过')
