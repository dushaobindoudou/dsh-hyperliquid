// HIP-3 (builder-deployed) perps trade through the same order path as core perps: asset id
// 100000 + perpDexIndex * 10000 + index in that dex's meta, priced from the dex's own mids.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HyperRemote } from '../lib/remote.js'
import { HyperStore } from '../lib/store.js'
import { normalizeRiskSettings } from '../lib/risk-settings.js'
import { TradingGuard } from '../lib/trading-guard.js'

const dir = mkdtempSync(join(tmpdir(), 'dhl-hip3-'))
const remote = Object.create(HyperRemote.prototype)
remote.cfg = { tradingMode: 'live', autonomousLive: true, network: 'mainnet', maxLeverage: 20, allowedCoins: ['BTC', 'xyz:XYZ100', 'xyz:GOLD'], dataDir: dir,
  maxOrderUsd: 1000, maxDailyUsd: 5000, maxPositionUsd: 5000 }
remote.store = new HyperStore(dir)
remote.store.registerSession('s1', { coin: 'xyz:XYZ100' })
const calls = []
remote.client = {
  async info(type, extra = {}) {
    calls.push([type, extra])
    if (type === 'perpDexs') return [null, { name: 'xyz' }, { name: 'flx' }]
    if (type === 'meta' && extra.dex === 'xyz') return { collateralToken: 0, universe: [
      { name: 'xyz:XYZ100', szDecimals: 4, maxLeverage: 30 }, { name: 'xyz:GOLD', szDecimals: 3, maxLeverage: 10, onlyIsolated: true }] }
    if (type === 'meta' && extra.dex === 'flx') return { collateralToken: 360, universe: [{ name: 'flx:TSLA', szDecimals: 2, maxLeverage: 10 }] }
    if (type === 'allMids' && extra.dex === 'xyz') return { 'xyz:XYZ100': '30000', 'xyz:GOLD': '4000' }
    if (type === 'clearinghouseState' && extra.dex === 'xyz') return { assetPositions: [], marginSummary: { accountValue: '0' }, withdrawable: '0' }
    throw new Error(`unexpected info ${type} ${JSON.stringify(extra)}`)
  },
  async allMids() { return { BTC: '80000' } },
  async clearinghouseState() { return { assetPositions: [], marginSummary: { accountValue: '500' } } },
  snapshot() { return null },
}
remote.markets = async () => ({ universe: [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }], network: 'mainnet' })

assert.deepEqual(await remote.tradeAsset('xyz:XYZ100'), { coin: 'xyz:XYZ100', asset: 110000, dex: 'xyz', szDecimals: 4, maxLeverage: 30, onlyIsolated: false })
assert.equal((await remote.tradeAsset('xyz:GOLD')).asset, 110001)
assert.equal((await remote.tradeAsset('BTC')).asset, 0, 'core perps keep their meta index')
await assert.rejects(remote.tradeAsset('flx:TSLA'), /非 USDC 保证金/, 'non-USDC collateral dexes stay view only')
await assert.rejects(remote.tradeAsset('xyz:NOPE'), /没有合约/)
assert.equal(await remote.midOf('xyz:XYZ100'), 30000, 'HIP-3 mids come from the dex')

// cancel and leverage address the HIP-3 asset id
const submitted = []
remote.submitAction = async (action) => { submitted.push(action); return { status: 'ok', response: { type: 'default' } } }
await remote.executeToolCancel({ coin: 'xyz:XYZ100', oid: 42 }, { agent: { id: 's1' } })
assert.deepEqual(submitted.at(-1), { type: 'cancel', cancels: [{ a: 110000, o: 42 }] })
await remote.executeToolLeverage({ coin: 'xyz:XYZ100', leverage: 5 }, { agent: { id: 's1' } })
assert.deepEqual(submitted.at(-1), { type: 'updateLeverage', asset: 110000, isCross: true, leverage: 5 })
await assert.rejects(remote.executeToolLeverage({ coin: 'xyz:GOLD', leverage: 5, marginMode: 'cross' }, { agent: { id: 's1' } }), /只支持逐仓/)
await remote.executeToolLeverage({ coin: 'xyz:GOLD', leverage: 5 }, { agent: { id: 's1' } })
assert.equal(submitted.at(-1).isCross, false, 'isolated-only markets default to isolated')
await assert.rejects(remote.executeToolLeverage({ coin: 'xyz:XYZ100', leverage: 31 }, { agent: { id: 's1' } }), /上限 30x/)

// a live pre-check on an empty HIP-3 dex explains how to fund it instead of calling it a platform limit
remote.resolveAddress = async () => '0x0000000000000000000000000000000000000001'
remote.accountMode = async () => 'default'
await assert.rejects(remote.checkLiveOrder({ coin: 'xyz:XYZ100', isBuy: true, sz: 0.01, type: 'market', reduceOnly: false }), /划转到 xyz.*统一账户/)
assert.ok(calls.some(([type, extra]) => type === 'clearinghouseState' && extra.dex === 'xyz'), 'margin is read from the HIP-3 dex clearinghouse')

// paper trading fills a HIP-3 order at the dex mid
remote.cfg.tradingMode = 'paper'
const fill = await remote.placeOrder({ coin: 'xyz:XYZ100', isBuy: true, sz: 0.01, reason: 'wedge retest short-cover test' })
assert.equal(fill.mode, 'paper')
assert.ok(Math.abs(fill.fill.px / 30000 - 1) < 0.01, `paper fill near the dex mid (${fill.fill.px})`)
assert.equal(remote.store.paperAccount().positions['xyz:XYZ100'].size, 0.01)

// allowed coins accept the display alias and store the official name
assert.deepEqual(normalizeRiskSettings({ allowedCoins: 'BTC, xyz:100', maxOrderUsd: 100, maxDailyUsd: 500, maxPositionUsd: 500, maxLeverage: 10 }).allowedCoins, ['BTC', 'xyz:XYZ100'])

// Standard dex balances are independent; unified balances collateralize all dexes.
remote.cfg.tradingMode = 'live'
remote.cfg.maxLeverage = 2
remote.guard = new TradingGuard(mkdtempSync(join(tmpdir(), 'dhl-dex-exposure-')), remote.cfg)
const info = remote.client.info.bind(remote.client)
let invalidFlx = false
let otherExposure = 0
remote.client.info = async (type, extra) => {
  if (type === 'perpDexs') return [null, { name: 'xyz' }, { name: 'flx' }, { name: 'other' }]
  if (type === 'allPerpMetas') return [{ collateralToken: 0 }, { collateralToken: 0 }, { collateralToken: 360 }, { collateralToken: 0 }]
  if (type === 'clearinghouseState' && extra.dex === 'xyz') return { marginSummary: { accountValue: '100' }, assetPositions: [] }
  if (type === 'clearinghouseState' && extra.dex === 'flx') return invalidFlx ? {} : { assetPositions: [{ position: { coin: 'flx:TSLA', positionValue: '190' } }] }
  if (type === 'clearinghouseState' && extra.dex === 'other') return invalidFlx ? {} : { assetPositions: [{ position: { coin: 'other:GOLD', positionValue: String(otherExposure) } }] }
  return info(type, extra)
}
remote.client.clearinghouseState = async () => ({ marginSummary: { accountValue: '1000' }, assetPositions: [{ position: { coin: 'ETH', positionValue: '10000' } }] })
const smallXyz = { coin: 'xyz:XYZ100', isBuy: true, sz: 0.001, type: 'market', reduceOnly: false }
const independent = await remote.checkLiveOrder(smallXyz)
assert.equal(independent.otherExposureUsd, 0, 'core exposure does not consume an independent HIP-3 balance')
remote.client.clearinghouseState = async () => ({ assetPositions: [] })
remote.client.spotClearinghouseState = async () => ({ balances: [{ coin: 'USDC', token: 0, total: '100' }] })
remote.client.activeAssetData = async (_address, coin) => ({ coin, availableToTrade: ['100', '100'], maxTradeSzs: ['1', '1'] })
remote.accountMode = async () => 'unifiedAccount'
assert.equal((await remote.checkLiveOrder(smallXyz)).otherExposureUsd, 0, 'non-USDC dex exposure does not consume shared USDC')
otherExposure = 190
await assert.rejects(remote.checkLiveOrder(smallXyz), /全账户敞口/, 'another HIP-3 dex consumes shared collateral')
await assert.rejects(remote.checkLiveOrder({ ...smallXyz, coin: 'BTC', sz: 0.0002 }), /全账户敞口/, 'core orders also count HIP-3 exposure')
invalidFlx = true
await assert.rejects(remote.checkLiveOrder(smallXyz), /持仓状态未确认/, 'missing dex positions fail closed')
console.log('HIP-3 永续：资产编号、按 dex 取价与保证金、撤单/杠杆、逐仓限制、模拟盘与允许币对通过')
