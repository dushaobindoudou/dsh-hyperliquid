import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HyperRemote } from '../lib/remote.js'
import { HyperStore } from '../lib/store.js'
import { TradingGuard } from '../lib/trading-guard.js'

function desk(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dhl-paper-risk-'))
  const remote = Object.create(HyperRemote.prototype)
  remote.cfg = { tradingMode: 'paper', dataDir: dir, allowedCoins: ['BTC'],
    maxOrderUsd: 70, maxDailyUsd: 90, maxPositionUsd: 70, maxLeverage: 2, ...overrides }
  remote.store = new HyperStore(dir)
  remote.paperGuard = new TradingGuard(dir, remote.cfg, { budgetName: 'paper-budget.json' })
  remote.client = { snapshot: () => ({ at: Date.now(), data: { mids: { BTC: '100' } } }) }
  remote.markets = async () => ({ universe: [{ name: 'BTC', maxLeverage: 50 }, { name: 'ETH', maxLeverage: 50 }] })
  remote.midOf = async () => 100
  return remote
}

const remote = desk()
const first = await remote.placeOrder({ coin: 'BTC', isBuy: true, sz: 0.5 })
assert.equal(first.mode, 'paper')
assert.match(first.simulation, /未模拟盘口深度/)
assert.ok(first.marginUsed > 0)
assert.equal(remote.store.paper.fills.length, 1)
await assert.rejects(remote.placeOrder({ coin: 'BTC', isBuy: true, sz: 0.5 }), /仓位超过/)
assert.equal(remote.store.paper.fills.length, 1, 'rejected order must not be filled')
const afterEntry = await remote.account()
assert.ok(afterEntry.availableMargin < afterEntry.equity)
assert.equal(afterEntry.marksConfirmed, true)
assert.ok(afterEntry.marginUsed > 0)
const usedBeforeClose = remote.paperGuard.budget.usedUsd
await remote.placeOrder({ coin: 'BTC', isBuy: false, sz: 0.5, reduceOnly: true })
assert.equal(remote.paperGuard.budget.usedUsd, usedBeforeClose, 'risk-reducing close preserves daily entry budget')
await assert.rejects(remote.placeOrder({ coin: 'BTC', isBuy: true, sz: 0.5 }), /今日下单额/)
assert.equal(new TradingGuard(remote.cfg.dataDir, remote.cfg, { budgetName: 'paper-budget.json' }).budget.usedUsd, usedBeforeClose)
await assert.rejects(remote.placeOrder({ coin: 'ETH', isBuy: true, sz: 0.1 }), /允许交易币对/)
await assert.rejects(remote.setLeverage({ coin: 'BTC', leverage: 3 }), /配置上限/)

const tight = desk({ maxOrderUsd: 500, maxDailyUsd: 1000, maxPositionUsd: 500 })
tight.store.paper.usd = 100
await assert.rejects(tight.placeOrder({ coin: 'BTC', isBuy: true, sz: 1.1 }), /可用保证金不足/)
assert.equal(tight.store.paper.fills.length, 0)
await tight.setLeverage({ coin: 'BTC', leverage: 2 })
await tight.placeOrder({ coin: 'BTC', isBuy: true, sz: 1.1 })
await assert.rejects(tight.placeOrder({ coin: 'BTC', isBuy: true, sz: 1 }), /杠杆敞口|可用保证金不足/)
await assert.rejects(tight.setLeverage({ coin: 'BTC', leverage: 1 }), /保证金不足/)
tight.store.paper.usd = 0
const spent = tight.paperGuard.budget.usedUsd
await tight.placeOrder({ coin: 'BTC', isBuy: false, sz: 1.1, reduceOnly: true })
assert.equal(tight.store.paper.positions.BTC, undefined, 'underwater account can still close the position')
assert.equal(tight.paperGuard.budget.usedUsd, spent)

const stale = desk({ maxOrderUsd: 500, maxDailyUsd: 1000, maxPositionUsd: 500 })
stale.store.paperFill({ coin: 'ETH', isBuy: true, sz: 1, px: 100 })
assert.equal((await stale.account()).marksConfirmed, false)
assert.equal((await stale.account()).availableMargin, null)
await assert.rejects(stale.placeOrder({ coin: 'BTC', isBuy: true, sz: 0.1 }), /ETH 实时价格未确认/)

const corruptDir = mkdtempSync(join(tmpdir(), 'dhl-paper-corrupt-'))
writeFileSync(join(corruptDir, 'paper.json'), '{broken')
assert.throws(() => new HyperStore(corruptDir), /拒绝重置模拟权益/)
const legacyDir = mkdtempSync(join(tmpdir(), 'dhl-paper-legacy-'))
writeFileSync(join(legacyDir, 'paper.json'), JSON.stringify({ usd: 321, positions: {}, fills: [] }))
assert.equal(new HyperStore(legacyDir).paper.usd, 321)
console.log('paper 限额、持久日预算、保证金、减仓通道与损坏账户保护通过')
