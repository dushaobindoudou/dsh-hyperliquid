// Connecting a wallet on the desk takes effect at once (no host restart) and survives restarts.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HyperRemote, normalizeWalletSettings } from '../lib/remote.js'
import { HyperStore } from '../lib/store.js'
import { TradingGuard } from '../lib/trading-guard.js'

const dir = mkdtempSync(join(tmpdir(), 'dhl-wallet-'))
const MAIN = '0x1111111111111111111111111111111111111111'
const remote = Object.create(HyperRemote.prototype)
remote.cfg = { tradingMode: 'live', network: 'mainnet', signer: 'local', privateKey: '', web3Account: 'main', tradingAddress: '', dataDir: dir, allowedCoins: ['BTC'], maxOrderUsd: 100, maxDailyUsd: 500, maxPositionUsd: 500, maxLeverage: 2 }
remote.store = new HyperStore(dir)
remote.guard = new TradingGuard(dir, remote.cfg)
Object.assign(remote, { walletEpoch: 0, activeTradeOps: 0, tradeCapacityCache: new Map(), tradeCapacityPending: new Map(), accountModeCache: { address: 'old', mode: 'default', at: Date.now() }, lastLiveAccount: { at: Date.now() } })
let accounts = [{ id: 'acc-1', label: 'HL签名钱包', address: '0x2222222222222222222222222222222222222222' }]
remote.hostCtx = { get: (name) => name === 'wallet' ? { signTypedData() {}, listAccounts: () => accounts } : undefined }

assert.equal(await remote.resolveAddress(), null, 'not connected yet')
assert.deepEqual((await remote.walletAccounts()).accounts.map((row) => row.label), ['HL签名钱包'], 'the desk can list the vault accounts')
await assert.rejects(remote.updateWalletSettings({ signer: 'web3', web3Account: 'acc-1', tradingAddress: '0x12' }), /40 位十六进制/)
await assert.rejects(remote.updateWalletSettings({ signer: 'web3', web3Account: 'nope', tradingAddress: MAIN }), /找不到账户「nope」.*重启/)
await assert.rejects(remote.updateWalletSettings({ signer: 'web3', web3Account: 'acc-1', tradingAddress: '' }), /主账户地址/)
await assert.rejects(remote.updateWalletSettings({ signer: 'local' }), /私钥/, 'local signing needs a configured key')

const result = await remote.updateWalletSettings({ signer: 'web3', web3Account: 'acc-1', tradingAddress: MAIN })
assert.equal(result.address, MAIN, 'the new address is used immediately')
assert.equal(await remote.resolveAddress(), MAIN)
assert.equal(remote.accountModeCache, null); assert.equal(remote.lastLiveAccount, null, 'cached account reads are dropped')
assert.deepEqual({ ...remote.store.walletSettings(), at: undefined }, { signer: 'web3', web3Account: 'acc-1', tradingAddress: MAIN, at: undefined }, 'and saved for the next start')
assert.ok(remote.store.eventsSince(0).events.some((ev) => ev.kind === 'wallet.changed'), 'the desk is told to reload')

// what a restart applies: saved settings over config
assert.deepEqual(normalizeWalletSettings(remote.store.walletSettings(), { signer: 'local', web3Account: 'main', tradingAddress: '' }), { signer: 'web3', web3Account: 'acc-1', tradingAddress: MAIN })
assert.throws(() => normalizeWalletSettings({ signer: 'ledger' }), /local 或 web3/)
// codex release review P1: a decision made under one wallet can never be executed under another
remote.store.registerSession('s1', { coin: 'BTC' })
let release
remote.checkLiveOrder = () => new Promise((resolve) => { release = () => resolve({ mid: 100, notionalUsd: 50, network: 'mainnet', address: MAIN }) })
const pending = remote.prepareOrder({ coin: 'BTC', isBuy: true, sz: 0.5, thesis: '回踩支撑做多，跌破前低止损' }, 's1')
await new Promise((r) => setTimeout(r, 0))
await remote.updateWalletSettings({ signer: 'web3', web3Account: 'acc-1', tradingAddress: '0x3333333333333333333333333333333333333333' })
release()
await assert.rejects(pending, /钱包已切换/, 'a pre-check in flight during a switch is void')
remote.checkLiveOrder = async () => ({ mid: 100, notionalUsd: 50, network: 'mainnet', address: '0x3333333333333333333333333333333333333333' })
const decision = await remote.prepareOrder({ coin: 'BTC', isBuy: true, sz: 0.5, thesis: '回踩支撑做多，跌破前低止损' }, 's1')
await remote.updateWalletSettings({ signer: 'web3', web3Account: 'acc-1', tradingAddress: MAIN })
await assert.rejects(remote.executeToolOrder({ coin: 'BTC', isBuy: true, sz: 0.5, decisionId: decision.decisionId }, { agent: { id: 's1' } }, 's1'), /切换前的钱包|已失效/, 'and its decision cannot be executed by the next wallet')

console.log('钱包设置：交易台连接后立即生效、校验地址与账户、清空旧缓存并在重启后保留')
