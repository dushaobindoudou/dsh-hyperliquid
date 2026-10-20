import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HyperRemote } from '../lib/remote.js'
import { HyperStore } from '../lib/store.js'
import { TradingGuard } from '../lib/trading-guard.js'

const dir = mkdtempSync(join(tmpdir(), 'dhl-paper-protection-'))
const remote = Object.create(HyperRemote.prototype)
remote.cfg = { tradingMode: 'paper', network: 'mainnet', dataDir: dir, allowedCoins: ['ETH'],
  maxOrderUsd: 1000, maxDailyUsd: 2000, maxPositionUsd: 1000, maxLeverage: 2 }
remote.store = new HyperStore(dir, 'mainnet')
remote.paperGuard = new TradingGuard(dir, remote.cfg, { budgetName: 'paper-budget-mainnet.json' })
remote.client = { snapshot: () => ({ at: Date.now(), data: { mids: { ETH: '100' } } }) }
remote.markets = async () => ({ universe: [{ name: 'ETH', szDecimals: 3, maxLeverage: 50 }] })
remote.midOf = async () => 100

await remote.placeOrder({ coin: 'ETH', isBuy: true, sz: 1, stopLossPx: 95, takeProfitPx: 110, reason: 'test protected entry' })
assert.equal(remote.store.paper.positions.ETH.size, 1)
assert.equal(remote.store.paper.protections.ETH.stopLossPx, 95)
assert.equal(remote.processPaperProtections(Date.now(), { ETH: 94 }).length, 1)
assert.equal(remote.store.paper.positions.ETH, undefined, 'stop closes the position')
assert.equal(remote.store.paper.protections.ETH, undefined, 'the other side of the bracket is canceled')
assert.equal(remote.processPaperProtections(Date.now(), { ETH: 93 }).length, 0, 'one crossing cannot close twice')
assert.equal(new HyperStore(dir, 'mainnet').paper.positions.ETH, undefined, 'closed state survives restart')

await remote.placeOrder({ coin: 'ETH', isBuy: true, sz: 1, stopLossPx: 95, takeProfitPx: 110, reason: 'test take profit' })
assert.equal(remote.processPaperProtections(Date.now(), { ETH: 111 }).length, 1)
assert.equal(remote.store.paper.positions.ETH, undefined)

console.log('paper bracket stop/take-profit execution, OCO, restart and dedupe passed')
