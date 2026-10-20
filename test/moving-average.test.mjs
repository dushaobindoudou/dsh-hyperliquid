// Configurable moving averages: TradingView-equivalent math, validation, and the agent chart path.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { movingAverage, maSeries, maLatest, maLabel, normalizeMaLine, normalizeMaLines } from '../lib/moving-average.js'
import { HyperStore } from '../lib/store.js'
import { HyperRemote } from '../lib/remote.js'
import { buildToolDefinitions } from '../lib/tools.js'

const close = (n) => n.toFixed(10)
const xs = [1, 2, 3, 4, 5, 6]
// SMA 3: 2, 3, 4, 5
assert.deepEqual(movingAverage(xs, 'sma', 3).map((v) => v && close(v)), [null, null, close(2), close(3), close(4), close(5)])
// SMMA 3 (ta.rma): seed SMA(1,2,3)=2, then (prev*2 + x)/3
const smma = movingAverage(xs, 'smma', 3)
assert.equal(close(smma[2]), close(2)); assert.equal(close(smma[3]), close((2 * 2 + 4) / 3)); assert.equal(close(smma[5]), close(((((2 * 2 + 4) / 3) * 2 + 5) / 3 * 2 + 6) / 3))
// EMA 3 (ta.ema): alpha .5 after the SMA seed
const ema = movingAverage(xs, 'ema', 3)
assert.equal(close(ema[3]), close(.5 * 4 + .5 * 2)); assert.equal(close(ema[4]), close(.5 * 5 + .5 * 3))
// WMA 3: (1*a + 2*b + 3*c) / 6
assert.equal(close(movingAverage(xs, 'wma', 3)[2]), close((1 + 4 + 9) / 6))
// SMMA(n) is Wilder's smoothing: a constant series stays constant, and it lags EMA(n) on a trend
assert.ok(movingAverage([5, 5, 5, 5, 5], 'smma', 2).slice(1).every((v) => v === 5))
const trend = Array.from({ length: 60 }, (_, i) => 100 + i)
assert.ok(movingAverage(trend, 'smma', 14).at(-1) < movingAverage(trend, 'ema', 14).at(-1), 'smoothed MA is slower than EMA of the same length')

// Sources, smoothing, labels, ids
const candles = trend.map((c, i) => ({ t: i * 60_000, o: c - 1, h: c + 2, l: c - 2, c }))
const line = normalizeMaLine({ kind: 'SMMA', period: 7, source: 'hl2', smoothing: { kind: 'sma', period: 3 } })
assert.deepEqual(line, { id: 'smma7-hl2-sma3', kind: 'smma', period: 7, source: 'hl2', smoothing: { kind: 'sma', period: 3 } })
assert.equal(maLabel(line), 'SMMA 7 hl2 · SMA 3')
const { values, smoothed } = maSeries(candles, line)
assert.equal(values.findIndex((v) => v != null), 6)
assert.equal(smoothed.findIndex((v) => v != null), 8, 'smoothing starts once it has enough MA values')
assert.equal(close(smoothed[8]), close((values[6] + values[7] + values[8]) / 3))
assert.equal(maLatest(candles, [line])[0].value, values.at(-1))
for (const bad of [{ kind: 'hma', period: 9 }, { kind: 'sma', period: 0 }, { kind: 'sma', period: 2.5 }, { kind: 'sma', period: 501 }, { kind: 'sma', period: 9, source: 'vwap' }, { kind: 'sma', period: 9, color: 'red' }, { kind: 'sma', period: 9, smoothing: { kind: 'sma', period: 0 } }]) {
  assert.throws(() => normalizeMaLine(bad), /均线|平滑/)
}
assert.equal(normalizeMaLines([{ kind: 'sma', period: 9 }, { kind: 'sma', period: 9, color: '#ff0000' }]).length, 1, 'same definition de-duplicates')
assert.throws(() => normalizeMaLines(Array.from({ length: 9 }, (_, i) => ({ kind: 'sma', period: i + 1 }))), /最多/)

// Agent path: hyper_chart kind=ma → session workspace + event; list / remove; hyper_market reports values
const dir = mkdtempSync(join(tmpdir(), 'dhl-ma-'))
const store = new HyperStore(dir)
store.registerSession('s1', { coin: 'BTC' })
store.updateSessionWorkspace('s1', { interval: '1h' })
const remote = Object.create(HyperRemote.prototype)
remote.store = store
remote.desk = { coin: 'BTC', interval: '1h' }
const hourly = Array.from({ length: 120 }, (_, i) => ({ t: Date.now() - (121 - i) * 3600_000, o: 100 + i, h: 102 + i, l: 99 + i, c: 101 + i, v: 10 }))
remote.candles = async () => ({ candles: hourly })
const tools = buildToolDefinitions(remote)
const chart = tools.find((tool) => tool.name === 'hyper_chart')
const caller = { agent: { id: 's1' } }
const added = await chart.execute({ action: 'add', kind: 'ma', maType: 'smma', period: 21 }, caller)
assert.equal(added.line.id, 'smma21')
assert.match(added.text, /SMMA 21 = /)
assert.ok(Number.isFinite(added.value))
assert.equal(store.events.at(-1).kind, 'chart.ma')
await chart.execute({ action: 'add', kind: 'ma', maType: 'ema', period: 50, smoothingType: 'sma', smoothingPeriod: 9 }, caller)
assert.deepEqual(store.getSessionWorkspace('s1').maLines.map((row) => row.id), ['smma21', 'ema50-sma9'])
assert.deepEqual(new HyperStore(dir).getSessionWorkspace('s1').maLines.map((row) => row.id), ['smma21', 'ema50-sma9'], 'lines survive restart')
const listed = await chart.execute({ action: 'list' }, caller)
assert.match(listed.text, /smma21 SMMA 21/); assert.match(listed.text, /平滑 = /)
const market = tools.find((tool) => tool.name === 'hyper_market')
const report = await market.execute({ action: 'indicators', coin: 'BTC', interval: '1h' }, caller)
assert.match(report.text, /均线（最新已收盘）：SMMA 21=/, 'indicators include the session chart lines')
const adhoc = await market.execute({ action: 'indicators', coin: 'BTC', interval: '1h', ma: [{ kind: 'wma', period: 10 }] }, caller)
assert.equal(adhoc.ma[0].label, 'WMA 10')
await chart.execute({ action: 'remove', id: 'smma21' }, caller)
assert.deepEqual(store.getSessionWorkspace('s1').maLines.map((row) => row.id), ['ema50-sma9'])
await assert.rejects(chart.execute({ action: 'add', kind: 'ma', maType: 'smma', period: 0 }, caller), /周期/)
// The desk's own save path is validated the same way.
await assert.rejects(remote.updateSessionWorkspace({ sessionId: 's1', patch: { maLines: [{ kind: 'nope', period: 3 }] } }), /均线类型/)
console.log('均线（SMA/EMA/SMMA/WMA、价格源、平滑）计算、校验与 agent 图表叠加通过')
