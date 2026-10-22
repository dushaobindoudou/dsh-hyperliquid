import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HyperStore } from '../lib/store.js'
import { HyperRemote } from '../lib/remote.js'
import { buildToolDefinitions } from '../lib/tools.js'
import { sessionExposure, assertSessionIntent, orderOwnership } from '../lib/session-execution.js'

const dir = mkdtempSync(join(tmpdir(), 'dhl-isolation-'))
const store = new HyperStore(dir)
store.saveJournal({ profile: { 风险: { value: '按档案' } }, strategies: [{ id: 'old-a' }, { id: 'old-b' }],
  entries: [{ type: 'plan', strategyId: 'old-a', sessionId: 'a' }, { type: 'plan', strategyId: 'old-b', sessionId: 'b' }] })
store.registerSession('a', { coin: 'BTC' }); store.registerSession('b', { coin: 'BTC' })
store.registerSession('new-eth', { coin: 'ETH' })
assert.deepEqual(store.journal('new-eth').profile, {}, 'new chats never inherit unowned global instructions')
assert.deepEqual(store.journal('a').strategies.map((row) => row.id), ['old-a'])
assert.deepEqual(store.journal('b').strategies.map((row) => row.id), ['old-b'])
assert.throws(() => store.configureSession('b', { mode: 'copy' }), /独立或全局共享/, 'only independent and global sharing exist')
assert.equal(store.getSession('b').watch, false, '盯盘 starts off: no session is woken without the user')
store.configureSession('b', { watch: true })
assert.equal(new HyperStore(dir).getSession('b').watch, true, '盯盘 survives a restart')
store.registerSession('b', { coin: 'BTC' })
assert.equal(store.getSession('b').watch, true, 're-registering keeps the user choice')
assert.throws(() => store.configureSession('b', { watch: 'yes' }), /开或关/)
store.configureSession('b', { watch: false })
store.configureSession('a', { mode: 'shared' })
assert.equal(store.journal('a').strategies[0].id, 'old-a', 'the first shared session seeds the global rules with its own')
store.configureSession('b', { mode: 'shared' })
assert.equal(store.journal('b').strategies[0].id, 'old-a', 'joining adopts the global rules')
assert.equal(store.journal('b').entries[0].strategyId, 'old-b', 'sharing preserves b private logs')
assert.equal(store.journal('a').entries[0].strategyId, 'old-a')
store.saveJournal({ ...store.journal('b'), strategies: [{ id: 'shared' }] }, 'b')
assert.equal(store.journal('a').strategies[0].id, 'shared')
assert.equal(store.journal('new-eth').strategies.length, 0, 'independent sessions never see the global rules')
store.removeSession('a')
assert.equal(new HyperStore(dir).journal('b').strategies[0].id, 'shared', 'sharing survives source deletion and restart')
store.configureSession('b', { mode: 'private' })
assert.equal(store.journal('b').strategies[0].id, 'shared', 'detaching keeps a private copy of current rules')
assert.equal(store.journal('b').entries[0].strategyId, 'old-b')
store.saveJournal({ ...store.journal('b'), strategies: [{ id: 'mine' }] }, 'b')
store.configureSession('new-eth', { mode: 'shared' })
assert.equal(store.journal('new-eth').strategies[0].id, 'shared', 'a private edit after detaching never reaches the global rules')

// Pairwise sharing from older builds becomes independent copies of the same rules.
const pairDir = mkdtempSync(join(tmpdir(), 'dhl-isolation-pair-'))
const pair = new HyperStore(pairDir)
pair.registerSession('p', { coin: 'BTC' }); pair.registerSession('q', { coin: 'BTC' })
pair.saveJournal({ profile: {}, strategies: [{ id: 'pair' }], entries: [] }, 'p')
pair.getSession('q').strategyScopeId = 'p'; pair.registerSession('q')
const split = new HyperStore(pairDir)
assert.notEqual(split.getSession('q').strategyScopeId, 'p')
assert.equal(split.journal('q').strategies[0].id, 'pair')
split.saveJournal({ ...split.journal('q'), strategies: [{ id: 'q-only' }] }, 'q')
assert.equal(split.journal('p').strategies[0].id, 'pair')

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

// 2026-10-22 10:19:35 (+08, testnet): two stop losses of one 0.012 long fired in the same
// millisecond. Hyperliquid returned their partial fills interleaved by tid rather than along
// the position path, so the old replay went negative and every later close was refused with
// "会话仓位归属未确认" (19 rounds). Rebuild the same-ms group from startPosition instead.
const concurrentRecords = {
  cstopA: { sessionId: 'b', coin: 'BTC', network: 'testnet', address: 'wallet', orderIds: [63354917368] },
  cstopB: { sessionId: 'b', coin: 'BTC', network: 'testnet', address: 'wallet', orderIds: [63353938095] },
  copen: { sessionId: 'b', coin: 'BTC', network: 'testnet', address: 'wallet', orderIds: [63355473886] },
}
const triggerFill = (oid, tid, sz, startPosition) => ({ coin: 'BTC', oid, tid, side: 'A', sz, startPosition, time: 1792625975207 })
const concurrent = [
  triggerFill(63354917368, 114314779971775, 0.006, 0.006),
  triggerFill(63353938095, 283850736457451, 0.002, 0.008),
  triggerFill(63353938095, 206634221900449, 0.0005, 0.0085),
  triggerFill(63353938095, 808208746418750, 0.00059, 0.00909),
  triggerFill(63353938095, 875422283580507, 0.00028, 0.00937),
  triggerFill(63353938095, 664188096699416, 0.0005, 0.00987),
  triggerFill(63353938095, 312407212545421, 0.00014, 0.01001),
  triggerFill(63353938095, 7501018119356, 0.00048, 0.01049),
  triggerFill(63353938095, 1101694665039835, 0.001, 0.01149),
  triggerFill(63353938095, 436624758211061, 0.0005, 0.01199),
  triggerFill(63353938095, 171881847965459, 0.00001, 0.012),
  { coin: 'BTC', oid: 63355473886, tid: 1061694428531736, side: 'B', sz: 0.00431, startPosition: 0.00069, time: 1792626272359 },
  { coin: 'BTC', oid: 63355473886, tid: 81411774338566, side: 'B', sz: 0.00059, startPosition: 0.0001, time: 1792626272359 },
  { coin: 'BTC', oid: 63355473886, tid: 893055151889145, side: 'B', sz: 0.0001, startPosition: 0, time: 1792626272359 },
]
const rebuilt = sessionExposure({ sessionId: 'b', coin: 'BTC', size: 0.005, fills: concurrent, records: concurrentRecords, network: 'testnet', address: 'wallet' })
assert.equal(rebuilt.ownershipConfirmed, true, 'concurrent stops keep the position path attributable')
assert.ok(Math.abs(rebuilt.sessionSize - 0.005) < 1e-9)
assertSessionIntent(rebuilt, { coin: 'BTC', isBuy: false, sz: 0.005, reduceOnly: true })

// Hyperliquid returns TPSL children with cloid null and no child oid in the receipt, so a
// bracket is attributed by its own protective prices instead of the (missing) cloid.
const bracket = {
  cbracket: { sessionId: 'b', coin: 'BTC', sz: 0.0003, network: 'testnet', address: 'wallet', orderIds: [11],
    protection: { stopLossPx: 82500, takeProfitPx: 83500 } },
}
const trig = (oid, triggerPx) => ({ coin: 'BTC', oid, sz: '0.0003', isTrigger: true, reduceOnly: true, triggerPx: String(triggerPx), cloid: null })
const ownership = orderOwnership({ orders: [trig(12, 82500), trig(13, 83500)], records: bracket, network: 'testnet', address: 'wallet' })
assert.equal(ownership.orderOwners['12'], 'b', 'stop child without cloid resolves through its trigger price')
assert.equal(ownership.orderOwners['13'], 'b', 'take-profit child without cloid resolves through its trigger price')
const ambiguous = orderOwnership({ orders: [trig(14, 82500)], records: { ...bracket,
  cdup: { sessionId: 'a', coin: 'BTC', sz: 0.0003, network: 'testnet', address: 'wallet', protection: { stopLossPx: 82500 } } },
  network: 'testnet', address: 'wallet' })
assert.equal(ambiguous.orderOwners['14'], undefined, 'two sessions with the same bracket stay unattributed')
assert.equal(orderOwnership({ orders: [trig(15, 82500)], records: bracket, network: 'mainnet', address: 'wallet' }).orderOwners['15'], undefined,
  'trigger attribution never leaks across networks')

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
// Only the old desk placeholder is handed back to DSH's automatic titling; a real rename stays pinned.
const titled = Object.create(HyperRemote.prototype)
titled.store = new HyperStore(mkdtempSync(join(tmpdir(), 'dhl-title-')))
titled.store.registerSession('p'); titled.store.registerSession('r')
const titleOf = { p: { title: '未命名', messageSeqs: [], source: { kind: 'user' } }, r: { title: 'BTC 波段', messageSeqs: [], source: { kind: 'user' } } }
const refreshed = []
titled.hostCtx = { get: (name) => name === 'sessionTitle'
  ? { get: (session) => titleOf[session.id], refresh: async (session) => { refreshed.push(session.id); return { title: '突破策略', source: { kind: 'provider' } } } }
  : name === 'sessionController' ? { resolveAgent: async (id) => ({ agent: { session: { id } } }) } : undefined }
assert.deepEqual(await titled.restoreAutoTitle({ sessionId: 'p' }), { restored: true, title: '突破策略' })
assert.deepEqual(await titled.restoreAutoTitle({ sessionId: 'r' }), { restored: false })
assert.deepEqual(await titled.restoreAutoTitle({ sessionId: 'not-desk' }), { restored: false })
assert.deepEqual(refreshed, ['p'], 'a user rename is never unpinned')

console.log('会话隔离：旧日志迁移、独立/全局共享、订单归属、同向独立止损与越权减仓通过')
