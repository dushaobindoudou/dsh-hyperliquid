import assert from 'node:assert/strict'
import { Config } from '../index.js'
import { HyperRemote } from '../lib/remote.js'
import { buildToolDefinitions } from '../lib/tools.js'

const defaults = Config({})
assert.equal(defaults.network, 'mainnet')
assert.equal(defaults.tradingMode, 'live')
assert.equal(defaults.privateKey, '')
assert.equal(defaults.tradingAddress, '')
assert.throws(() => Config({ network: 'MAINNET' }), /network/)
assert.throws(() => Config({ maxOrderUsd: 'abc' }), /maxOrderUsd/)

const remote = Object.create(HyperRemote.prototype)
remote.cfg = { tradingMode: 'live' }
remote.resolveAddress = async () => '0x0000000000000000000000000000000000000001'
remote.markets = async () => ({ universe: [{ name: 'BTC', szDecimals: 5, ctx: { markPx: '83000' } }] })
remote.lastTouch = new Map()
let modeReads = 0
remote.client = {
  subs: new Map(),
  subscribe(key) { this.subs.set(key, { listeners: 1 }) },
  snapshot: () => null,
  userAbstraction: async () => { modeReads += 1; return 'default' },
  clearinghouseState: async () => ({
    marginSummary: { accountValue: '1000' }, withdrawable: '700',
    assetPositions: [{ position: {
      coin: 'BTC', szi: '0.01', entryPx: '80000', positionValue: '830', unrealizedPnl: '30',
      leverage: { type: 'cross', value: 3 }, liquidationPx: '47000', marginUsed: '276',
      returnOnEquity: '0.108', cumFunding: { sinceOpen: '-1.2', allTime: '-3.4' }, maxLeverage: 50,
    } }],
  }),
  frontendOpenOrders: async () => [{ coin: 'BTC', oid: 123, limitPx: '84000', sz: '0.01' }],
}
const account = await remote.account()
await remote.account()
assert.equal(modeReads, 1, 'polling should reuse a recent account-mode result')
assert.equal(account.accountMode, 'default')
assert.equal(account.balanceSource, 'perp')
assert.equal(account.positions[0].markPx, 83000)
assert.equal(account.positions[0].liquidationPx, 47000)
assert.equal(account.positions[0].returnOnEquity, 0.108)
assert.equal(account.positions[0].marginUsed, 276)
assert.equal(account.positions[0].cumFunding.sinceOpen, '-1.2')
assert.equal(account.openOrders.length, 1)
const coreState = await remote.client.clearinghouseState()
remote.client.clearinghouseState = async () => { throw new Error('fresh all-DEX WS should avoid core REST') }
remote.client.snapshot = () => ({ at: Date.now(), data: { user: '0x0000000000000000000000000000000000000001', clearinghouseStates: [
  ['', coreState],
  ['test', { marginSummary: { accountValue: '5' }, withdrawable: '4', assetPositions: [{ position: {
    coin: 'test:ABC', szi: '2', entryPx: '9', positionValue: '20', unrealizedPnl: '2', leverage: { type: 'cross', value: 2 },
  } }] }],
] } })
const allDexs = await remote.account({ coin: 'test:ABC' })
assert.equal(allDexs.accountDex, 'test')
assert.equal(allDexs.positionsCoverage, 'all-dexs')
assert.deepEqual(allDexs.positions.map((p) => [p.dex, p.coin]), [['', 'BTC'], ['test', 'test:ABC']])
assert.equal(allDexs.marginSummary.accountValue, '5')
assert.equal(allDexs.positions[1].markPx, 10)
let coreReads = 0
remote.client.clearinghouseState = async () => { coreReads += 1; return coreState }
remote.client.snapshot = () => ({ at: Date.now(), data: { user: '0x0000000000000000000000000000000000000002', clearinghouseStates: [['', coreState]] } })
const wrongUser = await remote.account({ coin: 'BTC' })
assert.equal(wrongUser.positionsCoverage, 'selected-dex', 'another wallet’s WS snapshot must be ignored')
assert.equal(coreReads, 1)
remote.client.snapshot = () => null
const tool = buildToolDefinitions(remote).find((entry) => entry.name === 'hyper_account')
const answer = await tool.execute({ action: 'state' })
assert.match(answer.text, /lev=3x/)
assert.match(answer.text, /ROE=10\.8%/)
assert.match(answer.text, /liq=47,000/)
assert.doesNotMatch(answer.text, /\[object Object\]/)
remote.client.frontendOpenOrders = async () => { throw new Error('rate limited') }
await assert.rejects(remote.account(), /rate limited/, 'failed order read must never become an empty order list')
remote.client.frontendOpenOrders = async () => []
let abstraction = 'unifiedAccount'
remote.client.userAbstraction = async () => abstraction
remote.client.spotClearinghouseState = async () => ({ balances: [{ coin: 'USDC', token: 0, total: '250', hold: '40' }] })
let capacityReads = 0
remote.client.activeAssetData = async (_address, coin) => { capacityReads += 1; return { coin, availableToTrade: ['180', '160'], maxTradeSzs: ['0.002', '0.0018'] } }
await remote.accountMode(await remote.resolveAddress(), true)
const unified = await remote.account({ coin: 'BTC' })
assert.equal(unified.accountMode, 'unifiedAccount')
assert.equal(unified.marginSummary, null, 'perp margin summary must not masquerade as unified equity')
assert.equal(unified.withdrawable, null)
assert.equal(unified.usdcBalance, 250)
assert.equal(unified.unheldUsdc, 210)
assert.deepEqual(unified.tradeCapacity.availableToTrade, ['180', '160'])
await remote.account({ coin: 'BTC' })
assert.equal(capacityReads, 1, 'fast UI polling should reuse capacity within its TTL')
abstraction = 'portfolioMargin'
assert.equal(await remote.accountMode(await remote.resolveAddress(), true), 'portfolioMargin')
assert.equal((await remote.account({ coin: 'BTC' })).accountMode, 'portfolioMargin')
assert.equal(capacityReads, 2, 'a changed account mode must not reuse the prior capacity')
remote.cfg.network = 'testnet'
remote.cfg.signer = 'local'
remote.client.allMids = async () => ({ BTC: '83000' })
remote.client.info = async (type) => { assert.equal(type, 'perpDexs'); return [null] }
remote.guard = { validate: (input) => ({ notionalUsd: input.sz * input.price, nextSize: input.positionSize + input.sz, checkedAccountValue: input.accountValue }) }
const preview = await remote.checkLiveOrder({ coin: 'BTC', isBuy: true, sz: 0.001, type: 'market', reduceOnly: false })
assert.equal(preview.accountMode, 'portfolioMargin')
assert.equal(preview.accountValue, 250, 'risk base must use spot USDC, not stale perp margin summary')
await assert.rejects(remote.checkLiveOrder({ coin: 'BTC', isBuy: true, sz: 0.002, type: 'market', reduceOnly: false }), /可交易额度/)
remote.client.spotClearinghouseState = async () => { throw new Error('spot unavailable') }
await assert.rejects(remote.account({ coin: 'BTC' }), /spot unavailable/)
await assert.rejects(remote.checkLiveOrder({ coin: 'BTC', isBuy: true, sz: 0.001, type: 'market', reduceOnly: false }), /spot unavailable/)
remote.client.userAbstraction = async () => 'futureMode'
await assert.rejects(remote.accountMode(await remote.resolveAddress(), true), /未知账户模式/)
console.log('配置校验、live 持仓风险字段、账户模式与余额来源校验通过')
