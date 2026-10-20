import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HyperStore } from '../lib/store.js'
import { HyperRemote } from '../lib/remote.js'

const dir = mkdtempSync(join(tmpdir(), 'dhl-history-'))
const store = new HyperStore(dir)
store.paperFill({ coin: 'BTC', isBuy: true, sz: 0.1, px: 100, reason: '突破区间高点后买入', sessionId: 'session-a' })
store.paperOrderRecord({ coin: 'BTC', isBuy: true, sz: 0.1, px: 100, reason: '突破区间高点后买入' })
const paperRemote = Object.create(HyperRemote.prototype)
paperRemote.cfg = { tradingMode: 'paper' }
paperRemote.store = new HyperStore(dir)
const paper = await paperRemote.tradeHistory()
assert.equal(paper.orders[0].reason, '突破区间高点后买入')
assert.equal(paper.fills[0].reason, '突破区间高点后买入')
assert.equal(paper.orders[0].status, 'filled')
assert.equal(paper.fills[0].sessionId, 'session-a', 'a paper fill remembers the deciding session across restart')

const liveRemote = Object.create(HyperRemote.prototype)
liveRemote.cfg = { tradingMode: 'live' }
liveRemote.resolveAddress = async () => '0x0000000000000000000000000000000000000001'
liveRemote.client = {
  historicalOrders: async () => [{ order: { coin: 'ETH', oid: 7, cloid: '0xabc', timestamp: 1000 }, status: 'canceled', statusTimestamp: 2000 }],
  userFills: async () => [{ coin: 'ETH', oid: 7, px: '2000', time: 1500 }],
}
liveRemote.store = { liveOrders: { '0xabc': { thesis: '风险回报比合适', decisionId: 'd1' } }, liveDecisions: { d1: { sessionId: 'session-b' } } }
const live = await liveRemote.tradeHistory()
assert.equal(live.orders[0].status, 'canceled')
assert.equal(live.orders[0].reason, '风险回报比合适')
assert.equal(live.fills[0].oid, 7)
assert.equal(live.orders[0].sessionId, 'session-b', 'live orders carry the deciding session from the decision audit')

// The chart maps each fill to its order's rationale and session.
const { build } = await import('esbuild')
const out = await build({ entryPoints: ['src/client/trade-events.ts'], bundle: true, format: 'esm', write: false, platform: 'node' })
const { chartTradeEvents } = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
const candles = [{ t: 0, o: 1, h: 1, l: 1, c: 1, v: 1 }, { t: 1000, o: 1, h: 1, l: 1, c: 1, v: 1 }]
const events = chartTradeEvents(candles, 'ETH', live.orders, live.fills)
const fill = events.find((event) => event.kind === 'fill')
assert.equal(fill.reason, '风险回报比合适'); assert.equal(fill.sessionId, 'session-b'); assert.equal(fill.px, 2000)
console.log('paper 历史落盘与 live 历史订单、成交、原因及决策会话关联通过')
