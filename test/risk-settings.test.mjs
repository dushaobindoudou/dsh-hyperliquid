import assert from 'node:assert/strict'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { HyperStore } from '../lib/store.js'
import { HyperRemote } from '../lib/remote.js'
import { TradingGuard } from '../lib/trading-guard.js'
import { normalizeRiskSettings, coinAllowed } from '../lib/risk-settings.js'

const dir = mkdtempSync(join(tmpdir(), 'dhl-risk-settings-'))
const base = { allowedCoins: ['BTC'], maxOrderUsd: 100, maxDailyUsd: 500, maxPositionUsd: 500, maxLeverage: 2 }
const remote = Object.create(HyperRemote.prototype)
remote.cfg = { dataDir: dir, network: 'testnet', tradingMode: 'paper', ...base }
remote.baseRiskSettings = base
remote.store = new HyperStore(dir)
remote.guard = new TradingGuard(dir, { dataDir: dir, ...base })
remote.paperGuard = new TradingGuard(dir, { dataDir: dir, ...base }, { budgetName: 'paper-budget.json' })
remote.activeTradeOps = 0
remote.riskSettingsOverride = false

const order = { coin: 'BTC', isBuy: true, sz: 1.15, price: 100, positionSize: 0, otherExposureUsd: 0, accountValue: 1000, leverage: 3, reduceOnly: false }
assert.throws(() => remote.paperGuard.validate(order), /杠杆/)
remote.guard.create({ coin: 'BTC' }, 'session', { mid: 100 })
await remote.updateRiskSettings({ limits: { allowedCoins: 'BTC, ETH, BTC', maxOrderUsd: 125, maxDailyUsd: 500, maxPositionUsd: 500, maxLeverage: 3 } })
assert.deepEqual(remote.cfg.allowedCoins, ['BTC', 'ETH'])
assert.equal(remote.riskSettingsOverride, true)
assert.equal(remote.guard.plans.size, 0, 'old live decisions are invalidated')
assert.ok(Math.abs(remote.paperGuard.validate(order).notionalUsd - 115) < 1e-8)
assert.equal(remote.guard.limits.maxLeverage, 3)
assert.equal(remote.store.events.at(-1).kind, 'risk.changed')
assert.deepEqual(new HyperStore(dir).getRiskSettings(), normalizeRiskSettings({ allowedCoins: ['BTC', 'ETH'], maxOrderUsd: 125, maxDailyUsd: 500, maxPositionUsd: 500, maxLeverage: 3 }))
const restarted = new HyperRemote(new Context(), { dataDir: dir, network: 'testnet', tradingMode: 'paper', allowedCoins: 'BTC', maxOrderUsd: 100, maxDailyUsd: 500, maxPositionUsd: 500, maxLeverage: 2 })
assert.equal(restarted.cfg.maxLeverage, 3, 'desk policy overrides plugin defaults after host restart')
assert.equal(restarted.paperGuard.limits.maxOrderUsd, 125)
restarted.stopWs()
const saved = remote.store.getRiskSettings()
await assert.rejects(remote.updateRiskSettings({ limits: { ...saved, maxLeverage: 51 } }), /maxLeverage/)
assert.deepEqual(remote.store.getRiskSettings(), saved, 'invalid edit does not change the persisted policy')
remote.activeTradeOps = 1
await assert.rejects(remote.resetRiskSettings(), /交易操作仍在进行/)
remote.activeTradeOps = 0
await remote.resetRiskSettings()
assert.equal(remote.riskSettingsOverride, false)
assert.equal(remote.guard.limits.maxLeverage, 2)
assert.throws(() => remote.paperGuard.validate(order), /杠杆/)
assert.equal(existsSync(join(dir, 'risk-settings.json')), false)
const restored = new HyperRemote(new Context(), { dataDir: dir, network: 'testnet', tradingMode: 'paper', allowedCoins: 'BTC', maxOrderUsd: 100, maxDailyUsd: 500, maxPositionUsd: 500, maxLeverage: 2 })
assert.equal(restored.cfg.maxLeverage, 2)
restored.stopWs()
// 全部 / 手动设置: '*' allows every market and stands alone
const limitsOf = (allowedCoins) => normalizeRiskSettings({ allowedCoins, maxOrderUsd: 100, maxDailyUsd: 500, maxPositionUsd: 500, maxLeverage: 3 })
assert.deepEqual(limitsOf('*').allowedCoins, ['*'])
assert.deepEqual(limitsOf('BTC, *, ETH').allowedCoins, ['*'], 'any * means all')
assert.deepEqual(limitsOf(' BTC , xyz:XYZ100 ').allowedCoins, ['BTC', 'xyz:XYZ100'])
assert.throws(() => limitsOf(''), /币对无效/, 'manual mode still needs at least one coin')
assert.ok(coinAllowed(['*'], 'SOL') && coinAllowed(['*'], 'xyz:XYZ100') && coinAllowed(['BTC'], 'BTC') && !coinAllowed(['BTC'], 'SOL'))
const allGuard = new TradingGuard(dir, { dataDir: dir, ...base, allowedCoins: ['*'], maxLeverage: 3, maxOrderUsd: 125 }, { budgetName: 'all-budget.json' })
assert.ok(allGuard.validate({ ...order, coin: 'SOL' }).notionalUsd > 0, 'all markets: any coin passes the allow-list')
assert.throws(() => allGuard.validate({ ...order, coin: 'SOL', sz: 5 }), /单笔名义价值/, 'the other limits still apply')
await remote.updateRiskSettings({ limits: { allowedCoins: '*', maxOrderUsd: 125, maxDailyUsd: 500, maxPositionUsd: 500, maxLeverage: 3 } })
assert.deepEqual(remote.cfg.allowedCoins, ['*'])
assert.ok(remote.paperGuard.validate({ ...order, coin: 'DOGE' }).notionalUsd > 0, 'the desk setting reaches the guards')
await remote.updateRiskSettings({ limits: { allowedCoins: 'BTC', maxOrderUsd: 125, maxDailyUsd: 500, maxPositionUsd: 500, maxLeverage: 3 } })
assert.throws(() => remote.paperGuard.validate({ ...order, coin: 'DOGE' }), /不在允许交易币对内/, 'back to manual')

console.log('交易限额保存、即时风控、旧决策失效、恢复与持久化通过')
