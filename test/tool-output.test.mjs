// DSH rejects tool output that is not lossless JSON ("value is not lossless JSON"). Regression: after a
// style was cleared (null → undefined) or an alert re-armed, hyper_chart list/update returned undefined fields.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HyperStore } from '../lib/store.js'
import { HyperRemote } from '../lib/remote.js'
import { buildToolDefinitions, losslessJson } from '../lib/tools.js'

const problems = (value) => {
  const bad = []
  const walk = (item, path) => {
    if (item === undefined) bad.push(`${path} is undefined`)
    else if (typeof item === 'number' && !Number.isFinite(item)) bad.push(`${path} is ${item}`)
    else if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) walk(child, `${path}.${key}`)
  }
  walk(value, 'output')
  return bad
}

assert.deepEqual(losslessJson({ a: undefined, b: NaN, c: [1, Infinity], d: { e: undefined, f: 'x' } }), { b: null, c: [1, null], d: { f: 'x' } })

const store = new HyperStore(mkdtempSync(join(tmpdir(), 'dhl-tool-output-')))
store.registerSession('s', { coin: 'HYPE' })
const remote = Object.create(HyperRemote.prototype)
Object.assign(remote, { store, desk: { coin: 'HYPE', interval: '1h' }, alertSides: new Map() })
remote.candles = async () => ({ candles: [] })
const chart = buildToolDefinitions(remote).find((tool) => tool.name === 'hyper_chart')
const exec = { agent: { id: 's' } }
const added = await chart.execute({ action: 'add', kind: 'level', label: '支撑', price: 40 }, exec)
await remote.updateChartMark({ sessionId: 's', id: added.mark.id, patch: { color: '#ef5f6c', lineWidth: 3 } })
await remote.updateChartMark({ sessionId: 's', id: added.mark.id, patch: { color: null, lineWidth: null, alert: true } })
assert.ok(!('color' in store.getChartMark('s', added.mark.id)), 'cleared fields are removed, not left as undefined')
for (const args of [{ action: 'update', id: added.mark.id, label: '新支撑' }, { action: 'list' }, { action: 'update', id: added.mark.id, alert: false },
  { action: 'add', kind: 'ma', maType: 'smma', period: 7 }, { action: 'list' }, { action: 'remove', id: added.mark.id }]) {
  const output = await chart.execute(args, exec)
  assert.deepEqual(problems(output), [], `hyper_chart ${args.action} returns lossless JSON`)
}
const view = await chart.execute({ action: 'view', interval: '4h', show: ['rsi14', 'macd'] }, exec)
assert.equal(view.interval, '4h'); assert.ok(view.indicators.includes('rsi14') && view.indicators.includes('macd'))
assert.equal(store.getSessionWorkspace('s').interval, '4h', 'the session chart switches interval')
assert.equal(remote.desk.interval, '1h', 'a session that is not on the desk leaves the desk interval alone')
const hidden = await chart.execute({ action: 'view', hide: ['macd'] }, exec)
assert.ok(!hidden.indicators.includes('macd') && hidden.indicators.includes('rsi14'))
await assert.rejects(chart.execute({ action: 'view', show: ['rsi'] }, exec), /未知指标 rsi/)
// A volume profile whose market request fails must not leave a saved drawing behind (the agent would retry and duplicate it).
const countMarks = async () => (await remote.chartMarks({ sessionId: 's', coin: 'HYPE', allIntervals: true })).marks.length
const beforeFail = await countMarks()
remote.candles = async () => { throw new Error('行情超时') }
const t0 = Date.now() - 10 * 3600_000
await assert.rejects(chart.execute({ action: 'add', kind: 'vprofile', label: 'VP', points: [{ time: t0, price: 1 }, { time: t0 + 5 * 3600_000, price: 1 }] }, exec), /行情超时/)
assert.equal(await countMarks(), beforeFail, 'nothing is saved when the candles request fails')
// The session chart is on 4h here (set by the view call above): a 6h hole before the first bar is a missing bar.
remote.candles = async () => ({ candles: [6, 7, 8].map((i) => ({ t: t0 + i * 3600_000, o: 10, h: 12, l: 9, c: 11, v: 100 })) })
const vp = await chart.execute({ action: 'add', kind: 'vprofile', label: 'VP', points: [{ time: t0 + 9 * 3600_000, price: 1 }, { time: t0, price: 1 }] }, exec)
assert.ok(vp.profile.partial && /区间前段缺失/.test(vp.text) && /K 线估算/.test(vp.text), vp.text)
assert.deepEqual(problems(vp), [], 'vprofile output is lossless JSON')
await assert.rejects(chart.execute({ action: 'add', kind: 'vprofile', label: 'VP', rows: 6.5, points: [{ time: t0, price: 1 }, { time: t0 + 9 * 3600_000, price: 1 }] }, exec), /6-200/, 'rows are validated before any computation')
// exactly the first 4h bar missing is still a gap
remote.candles = async () => ({ candles: [4, 8].map((i) => ({ t: t0 + i * 3600_000, o: 10, h: 12, l: 9, c: 11, v: 100 })) })
assert.equal((await chart.execute({ action: 'add', kind: 'vprofile', label: 'VP2', points: [{ time: t0, price: 1 }, { time: t0 + 9 * 3600_000, price: 1 }] }, exec)).profile.partial, true, 'a range missing exactly its first bar is flagged')
console.log('hyper_* 工具输出均为无损 JSON（清除样式、重新开启提醒后 list/update 不再报错）')
