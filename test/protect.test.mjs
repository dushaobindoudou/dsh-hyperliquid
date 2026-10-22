import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HyperStore } from '../lib/store.js'
import { HyperRemote } from '../lib/remote.js'
import { buildToolDefinitions } from '../lib/tools.js'
import { createStrategyBarMonitor, sessionWatch } from '../lib/strategy-monitor.js'
import { frameLine, planLine, protectionLine, watchDigest } from '../lib/watch-digest.js'
import { marketBarWakeText } from '../lib/wake.js'

// ── A fake live exchange: trigger orders rest until cancelled; fills are what the test says ──
function liveDesk() {
  const live = Object.create(HyperRemote.prototype)
  live.cfg = { tradingMode: 'live', network: 'testnet', custody: 'managed' }
  live.store = new HyperStore(mkdtempSync(join(tmpdir(), 'dhl-protect-')))
  live.store.registerSession('s', { coin: 'BTC' }); live.store.registerSession('t', { coin: 'BTC' })
  const state = { size: 0.01, fills: [], open: [], actions: [], nextOid: 100 }
  live.resolveAddress = async () => 'wallet'
  live.midOf = async () => 81000
  live.tradeAsset = async () => ({ asset: 0, szDecimals: 5 })
  live.account = async () => ({ mode: 'live', address: 'wallet', positions: [{ coin: 'BTC', size: state.size }], openOrders: state.open })
  live.orders = async () => ({ orders: state.open })
  live.client = { userFills: async () => state.fills, historicalOrders: async () => [] }
  live.submitAction = async (action) => {
    state.actions.push(action)
    if (action.type === 'order') {
      const statuses = action.orders.map((order) => {
        const oid = state.nextOid++
        state.open.push({ coin: 'BTC', oid, isTrigger: true, reduceOnly: true, triggerPx: order.t.trigger.triggerPx, sz: order.s,
          orderType: order.t.trigger.tpsl === 'sl' ? 'Stop Market' : 'Take Profit Market', cloid: order.c })
        return { resting: { oid } }
      })
      return { status: 'ok', response: { type: 'order', data: { statuses } } }
    }
    state.open = state.open.filter((order) => !action.cancels.some((row) => row.o === order.oid))
    return { status: 'ok', response: { type: 'cancel', data: { statuses: action.cancels.map(() => 'success') } } }
  }
  return { live, state }
}
const exec = (id) => ({ agent: { id } })
const opened = (live, { cloid = 'copen', sz = 0.01, oid = 1, stopLossPx = 80000 } = {}) =>
  live.store.recordLiveOrder(cloid, { sessionId: 's', coin: 'BTC', sz, isBuy: true, network: 'testnet', address: 'wallet', orderIds: [oid], protection: { stopLossPx }, status: 'accepted' })
const fill = (oid, side, sz, startPosition, time) => ({ coin: 'BTC', oid, tid: time, side, sz: String(sz), startPosition: String(startPosition), time, px: '81000' })

// 1) Move the stop of an existing position: the new stop is live before the old one is cancelled.
{
  const { live, state } = liveDesk()
  opened(live)
  state.fills = [fill(1, 'B', 0.01, 0, 1)]
  state.open = [{ coin: 'BTC', oid: 2, isTrigger: true, reduceOnly: true, triggerPx: '80000', sz: '0.01', orderType: 'Stop Market', cloid: null }]
  const order = buildToolDefinitions(live).find((tool) => tool.name === 'hyper_order')
  const result = await order.execute({ action: 'protect', coin: 'BTC', stopLossPx: 80500, reason: '浮盈扩大，止损上移' }, exec('s'))
  assert.equal(state.actions[0].type, 'order', 'the new stop is submitted first')
  assert.equal(state.actions[0].grouping, 'na')
  assert.equal(state.actions[0].orders[0].r, true, 'reduce-only trigger')
  assert.equal(state.actions[0].orders[0].b, false, 'a long is protected by a sell stop')
  assert.equal(state.actions[0].orders[0].s, '0.01', 'sized to the session position')
  assert.equal(state.actions[1].type, 'cancel', 'the old stop goes only after the new one is accepted')
  assert.deepEqual(state.actions[1].cancels, [{ a: 0, o: 2 }])
  assert.deepEqual(result.replaced, [2]); assert.equal(result.stopLossPx, 80500)
  assert.deepEqual(state.open.map((row) => row.triggerPx), ['80500'], 'exactly one stop remains')
  assert.match(result.text, /保护单已生效/)
  // The new trigger is attributed to the session, so later reductions and cancels recognise it.
  const view = await live.sessionExecution('s', 'BTC')
  assert.equal(view.pendingExits[0].sessionId, 's')
  await assert.rejects(order.execute({ action: 'protect', coin: 'BTC', stopLossPx: 81500 }, exec('s')), /亏损方向/, 'a stop through the price is a close, not a stop')
  await assert.rejects(order.execute({ action: 'protect', coin: 'BTC', stopLossPx: 80000 }, exec('t')), /没有归属仓位/, 'another session cannot protect a position it does not own')
}

// 2) Attribution lock (2026-10-22): an explicitly sized stop is still allowed — it can only reduce risk.
{
  const { live, state } = liveDesk()
  opened(live)
  state.size = 0.005
  state.fills = [fill(99, 'A', 0.005, 0.01, 2), fill(1, 'B', 0.01, 0, 1)]
  const view = await live.sessionExecution('s', 'BTC')
  assert.equal(view.ownershipConfirmed, false, 'an unattributed reduction locks the allocation')
  const order = buildToolDefinitions(live).find((tool) => tool.name === 'hyper_order')
  await assert.rejects(order.execute({ action: 'protect', coin: 'BTC', stopLossPx: 80000 }, exec('s')), /必须显式给出 sz/)
  await assert.rejects(order.execute({ action: 'protect', coin: 'BTC', stopLossPx: 80000, sz: 0.006 }, exec('s')), /必须显式给出 sz|账户净仓/)
  await assert.rejects(order.execute({ action: 'protect', coin: 'BTC', takeProfitPx: 82000, sz: 0.005 }, exec('s')), /只允许补止损/)
  const result = await order.execute({ action: 'protect', coin: 'BTC', stopLossPx: 80000, sz: 0.005 }, exec('s'))
  assert.equal(result.emergency, true); assert.equal(state.open.length, 1)
  assert.match(result.text, /紧急止损/)
}

// 3) A partial reduce keeps the stop and trims it to the remaining size; flat cancels it.
{
  const { live, state } = liveDesk()
  opened(live)
  live.store.recordLiveOrder('creduce', { sessionId: 's', coin: 'BTC', sz: 0.006, isBuy: false, reduceOnly: true, network: 'testnet', address: 'wallet', orderIds: [3], status: 'accepted' })
  state.size = 0.004
  state.fills = [fill(3, 'A', 0.006, 0.01, 2), fill(1, 'B', 0.01, 0, 1)]
  state.open = [{ coin: 'BTC', oid: 2, isTrigger: true, reduceOnly: true, triggerPx: '80000', sz: '0.01', orderType: 'Stop Market', cloid: null }]
  const trimmed = await live.trimSessionExits('s', 'BTC', exec('s'))
  assert.equal(trimmed.action, 'resized'); assert.equal(trimmed.size, 0.004); assert.equal(trimmed.stopLossPx, 80000)
  assert.deepEqual(state.open.map((row) => [row.sz, row.triggerPx]), [['0.004', '80000']], 'the stop now matches what the session holds')
  state.size = 0
  state.fills = [fill(4, 'A', 0.004, 0.004, 3), ...state.fills]
  live.store.recordLiveOrder('cflat', { sessionId: 's', coin: 'BTC', sz: 0.004, isBuy: false, reduceOnly: true, network: 'testnet', address: 'wallet', orderIds: [4], status: 'accepted' })
  const flat = await live.trimSessionExits('s', 'BTC', exec('s'))
  assert.equal(flat.action, 'cancelled'); assert.equal(state.open.length, 0, 'a flat session leaves no stop that could close someone else')
}

// 4) Paper: protect replaces the session's bracket instead of stacking a second one.
{
  const paper = Object.create(HyperRemote.prototype)
  paper.store = new HyperStore(mkdtempSync(join(tmpdir(), 'dhl-protect-paper-')))
  paper.store.registerSession('a'); paper.store.registerSession('b')
  paper.cfg = { tradingMode: 'paper', network: 'testnet', dataDir: paper.store.dataDir, allowedCoins: ['BTC'], maxOrderUsd: 1000, maxDailyUsd: 10000, maxPositionUsd: 10000, maxLeverage: 2 }
  paper.tradeAsset = async () => ({ asset: 0, szDecimals: 3 })
  paper.midOf = async () => 100
  paper.client = { allMids: async () => ({ BTC: '100' }) }
  const order = buildToolDefinitions(paper).find((tool) => tool.name === 'hyper_order')
  await order.execute({ action: 'place', coin: 'BTC', isBuy: true, sz: 1, stopLossPx: 90, reason: '测试会话 A 入场及止损' }, exec('a'))
  await order.execute({ action: 'place', coin: 'BTC', isBuy: true, sz: 2, stopLossPx: 80, reason: '测试会话 B 入场及止损' }, exec('b'))
  const moved = await order.execute({ action: 'protect', coin: 'BTC', stopLossPx: 95, takeProfitPx: 120 }, exec('b'))
  assert.equal(moved.mode, 'paper'); assert.equal(moved.size, 2)
  const brackets = Object.values(paper.store.paper.protections)
  assert.equal(brackets.length, 2, 'replaced, not stacked')
  assert.deepEqual(brackets.filter((row) => row.sessionId === 'b').map((row) => [row.stopLossPx, row.takeProfitPx]), [[95, 120]])
  assert.deepEqual(brackets.filter((row) => row.sessionId === 'a').map((row) => row.stopLossPx), [90], 'the other session keeps its own stop')
}

// 5) The same refusal twice tells the agent to stop retrying and escalate.
{
  const remote = { prepareOrder: async () => { throw new Error('会话仓位归属未确认，请先对账') } }
  const decide = buildToolDefinitions(remote).find((tool) => tool.name === 'hyper_decide')
  const args = { coin: 'BTC', isBuy: false, sz: 1, reduceOnly: true, thesis: '平掉逆势多头，结构已破' }
  await assert.rejects(decide.execute(args, exec('s')), (error) => !/连续/.test(error.message))
  await assert.rejects(decide.execute(args, exec('s')), /连续 2 次被拒.*protect/s)
  await assert.rejects(decide.execute(args, exec('other')), (error) => !/连续/.test(error.message), 'counted per session')
}

// 6) The user can set the 盯盘 interval; it wins over the strategy timeframe until reset to auto.
{
  const store = new HyperStore(mkdtempSync(join(tmpdir(), 'dhl-watch-')))
  store.registerSession('w', { coin: 'BTC' })
  store.saveJournal({ profile: {}, strategies: [{ id: 'x', status: 'active', timeframe: '1h 节奏（15m 触发）' }], entries: [] }, 'w')
  const remote = { store, cfg: { network: 'testnet' }, status: async () => ({}) }
  const session = buildToolDefinitions(remote).find((tool) => tool.name === 'hyper_session')
  let result = await session.execute({ action: 'watch', on: true }, exec('w'))
  assert.match(result.text, /15m K 线.*跟随策略/, 'without an override the shortest strategy timeframe is watched')
  result = await session.execute({ action: 'watch', on: true, interval: '1h' }, exec('w'))
  assert.match(result.text, /1h K 线.*本会话指定/)
  assert.equal(new HyperStore(store.dataDir).getSession('w').watchInterval, '1h', 'the interval survives a restart')
  assert.throws(() => store.configureSession('w', { watchInterval: '3m' }), /盯盘周期/)
  const reads = []
  const monitor = createStrategyBarMonitor({ cfg: { network: 'testnet' }, store: { listSessions: () => [store.getSession('w')], journal: (id) => store.journal(id) },
    candles: async ({ interval }) => { reads.push(interval); return { candles: [] } } }, { notify: () => true, now: () => 10 * 3_600_000 })
  await monitor.check()
  assert.deepEqual(reads, ['1h'], 'the monitor reads the interval the user chose')
  await session.execute({ action: 'watch', on: true, interval: 'auto' }, exec('w'))
  assert.equal(sessionWatch(store, store.getSession('w')).watchInterval, '15m', 'auto follows the strategies again')
}

// 7) The wake carries the higher timeframes, the protection state and the plan.
{
  const HOUR = 3_600_000, now = 400 * HOUR + 60_000
  const series = (interval, step, slope) => Array.from({ length: 120 }, (_, i) => {
    const t = now - (120 - i) * step
    return { t, T: t + step - 1, o: 100 + i * slope, h: 101 + i * slope, l: 99 + i * slope, c: 100 + i * slope, v: 10 }
  })
  assert.match(frameLine('4h', series('4h', 4 * HOUR, -1), now), /^4h：收 .*空头排列/)
  assert.match(frameLine('1h', series('1h', HOUR, 1), now), /多头排列/)
  assert.match(protectionLine({ ownershipConfirmed: true, sessionId: 's', sessionSize: 0.005, pendingExits: [] }), /⚠ .*protect/, 'a position without a stop is flagged')
  assert.match(protectionLine({ ownershipConfirmed: true, sessionId: 's', sessionSize: 0.004, entryPx: 81851,
    pendingExits: [{ sessionId: 's', isTrigger: true, orderType: 'Stop Market', sz: '0.004', triggerPx: '81560' }] }), /止损 81,560 ✓/)
  assert.match(protectionLine({ ownershipConfirmed: false, accountSize: 0.005 }), /归属未确认/)
  const store = new HyperStore(mkdtempSync(join(tmpdir(), 'dhl-digest-')))
  store.registerSession('s', { coin: 'BTC' })
  store.saveJournal({ profile: {}, strategies: [{ id: 'v8', name: '多周期结构', status: 'testing', version: 8, markets: 'BTC' }],
    entries: [{ type: 'plan', sessionId: 's', coin: 'BTC', at: now, text: '反抽 83,100 不过看 82,350' }] }, 's')
  const intervalMs = { '15m': HOUR / 4, '1h': HOUR, '4h': 4 * HOUR, '1d': 24 * HOUR }
  const asked = []
  const lines = await watchDigest({ store, candles: async ({ interval, startMs }) => { asked.push([interval, startMs]); return { candles: series(interval, intervalMs[interval], 1) } },
    sessionExecution: async () => ({ ownershipConfirmed: true, sessionId: 's', sessionSize: 0 }) }, { sessionId: 's', coin: 'BTC', interval: '15m', now })
  assert.deepEqual(asked.map(([interval]) => interval), ['15m', '1h', '4h', '1d'], 'the watch interval plus two higher frames and the daily regime')
  assert.ok(lines.some((line) => line.startsWith('4h：')) && lines.includes('本会话：空仓。') && lines.some((line) => line.includes('[v8]') && line.includes('82,350')))
  const journal = { strategies: [], entries: [{ type: 'plan', sessionId: 's', coin: 'BTC', at: now - 2 * HOUR, text: '加仓到 0.018' }] }
  assert.match(planLine(journal, { sessionId: 's', coin: 'BTC', now }), /0\.018/)
  assert.equal(planLine(journal, { sessionId: 's', coin: 'BTC', now: now + 25 * HOUR }), null, 'a day-old plan is not re-issued every round')
  journal.entries.push({ type: 'trade', sessionId: 's', coin: 'BTC', at: now - HOUR, resultR: -1, text: 'stopped' })
  assert.equal(planLine(journal, { sessionId: 's', coin: 'BTC', now }), null, 'a plan closed by a trade is no longer in force')
  const text = marketBarWakeText([{ coin: 'BTC', interval: '15m', candle: { t: now, o: 1, h: 1, l: 1, c: 1, v: 1 }, strategyIds: ['v8'], digest: lines }])
  assert.ok(text.indexOf('交易台快照') > 0 && text.indexOf('交易台快照') < text.indexOf('1. 判市'), 'facts come before the protocol')
  assert.match(text, /ask_user_question/); assert.match(text, /下一根盯盘周期收盘/)
  assert.match(marketBarWakeText([{ coin: 'BTC', interval: '15m', candle: { t: now, o: 1, h: 1, l: 1, c: 1, v: 1 }, strategyIds: [] }]), /快照未取到/)
}

// 8) Indicators fetch enough history for the longest requested average.
{
  const asked = []
  const remote = { store: {}, candles: async (request) => { asked.push(request); return { candles: [] } } }
  const market = buildToolDefinitions(remote).find((tool) => tool.name === 'hyper_market')
  await market.execute({ action: 'indicators', coin: 'BTC', interval: '1d', ma: [{ kind: 'sma', period: 200 }] })
  const days = (Date.now() - asked[0].startMs) / 86_400_000
  assert.ok(days >= 450, `MA200 on 1d reads ${Math.round(days)} days of history`)
}

console.log('保护单：先挂新再撤旧、归属锁下紧急止损、减仓后修剪剩余保护、paper 替换、重复阻断升级、盯盘周期、唤醒快照与长均线历史通过')
