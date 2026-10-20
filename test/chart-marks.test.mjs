import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HyperStore } from '../lib/store.js'
import { HyperRemote } from '../lib/remote.js'
import { buildToolDefinitions } from '../lib/tools.js'

const dir = mkdtempSync(join(tmpdir(), 'dhl-chart-'))
const store = new HyperStore(dir)
store.registerSession('session-1', { coin: 'BTC' })
store.updateSessionWorkspace('session-1', { interval: '1h' })
store.registerSession('session-2', { coin: 'ETH' })
const remote = Object.create(HyperRemote.prototype)
remote.store = store
remote.desk = { coin: 'BTC', interval: '1h' }
const chart = buildToolDefinitions(remote).find((tool) => tool.name === 'hyper_chart')
const caller = { agent: { id: 'session-1' } }

const added = await chart.execute({ action: 'add', kind: 'level', role: 'support', label: '近 20 根支撑', price: 100 }, caller)
assert.equal(added.mark.sessionId, 'session-1')
assert.equal(added.mark.coin, 'BTC')
assert.equal(added.mark.interval, '1h')
assert.equal(store.events.at(-1).kind, 'chart.mark')
assert.equal((await chart.execute({ action: 'list' }, caller)).marks.length, 1)
assert.equal((await remote.chartMarks({ sessionId: 'session-1', coin: 'BTC', allIntervals: true })).marks.length, 1)
store.updateSessionWorkspace('session-1', { interval: '15m' })
assert.equal((await chart.execute({ action: 'list' }, caller)).marks[0].interval, '1h', 'a mark remains visible across chart intervals')
assert.equal(new HyperStore(dir).listChartMarks('session-1', 'BTC', '1h').length, 1, 'marks survive restart')
await assert.rejects(chart.execute({ action: 'add', kind: 'level', label: 'bad', price: -1 }, caller), /price/)
await assert.rejects(chart.execute({ action: 'remove', id: added.mark.id }, { agent: { id: 'session-2' } }), /不存在|不属于/)
await chart.execute({ action: 'remove', id: added.mark.id }, caller)
assert.equal(store.listChartMarks('session-1', 'BTC', '1h').length, 0)

// Session-owned settings and generated annotations have separate files.
const one = store.sessionDirectory('session-1')
const two = store.sessionDirectory('session-2')
assert.notEqual(one, two)
assert.ok(one.startsWith(join(dir, 'sessions')))
await remote.updateSessionWorkspace({ sessionId: 'session-1', patch: {
  interval: '5m', indicators: ['volume', 'rsi14'], priceScale: 'log',
  tapeTab: 'trades', bottomTab: 'orders',
  layout: { chatWidth: 560 }, chartRanges: { 'BTC:5m': { from: 1_700_000_000, to: 1_700_010_000 } },
} })
assert.equal((await remote.sessionWorkspace({ sessionId: 'session-1' })).layout.chatWidth, 560)
assert.equal((await remote.sessionWorkspace({ sessionId: 'session-2' })).layout.chatWidth, 480)
assert.equal((await remote.sessionWorkspace({ sessionId: 'session-2' })).interval, '15m')
assert.equal((await remote.sessionWorkspace({ sessionId: 'session-2' })).tapeTab, 'book')
assert.equal((await remote.sessionWorkspace({ sessionId: 'session-2' })).bottomTab, 'positions')
const userMark = await remote.drawChartMark({ sessionId: 'session-2', coin: 'ETH', interval: '15m', kind: 'level', price: 2200, label: '手动线' })
assert.equal(userMark.source, 'user')
assert.equal(store.listChartMarks('session-1', 'ETH', '15m').length, 0)
assert.equal(JSON.parse(readFileSync(join(two, 'chart-marks.json'), 'utf8'))[0].sessionId, 'session-2')
assert.equal(JSON.parse(readFileSync(join(one, 'workspace.json'), 'utf8')).priceScale, 'log')
const restarted = new HyperStore(dir)
assert.deepEqual(restarted.getSessionWorkspace('session-1').indicators, ['volume', 'rsi14'])
assert.equal(restarted.listChartMarks('session-2', 'ETH', '15m').length, 1)
await assert.rejects(remote.updateSessionWorkspace({ sessionId: 'session-1', patch: { indicators: ['fake'] } }), /指标/)
await remote.eraseChartMark({ sessionId: 'session-2', id: userMark.id })
assert.equal(store.listChartMarks('session-2', 'ETH', '15m').length, 0)

// Legacy flat marks migrate without cross-session leakage or duplicate rows.
const legacyDir = mkdtempSync(join(tmpdir(), 'dhl-legacy-chart-'))
const old = new HyperStore(legacyDir)
old.registerSession('a')
old.registerSession('b')
writeFileSync(join(legacyDir, 'chart-marks.json'), JSON.stringify([
  { id: 'old-a', sessionId: 'a', coin: 'BTC', interval: '1h', kind: 'level', price: 10 },
  { id: 'old-b', sessionId: 'b', coin: 'ETH', interval: '1h', kind: 'level', price: 20 },
]))
const migrated = new HyperStore(legacyDir)
assert.equal(migrated.listChartMarks('a', 'BTC', '1h')[0].id, 'old-a')
assert.equal(migrated.listChartMarks('b', 'ETH', '1h')[0].id, 'old-b')
assert.ok(existsSync(join(legacyDir, 'chart-marks.migrated.json')))
assert.equal(new HyperStore(legacyDir).listChartMarks('a', 'BTC', '1h').length, 1)
store.registerSession('../../outside')
assert.ok(store.sessionDirectory('../../outside').startsWith(join(dir, 'sessions')))
store.removeSession('session-1')
assert.equal(existsSync(one), false, 'deleted session artifacts are removed')
assert.equal(existsSync(two), true, 'another session artifacts stay intact')
console.log('图表标注、工作台配置、文件路径隔离、重启恢复及旧数据迁移通过')
