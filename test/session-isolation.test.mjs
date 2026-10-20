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
store.registerSession('new-eth', { coin: 'ETH' })
assert.deepEqual(store.journal('new-eth').profile, {}, 'new chats never inherit unowned global instructions')
assert.deepEqual(store.journal('a').strategies.map((row) => row.id), ['old-a'])
assert.deepEqual(store.journal('b').strategies.map((row) => row.id), ['old-b'])
store.configureSession('b', { mode: 'copy', sourceSessionId: 'a' })
store.saveJournal({ ...store.journal('b'), strategies: [{ id: 'copy' }] }, 'b')
assert.equal(store.journal('a').strategies[0].id, 'old-a', 'copy is independent')
store.configureSession('b', { mode: 'shared', sourceSessionId: 'a' })
assert.equal(store.journal('b').entries[0].strategyId, 'old-b', 'sharing preserves b private logs')
assert.equal(store.journal('a').entries[0].strategyId, 'old-a')
store.saveJournal({ ...store.journal('b'), strategies: [{ id: 'shared' }] }, 'b')
assert.equal(store.journal('a').strategies[0].id, 'shared')
store.removeSession('a')
assert.equal(new HyperStore(dir).journal('b').strategies[0].id, 'shared', 'sharing survives source deletion and restart')
store.configureSession('b', { mode: 'private' })
assert.equal(store.journal('b').strategies[0].id, 'shared', 'detaching keeps a private copy of current rules')
assert.equal(store.journal('b').entries[0].strategyId, 'old-b')

const records = {
  ca: { sessionId: 'a', coin: 'BTC', network: 'testnet', address: 'wallet', orderIds: [1, 3] },
  cb: { sessionId: 'b', coin: 'BTC', network: 'testnet', address: 'wallet', orderIds: [2] },
}
const fill = (oid, side, sz, startPosition, time) => ({ coin: 'BTC', oid, tid: time, side, sz, startPosition, time })
const args = { sessionId: 'b', coin: 'BTC', size: 3, fills: [fill(2, 'B', 2, 1, 2), fill(1, 'B', 1, 0, 1)], records, network: 'testnet', address: 'wallet' }
let view = sessionExposure(args)
assert.equal(view.sessionSize, 2)
assertSessionIntent(view, { coin: 'BTC', isBuy: false, sz: 2, reduceOnly: true })
assert.throws(() => assertSessionIntent(view, { coin: 'BTC', isBuy: false, sz: 2, reduceOnly: true }, [{ sessionId: 'b', coin: 'BTC', sz: 2, reduceOnly: true }]), /在途离场/)
assert.throws(() => assertSessionIntent({ ...view, pendingExits: [{ sessionId: 'b', sz: 2, reduceOnly: true }] }, { coin: 'BTC', isBuy: false, sz: 1, reduceOnly: true }), /止盈止损/)
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
assert.equal((await remote.account({ coin: 'BTC', sessionId: 'a' })).positions[0].size, 1)
assert.equal((await remote.account({ coin: 'BTC', sessionId: 'b' })).positions[0].size, 2)
assert.equal((await remote.tradeHistory({ sessionId: 'b' })).fills.length, 1, 'chart markers/history show only b fills')
await assert.rejects(order.execute({ action: 'place', coin: 'BTC', isBuy: false, sz: 3, reduceOnly: true, reason: '测试不能平掉别的会话持仓' }, exec('b')), /本会话/)
remote.processPaperProtections(Date.now(), { BTC: 85 })
assert.equal(remote.store.paper.positions.BTC.size, 2)
assert.equal((await remote.sessionExecution('a', 'BTC', { mode: 'paper', positions: [{ coin: 'BTC', size: 2 }] })).sessionSize, 0)
assert.equal((await remote.sessionExecution('b', 'BTC', { mode: 'paper', positions: [{ coin: 'BTC', size: 2 }] })).sessionSize, 2)
remote.hostCtx = { get: () => ({ archivedSessionIds: ['b'] }) }
await assert.rejects(remote.checkSessionOrder({ coin: 'BTC', isBuy: true, sz: 1 }, 'b'), /暂停或归档/)
const journal = tools.find((tool) => tool.name === 'hyper_journal')
await assert.rejects(journal.execute({}, exec('plain')), /已登记/)

// Live evidence is cached for the UI, fresh for execution, and reductions reserve existing exits.
const live = Object.create(HyperRemote.prototype)
live.cfg = { tradingMode: 'live', network: 'testnet' }
live.store = new HyperStore(mkdtempSync(join(tmpdir(), 'dhl-isolated-live-')))
live.store.registerSession('a'); live.store.registerSession('b')
for (const [cloid, record] of Object.entries(records)) live.store.recordLiveOrder(cloid, record)
let fillReads = 0, historyReads = 0, open = []
live.resolveAddress = async () => 'wallet'
live.client = {
  userFills: async () => { fillReads++; return args.fills.map((row) => ({ ...row, px: row.oid === 1 ? 90 : 95 })) },
  historicalOrders: async () => { historyReads++; return [] },
}
const snapshot = { mode: 'live', address: 'wallet', openOrders: [], positions: [{ coin: 'BTC', size: 3, markPx: 100, entryPx: 80, uPnl: 60, marginUsed: 150, returnOnEquity: 0.4, cumFunding: { sinceOpen: 5 } }, { coin: 'ETH', size: 1, markPx: 200 }] }
live.account = async () => snapshot
const scopedAccount = await HyperRemote.prototype.account.call(live, { sessionId: 'a', coin: 'BTC' })
assert.equal(scopedAccount.positions[0].entryPx, 90)
assert.equal(scopedAccount.positions[0].uPnl, 10, 'position P&L uses this session cost basis')
assert.equal(scopedAccount.positions[0].positionValue, 100)
assert.equal(scopedAccount.positions[0].marginUsed, null, 'shared margin is not presented as private')
assert.equal(scopedAccount.positions[0].cumFunding, null)
await HyperRemote.prototype.account.call(live, { sessionId: 'b', coin: 'BTC' })
assert.equal(fillReads, 1); assert.equal(historyReads, 1, 'UI polling reuses weighted history across chats and contracts')
live.orders = async () => ({ orders: open })
open = [{ coin: 'BTC', oid: 3, reduceOnly: true, isTrigger: true, cloid: 'ca' }]
await assert.rejects(live.checkSessionOrder({ coin: 'BTC', isBuy: false, sz: 1, reduceOnly: true }, 'a', { address: 'wallet', positionSize: 3 }), /止盈止损/)
open = []
await live.checkSessionOrder({ coin: 'BTC', isBuy: false, sz: 1, reduceOnly: true }, 'a', { address: 'wallet', positionSize: 3 })
assert.ok(fillReads >= 3, 'execution never relies on cached allocation evidence')
live.store.getSession('a').tradingEnabled = false
live.hostCtx = { get: () => ({ archivedSessionIds: [] }) }
assert.equal(live.isSessionActive('a'), true, 'native unarchive restores default entry without an enable toggle')

// HIP-3 children without an immediate OID still map through DEX history and deterministic CLOIDs.
const time = Date.now()
live.store.recordLiveOrder('cx', { coin: 'xyz:ABC', sessionId: 'a', network: 'testnet', address: 'wallet', orderIds: [101], childCloids: ['cx-sl'] })
live.store.recordLiveOrder('foreign', { coin: 'BTC', sessionId: 'a', network: 'mainnet', address: 'other-wallet' })
live.tradeHistory = async () => ({ mode: 'live', network: 'testnet', orders: [], fills: [
  { ...fill(102, 'A', 1, 1, time), coin: 'xyz:ABC', px: 90 }, { ...fill(101, 'B', 1, 0, time - 1), coin: 'xyz:ABC', px: 100 }],
  localOrders: [{ cloid: 'cx', sessionId: 'a' }, { cloid: 'foreign', sessionId: 'a' }], coverage: {} })
live.client.info = async (type, extra) => {
  assert.equal(type, 'historicalOrders'); assert.equal(extra.dex, 'xyz')
  return [{ order: { coin: 'xyz:ABC', cloid: 'cx-sl', oid: 102 }, status: 'filled' }]
}
const scopedHistory = await live.sessionHistory({ days: 30 }, 'a')
assert.equal(scopedHistory.fills.length, 2)
assert.equal(scopedHistory.fills[0].closedPnl, -10)
assert.deepEqual(scopedHistory.localOrders.map((row) => row.cloid), ['cx'])
console.log('会话隔离：旧日志迁移、复制/共享、订单归属、同向独立止损与越权减仓通过')
