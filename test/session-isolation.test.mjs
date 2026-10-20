import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HyperStore } from '../lib/store.js'
import { HyperRemote } from '../lib/remote.js'
import { buildToolDefinitions } from '../lib/tools.js'
import { sessionExposure, assertSessionIntent } from '../lib/session-execution.js'

const dir = mkdtempSync(join(tmpdir(), 'dhl-isolation-'))
const store = new HyperStore(dir)
store.saveJournal({ profile: { 风险: { value: '按档案' } }, strategies: [{ id: 'old-a' }, { id: 'old-b' }],
  entries: [{ type: 'plan', strategyId: 'old-a', sessionId: 'a' }, { type: 'plan', strategyId: 'old-b', sessionId: 'b' }] })
store.registerSession('a', { coin: 'BTC' }); store.registerSession('b', { coin: 'BTC' })
assert.deepEqual(store.journal('a').strategies.map((row) => row.id), ['old-a'])
assert.deepEqual(store.journal('b').strategies.map((row) => row.id), ['old-b'])
store.configureSession('b', { mode: 'copy', sourceSessionId: 'a' })
store.saveJournal({ ...store.journal('b'), strategies: [{ id: 'copy' }] }, 'b')
assert.equal(store.journal('a').strategies[0].id, 'old-a', 'copy is independent')
store.configureSession('b', { mode: 'shared', sourceSessionId: 'a' })
store.saveJournal({ ...store.journal('b'), strategies: [{ id: 'shared' }] }, 'b')
assert.equal(store.journal('a').strategies[0].id, 'shared')
store.removeSession('a')
assert.equal(new HyperStore(dir).journal('b').strategies[0].id, 'shared', 'sharing survives source deletion and restart')
store.configureSession('b', { mode: 'private' })
assert.equal(store.journal('b').strategies.length, 0)

const records = {
  ca: { sessionId: 'a', coin: 'BTC', network: 'testnet', address: 'wallet', orderIds: [1, 3] },
  cb: { sessionId: 'b', coin: 'BTC', network: 'testnet', address: 'wallet', orderIds: [2] },
}
const fill = (oid, side, sz, startPosition, time) => ({ coin: 'BTC', oid, tid: time, side, sz, startPosition, time })
const args = { sessionId: 'b', coin: 'BTC', size: 3, fills: [fill(2, 'B', 2, 1, 2), fill(1, 'B', 1, 0, 1)], records, network: 'testnet', address: 'wallet' }
let view = sessionExposure(args)
assert.equal(view.sessionSize, 2)
assertSessionIntent(view, { coin: 'BTC', isBuy: false, sz: 2, reduceOnly: true })
assert.throws(() => assertSessionIntent(view, { coin: 'BTC', isBuy: false, sz: 3, reduceOnly: true }), /本会话/)
assert.throws(() => assertSessionIntent(view, { coin: 'BTC', isBuy: false, sz: 1 }), /反向仓位冲突/)
view = sessionExposure({ ...args, fills: [fill(3, 'A', 1, 3, 3), ...args.fills], size: 2 })
assert.equal(view.sessionSize, 2, 'a stop for a does not close b allocation')
view = sessionExposure({ ...args, fills: [fill(99, 'A', 0.5, 3, 3), ...args.fills], size: 2.5 })
assert.equal(view.ownershipConfirmed, false, 'external reduction must be reconciled')
assert.equal(sessionExposure({ ...args, network: 'mainnet' }).sessionSize, 0, 'no network leakage')

// Real tool path: same-contract paper strategies keep separate brackets and close only their own size.
const remote = Object.create(HyperRemote.prototype)
remote.store = new HyperStore(mkdtempSync(join(tmpdir(), 'dhl-isolated-paper-')))
remote.store.registerSession('a'); remote.store.registerSession('b')
remote.cfg = { tradingMode: 'paper', network: 'testnet', dataDir: remote.store.dataDir, allowedCoins: ['BTC'], maxOrderUsd: 1000, maxDailyUsd: 10000, maxPositionUsd: 10000, maxLeverage: 2 }
remote.tradeAsset = async () => ({ asset: 0, szDecimals: 3 })
remote.midOf = async () => 100
remote.client = { allMids: async () => ({ BTC: '100' }) }
const tools = buildToolDefinitions(remote)
const order = tools.find((tool) => tool.name === 'hyper_order')
const exec = (id) => ({ agent: { id } })
await order.execute({ action: 'place', coin: 'BTC', isBuy: true, sz: 1, stopLossPx: 90, reason: '测试会话 A 独立入场及止损' }, exec('a'))
await order.execute({ action: 'place', coin: 'BTC', isBuy: true, sz: 2, stopLossPx: 80, reason: '测试会话 B 独立入场及止损' }, exec('b'))
assert.equal(Object.keys(remote.store.paper.protections).length, 2)
await assert.rejects(order.execute({ action: 'place', coin: 'BTC', isBuy: false, sz: 3, reduceOnly: true, reason: '测试不能平掉别的会话持仓' }, exec('b')), /本会话/)
remote.processPaperProtections(Date.now(), { BTC: 85 })
assert.equal(remote.store.paper.positions.BTC.size, 2)
assert.equal((await remote.sessionExecution('a', 'BTC', { mode: 'paper', positions: [{ coin: 'BTC', size: 2 }] })).sessionSize, 0)
assert.equal((await remote.sessionExecution('b', 'BTC', { mode: 'paper', positions: [{ coin: 'BTC', size: 2 }] })).sessionSize, 2)
const journal = tools.find((tool) => tool.name === 'hyper_journal')
await assert.rejects(journal.execute({}, exec('plain')), /已登记/)
console.log('会话隔离：旧日志迁移、复制/共享、订单归属、同向独立止损与越权减仓通过')
