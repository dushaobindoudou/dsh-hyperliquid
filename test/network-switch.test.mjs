import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HyperRemote } from '../lib/remote.js'
import { HyperStore } from '../lib/store.js'

const remote = Object.create(HyperRemote.prototype)
remote.cfg = { network: 'testnet', privateKey: '' }
let closed = 0
remote.client = { close() { closed += 1 } }
remote.activeTradeOps = 0
remote.lastTouch = new Map([['book', Date.now()]])
remote.marketsCache = { universe: [{ name: 'BTC' }] }
remote.marketsAt = Date.now()
remote.catalogCache = { markets: [] }
remote.catalogAt = Date.now()
remote.catalogDexIndex = new Map([['BTC', {}]])
remote.detailCache = new Map([['BTC', {}]])
remote.accountModeCache = { mode: 'standard' }
remote.accountModePending = Promise.resolve('standard')
remote.tradeCapacityCache = new Map([['BTC', {}]])
remote.tradeCapacityPending = new Map([['BTC', Promise.resolve({})]])
remote.guard = { plans: new Map([['decision', {}]]) }
const events = []
remote.store = { recordEvent: (...args) => events.push(args) }

await assert.rejects(remote.switchNetwork({ network: 'mainnet' }), /确认/)
assert.equal(closed, 0)
remote.activeTradeOps = 1
await assert.rejects(remote.switchNetwork({ network: 'mainnet', acknowledgeMainnet: true }), /交易操作仍在进行/)
assert.equal(closed, 0)
remote.activeTradeOps = 0
assert.deepEqual(await remote.switchNetwork({ network: 'mainnet', acknowledgeMainnet: true }), { network: 'mainnet' })
assert.equal(closed, 1)
assert.equal(remote.client.network, 'mainnet')
assert.equal(remote.marketsCache, null)
assert.equal(remote.catalogCache, null)
assert.equal(remote.accountModeCache, null)
assert.equal(remote.lastTouch.size, 0)
assert.equal(remote.guard.plans.size, 0, 'old network trade decisions must expire')
assert.deepEqual(events[0], ['network.changed', { from: 'testnet', to: 'mainnet' }])
assert.deepEqual(await remote.switchNetwork({ network: 'mainnet' }), { network: 'mainnet' })
assert.equal(closed, 1, 'same-network selection does not reconnect')
await remote.switchNetwork({ network: 'testnet' })
assert.equal(remote.client.network, 'testnet')
remote.client.close()

const dir = mkdtempSync(join(tmpdir(), 'dhl-network-paper-'))
const paper = new HyperStore(dir, 'testnet')
paper.paperFill({ coin: 'BTC', isBuy: true, sz: 1, px: 100 })
paper.selectPaperNetwork('mainnet')
assert.equal(paper.paper.positions.BTC, undefined, 'mainnet paper ledger starts separate')
paper.paperFill({ coin: 'ETH', isBuy: true, sz: 2, px: 50 })
paper.selectPaperNetwork('testnet')
assert.equal(paper.paper.positions.BTC.size, 1)
assert.equal(paper.paper.positions.ETH, undefined)
paper.selectPaperNetwork('mainnet')
assert.equal(paper.paper.positions.ETH.size, 2)
writeFileSync(join(dir, 'paper-testnet.json'), '{broken')
assert.throws(() => paper.selectPaperNetwork('testnet'), /拒绝重置模拟权益/)
assert.equal(paper.paper.positions.ETH.size, 2, 'failed switch leaves prior paper account intact')
console.log('网络切换确认、交易锁、行情缓存与预检失效通过')

const modeRemote = Object.create(HyperRemote.prototype)
modeRemote.cfg = { network: 'mainnet', tradingMode: 'live' }
modeRemote.activeTradeOps = 0
modeRemote.accountModeCache = { mode: 'standard' }
modeRemote.accountModePending = null
modeRemote.tradeCapacityCache = new Map([['BTC', {}]])
modeRemote.tradeCapacityPending = new Map()
modeRemote.guard = { plans: new Map([['decision', {}]]) }
const modeEvents = []
modeRemote.store = { recordEvent: (...args) => modeEvents.push(args) }
assert.deepEqual(await modeRemote.switchTradingMode({ mode: 'paper' }), { mode: 'paper' })
assert.equal(modeRemote.cfg.tradingMode, 'paper')
assert.equal(modeRemote.guard.plans.size, 0, 'live decision plans do not survive a mode switch')
assert.equal(modeRemote.tradeCapacityCache.size, 0)
assert.deepEqual(modeEvents[0], ['mode.changed', { from: 'live', to: 'paper' }])
await assert.rejects(modeRemote.switchTradingMode({ mode: 'live' }), /确认/)
modeRemote.activeTradeOps = 1
await assert.rejects(modeRemote.switchTradingMode({ mode: 'live', acknowledgeLive: true }), /交易操作仍在进行/)
modeRemote.activeTradeOps = 0
assert.deepEqual(await modeRemote.switchTradingMode({ mode: 'live', acknowledgeLive: true }), { mode: 'live' })
assert.equal(modeRemote.cfg.tradingMode, 'live')
console.log('trading mode switch ok')
