import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TradingGuard } from '../lib/trading-guard.js'
import { HyperRemote } from '../lib/remote.js'

const dir = mkdtempSync(join(tmpdir(), 'dhl-risk-'))
const limits = { dataDir: dir, allowedCoins: ['BTC'], maxOrderUsd: 120, maxDailyUsd: 200, maxPositionUsd: 300, maxLeverage: 2 }
const guard = new TradingGuard(dir, limits)
const base = { coin: 'BTC', isBuy: true, sz: 1, price: 100, positionSize: 0, otherExposureUsd: 0, accountValue: 1000, leverage: 1, reduceOnly: false }
assert.equal(guard.validate(base).notionalUsd, 100)
assert.throws(() => guard.validate({ ...base, coin: 'ETH' }), /允许交易币对/)
assert.throws(() => guard.validate({ ...base, sz: 2 }), /单笔/)
assert.throws(() => guard.validate({ ...base, reduceOnly: true }), /只减仓/)
assert.throws(() => guard.validate({ ...base, positionSize: 1, isBuy: false, sz: 1.5, reduceOnly: true }), /只减仓/)
assert.throws(() => guard.validate({ ...base, accountValue: 50, otherExposureUsd: 100 }), /敞口/)
guard.reserve(100)
assert.equal(new TradingGuard(dir, limits).budget.usedUsd, 100)
assert.throws(() => guard.reserve(101), /额度/)
const emergencyClose = guard.validate({ ...base, coin: 'ETH', isBuy: false, sz: 2, positionSize: 2, accountValue: -1, leverage: 5, reduceOnly: true })
assert.equal(emergencyClose.riskReducing, true)
guard.reserve(emergencyClose.notionalUsd, { riskReducing: emergencyClose.riskReducing })
assert.equal(guard.budget.usedUsd, 100, 'closing an existing position must not consume daily entry budget')

const remote = Object.create(HyperRemote.prototype)
remote.cfg = { tradingMode: 'live', autonomousLive: true, network: 'testnet', maxLeverage: 2, allowedCoins: ['BTC'] }
remote.guard = guard
const liveJournal = new Map()
remote.store = {
  recordEvent() {},
  recordLiveDecision() {},
  getSession(id) { return id === 'session-1' ? { sessionId: id } : null },
  recordLiveOrder(cloid, patch) { liveJournal.set(cloid, { ...liveJournal.get(cloid), ...patch }) },
}
remote.client = {}
remote.markets = async () => ({ universe: [{ name: 'BTC', szDecimals: 3 }] })
remote.midOf = async () => 100
remote.checkLiveOrder = async () => ({ mid: 100, notionalUsd: 50, coin: 'BTC', side: 'buy', positionSize: 0, nextSize: 0.5, network: remote.cfg.network })
let submissions = 0
remote.submitAction = async () => { submissions += 1; return { status: 'ok', response: { data: { statuses: [{ filled: { totalSz: '0.5' } }] } } } }
const intent = { coin: 'BTC', isBuy: true, sz: 0.5, type: 'market', thesis: '行情和仓位支持测试计划，但价格偏离时放弃。' }
const plan = await remote.prepareOrder(intent, 'session-1')
await assert.rejects(remote.placeOrder({ ...intent, decisionId: plan.decisionId }), /仅允许从 DSH agent/)
await assert.rejects(remote.executeToolOrder({ ...intent, sz: 0.6, decisionId: plan.decisionId }, { agent: { id: 'session-1' } }, 'session-1'), /不一致/)
const plan2 = await remote.prepareOrder(intent, 'session-1')
const result = await remote.executeToolOrder({ ...intent, decisionId: plan2.decisionId }, { agent: { id: 'session-1' } }, 'session-1')
assert.equal(result.mode, 'live')
assert.match(result.cloid, /^0x[0-9a-f]{32}$/)
assert.equal(liveJournal.get(result.cloid).status, 'accepted')
assert.equal(submissions, 1)
await assert.rejects(remote.executeToolOrder({ ...intent, decisionId: plan2.decisionId }, { agent: { id: 'session-1' } }, 'session-1'), /已失效/)
assert.equal(new TradingGuard(dir, limits).budget.usedUsd, 150)

remote.submitAction = async () => { throw new Error('timeout') }
const plan3 = await remote.prepareOrder(intent, 'session-1')
await assert.rejects(remote.executeToolOrder({ ...intent, decisionId: plan3.decisionId }, { agent: { id: 'session-1' } }, 'session-1'), /orderStatus/)
const unknownCloid = '0x' + plan3.decisionId.replaceAll('-', '')
assert.equal(liveJournal.get(unknownCloid).status, 'unknown')
assert.equal(new TradingGuard(dir, limits).budget.usedUsd, 200)

const rejectDir = mkdtempSync(join(tmpdir(), 'dhl-rejected-'))
remote.guard = new TradingGuard(rejectDir, { ...limits, dataDir: rejectDir })
remote.submitAction = async () => ({ status: 'err', response: 'insufficient margin' })
const plan4 = await remote.prepareOrder(intent, 'session-1')
await assert.rejects(remote.executeToolOrder({ ...intent, decisionId: plan4.decisionId }, { agent: { id: 'session-1' } }, 'session-1'), /Hyperliquid 拒绝操作/)
const rejectedCloid = '0x' + plan4.decisionId.replaceAll('-', '')
assert.equal(liveJournal.get(rejectedCloid).status, 'rejected')
assert.equal(new TradingGuard(rejectDir, { ...limits, dataDir: rejectDir }).budget.usedUsd, 0)

const actions = []
remote.approvalGateway = () => ({ request: async () => { throw new Error('autonomous flow must not request host approval') } })
remote.submitAction = async (action) => {
  actions.push(action)
  return { status: 'ok', response: { data: { statuses: [{ success: true }] } } }
}
const exec = { agent: { id: 'session-1' }, callId: 'acceptance' }
assert.equal((await remote.executeToolLeverage({ coin: 'BTC', leverage: 2 }, exec)).mode, 'live')
assert.equal((await remote.executeToolCancel({ coin: 'BTC', oid: 123 }, exec)).mode, 'live')
assert.deepEqual(actions, [
  { type: 'updateLeverage', asset: 0, isCross: true, leverage: 2 },
  { type: 'cancel', cancels: [{ a: 0, o: 123 }] },
])
const approvalRequests = []
remote.approvalGateway = () => ({ request: async (req) => { approvalRequests.push(req); return 'denied' } })
await assert.rejects(remote.executeToolCancel({ coin: 'ETH', oid: 125 }, exec), /未批准/)
assert.equal(approvalRequests[0].reason, approvalRequests[0].displayReason.zh, 'audit reason stays the Chinese text')
assert.match(approvalRequests[0].displayReason.en, /cancel ETH order oid=125/)
assert.equal(actions.length, 2)
remote.cfg.autonomousLive = false
await assert.rejects(remote.executeToolCancel({ coin: 'BTC', oid: 124 }, exec), /未批准/)
assert.equal(actions.length, 2)

remote.cfg.tradingMode = 'paper'
await assert.rejects(remote.executeToolOrder({ coin: 'BTC', isBuy: true, sz: 0.5 }, exec, 'unregistered'), /已登记的交易会话/)
assert.throws(() => remote.executeToolLeverage({ coin: 'BTC', leverage: 2 }, { agent: { id: 'unregistered' } }), /已登记的交易会话/)
remote.desk = { coin: 'BTC', interval: '15m' }
remote.store.bindCoin = () => { throw new Error('not registered') }
await assert.rejects(remote.bindCoin({ sessionId: 'missing', coin: 'ETH' }), /not registered/)
assert.equal(remote.desk.coin, 'BTC')
remote.store.bindCoin = (sessionId, coin) => ({ sessionId, coin })
remote.desk.sessionId = 'session-1'
await remote.bindCoin({ sessionId: 'background-session', coin: 'ETH' })
assert.equal(remote.desk.coin, 'BTC')

// paper 已支持从空仓开仓附带保护单（触发、OCO、重启去重见 paper-protection.test.mjs），
// 旧的「paper 暂不模拟」语义已废弃，此处不再断言。
const bracketDir = mkdtempSync(join(tmpdir(), 'dhl-bracket-'))
remote.cfg = { ...remote.cfg, tradingMode: 'live', autonomousLive: true }
remote.guard = new TradingGuard(bracketDir, { ...limits, dataDir: bracketDir })
let bracketAction
remote.submitAction = async (action) => {
  bracketAction = action
  return { status: 'ok', response: { data: { statuses: [{ resting: { oid: 1 } }, { resting: { oid: 2 } }, { resting: { oid: 3 } }] } } }
}
const bracketIntent = { ...intent, type: 'limit', px: 100, takeProfitPx: 120, stopLossPx: 80 }
const bracketPlan = await remote.prepareOrder(bracketIntent, 'session-1')
const bracketResult = await remote.executeToolOrder({ ...bracketIntent, decisionId: bracketPlan.decisionId }, exec, 'session-1')
assert.equal(bracketResult.protectionState, 'parent-not-fully-filled')
assert.equal(liveJournal.get(bracketResult.cloid).protectionState, 'parent-not-fully-filled')
assert.equal(bracketAction.grouping, 'normalTpsl')
assert.equal(bracketAction.orders.length, 3)
assert.deepEqual(bracketAction.orders.map((row) => row.t.trigger?.tpsl ?? 'parent'), ['parent', 'tp', 'sl'])
assert.equal(bracketAction.orders[1].r, true)
assert.equal(bracketAction.orders[1].b, false)

remote.submitAction = async () => ({ status: 'ok', response: { data: { statuses: [{ resting: { oid: 4 } }, { error: 'bad trigger' }, { resting: { oid: 6 } }] } } })
const partialPlan = await remote.prepareOrder(bracketIntent, 'session-1')
await assert.rejects(remote.executeToolOrder({ ...bracketIntent, decisionId: partialPlan.decisionId }, exec, 'session-1'), /主单可能已生效/)
assert.equal(liveJournal.get('0x' + partialPlan.decisionId.replaceAll('-', '')).status, 'protection-unknown')
assert.equal(new TradingGuard(bracketDir, { ...limits, dataDir: bracketDir }).budget.usedUsd, 100)
remote.checkLiveOrder = HyperRemote.prototype.checkLiveOrder
remote.resolveAddress = async () => '0x' + '12'.repeat(20)
remote.client.allMids = async () => ({ mids: { BTC: '100' } })
remote.client.clearinghouseState = async () => ({ marginSummary: { accountValue: '1000' }, assetPositions: [] })
remote.client.userAbstraction = async () => 'default'
await assert.rejects(remote.prepareOrder({ ...bracketIntent, takeProfitPx: 90 }, 'session-1'), /止盈价/)
await assert.rejects(remote.prepareOrder({ ...bracketIntent, stopLossPx: 110 }, 'session-1'), /止损价/)
remote.cfg.network = 'mainnet'
remote.submitAction = async (action) => {
  bracketAction = action
  return { status: 'ok', response: { data: { statuses: [{ filled: { totalSz: String(bracketIntent.sz) } }, { resting: { oid: 8 } }, { resting: { oid: 9 } }] } } }
}
const mainnetPlan = await remote.prepareOrder(bracketIntent, 'session-1')
const mainnetResult = await remote.executeToolOrder({ ...bracketIntent, decisionId: mainnetPlan.decisionId }, exec, 'session-1')
assert.equal(bracketAction.grouping, 'normalTpsl')
assert.equal(bracketAction.orders[2].t.trigger.tpsl, 'sl')
assert.equal(mainnetResult.protectionState, 'verify-active')

writeFileSync(join(dir, 'live-budget.json'), '{broken')
assert.throws(() => new TradingGuard(dir, limits), /Unexpected|JSON/)
console.log('交易权限、一次性决策和持久额度通过')
