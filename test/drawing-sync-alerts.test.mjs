// Drawings synced across a coin's sessions, price-cross alerts on lines, and the sticker library.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HyperStore } from '../lib/store.js'
import { HyperRemote } from '../lib/remote.js'
import { isIconLabel, linePriceAt } from '../lib/chart-drawings.js'

const dir = mkdtempSync(join(tmpdir(), 'dhl-sync-'))
const store = new HyperStore(dir)
for (const id of ['a', 'b', 'c']) store.registerSession(id, { coin: id === 'c' ? 'ETH' : 'BTC' })
const remote = Object.create(HyperRemote.prototype)
remote.store = store
remote.desk = { coin: 'BTC', interval: '1h' }
remote.alertSides = new Map()
const now = Date.now()

// ── sync ──
const line = await remote.drawChartMark({ sessionId: 'a', coin: 'BTC', interval: '1h', kind: 'level', label: '关键位', price: 100 })
assert.deepEqual(store.listChartMarks('b', 'BTC', null).map((m) => m.id), [], 'a session drawing stays in its session')
const synced = await remote.updateChartMark({ sessionId: 'a', id: line.id, patch: { shared: true } })
assert.equal(synced.shared, true)
assert.deepEqual(store.listChartMarks('b', 'BTC', null).map((m) => m.id), [line.id], 'synced drawings show in every BTC session')
assert.deepEqual(store.listChartMarks('c', 'ETH', null).length, 0, '…but not on other coins')
assert.equal(store.events.at(-2).data.shared, true, 'sync notifies every desk on the coin')
const reopened = new HyperStore(dir)
assert.deepEqual(reopened.listChartMarks('b', 'BTC', null).map((m) => m.id), [line.id], 'sync survives restart')
await remote.updateChartMark({ sessionId: 'b', id: line.id, patch: { color: '#ef5f6c' } })
assert.equal(store.listChartMarks('a', 'BTC', null)[0].color, '#ef5f6c', 'any session can edit a synced drawing')
await remote.updateChartMark({ sessionId: 'a', id: line.id, patch: { shared: false } })
assert.equal(store.listChartMarks('b', 'BTC', null).length, 0); assert.equal(store.listChartMarks('a', 'BTC', null).length, 1, 'unsync returns it to its session')
const sharedRay = await remote.drawChartMark({ sessionId: 'b', coin: 'BTC', interval: '1h', kind: 'ray', label: '上升趋势', shared: true,
  points: [{ time: now - 4 * 3600_000, price: 90 }, { time: now - 2 * 3600_000, price: 95 }] })
assert.equal(store.listChartMarks('a', 'BTC', null).filter((m) => m.shared).length, 1)

// ── alerts ──
assert.equal(linePriceAt({ kind: 'level', price: 7 }, now), 7)
assert.equal(linePriceAt({ kind: 'ray', points: [{ time: 0, price: 10 }, { time: 10, price: 20 }] }, 20), 30, 'rays extend forward')
assert.equal(linePriceAt({ kind: 'ray', points: [{ time: 0, price: 10 }, { time: 10, price: 20 }] }, -5), null, '…but not backward')
assert.equal(linePriceAt({ kind: 'trend', fromTime: 0, fromPrice: 10, toTime: 10, toPrice: 20 }, 15), null, 'trend lines only between their ends')
assert.equal(linePriceAt({ kind: 'hray', points: [{ time: 5, price: 50 }] }, 4), null)
await assert.rejects(remote.updateChartMark({ sessionId: 'a', id: (await remote.drawChartMark({ sessionId: 'a', coin: 'BTC', interval: '1h', kind: 'rect', label: '区间', points: [{ time: now - 3600_000, price: 1 }, { time: now, price: 2 }] })).id, patch: { alert: true } }), /支持价格提醒/)
await remote.updateChartMark({ sessionId: 'a', id: line.id, patch: { alert: true } })
assert.deepEqual(remote.checkDrawingAlerts(now, { BTC: 99 }), [], 'first observation only records the side')
assert.deepEqual(remote.checkDrawingAlerts(now + 2000, { BTC: 99.5 }), [], 'no cross, no alert')
const fired = remote.checkDrawingAlerts(now + 4000, { BTC: 100.4 })
assert.equal(fired.length, 1); assert.equal(fired[0].direction, 'up'); assert.equal(fired[0].id, line.id)
assert.equal(store.events.at(-1).kind, 'chart.alert')
const after = store.listChartMarks('a', 'BTC', null).find((m) => m.id === line.id)
assert.equal(after.alert, false, 'fires once'); assert.equal(after.alertTriggeredAt, now + 4000)
assert.deepEqual(remote.checkDrawingAlerts(now + 6000, { BTC: 99 }), [], 'a fired alert stays quiet')
await remote.updateChartMark({ sessionId: 'a', id: line.id, patch: { alert: true } })
assert.equal(store.listChartMarks('a', 'BTC', null).find((m) => m.id === line.id).alertTriggeredAt, undefined, 're-arming clears the last trigger')
remote.checkDrawingAlerts(now + 8000, { BTC: 99 }); assert.equal(remote.checkDrawingAlerts(now + 9000, { BTC: 101 }).length, 1, 're-armed alert fires again')
// A synced ray: the line rises 2.5/h; the alert compares against the line price at that moment.
await remote.updateChartMark({ sessionId: 'b', id: sharedRay.id, patch: { alert: true } })
const rayNow = linePriceAt(store.listChartMarks('a', 'BTC', null).find((m) => m.id === sharedRay.id), now)
remote.checkDrawingAlerts(now, { BTC: rayNow + 1 })
const down = remote.checkDrawingAlerts(now, { BTC: rayNow - 1 })
assert.equal(down.length, 1); assert.equal(down[0].direction, 'down'); assert.equal(down[0].shared, true, 'synced drawings alert every session')

// ── stickers ──
assert.ok(isIconLabel('flag') && isIconLabel('emoji:🚀') && isIconLabel('emoji:🐻'))
assert.ok(isIconLabel('emoji:🍕') && isIconLabel('emoji:👨‍👩‍👧') && isIconLabel('emoji:🇨🇳') && isIconLabel('pin'), 'any single emoji (incl. ZWJ sequences and flags) is a sticker')
assert.ok(!isIconLabel('emoji:🍕🍕') && !isIconLabel('emoji:abc') && !isIconLabel('emoji:') && !isIconLabel('skull'), 'one emoji only, no text')
await assert.rejects(remote.drawChartMark({ sessionId: 'a', coin: 'BTC', interval: '1h', kind: 'icon', label: 'emoji:hello', points: [{ time: now, price: 1 }] }), /贴图库/)
assert.equal((await remote.drawChartMark({ sessionId: 'a', coin: 'BTC', interval: '1h', kind: 'icon', label: 'emoji:🦄', points: [{ time: now, price: 1 }] })).label, 'emoji:🦄')
assert.equal((await remote.drawChartMark({ sessionId: 'a', coin: 'BTC', interval: '1h', kind: 'icon', label: 'emoji:🚀', points: [{ time: now, price: 1 }] })).label, 'emoji:🚀')
console.log('画线跨会话同步、价格穿越提醒（触发一次、可重新开启）与贴图库校验通过')
