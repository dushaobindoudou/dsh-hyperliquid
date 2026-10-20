/** Funded Hyperliquid testnet acceptance through the real HyperRemote order path.
 * Every host approval and dsh-web3 signature waits for an explicit human reply.
 * Do not rerun after an unknown exchange result without reconciling order status.
 */
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { WalletVault } from 'dsh-web3-core'
import { WalletService } from '../node_modules/dsh-web3/lib/service.js'
import { createSecretStore } from '../node_modules/dsh-web3/lib/keychain.js'
import { HyperliquidClient, sigFigs } from '../lib/hl.js'
import { HyperRemote } from '../lib/remote.js'
import { HyperStore } from '../lib/store.js'
import { TradingGuard } from '../lib/trading-guard.js'

const address = '0xF5D7710aC1bBDc51fB32Dfa67fC5D0f22CD9636C'
const sessionId = 'funded-testnet-acceptance'
const vaultPath = resolve(homedir(), '.dsh-hyperliquid-test-web3')
const dataDir = resolve(homedir(), '.dsh-hyperliquid-funded-acceptance')
const vault = await WalletVault.open({ directory: vaultPath, autoLockMs: 900_000 })
const wallet = new WalletService(vault, {
  vaultPath, autoLockMs: 900_000, passphraseMode: 'auto', env: {},
  credentials: undefined, keychain: createSecretStore('auto', vaultPath),
  rpcOverrides: {}, tokens: {}, allowModelSecretReveal: false,
})
const account = wallet.listAccounts().find((a) => a.label === 'hyperliquid-testnet')
assert.equal(account?.address?.toLowerCase(), address.toLowerCase(), 'test wallet address changed')
const rl = createInterface({ input: process.stdin, output: process.stdout })
const approval = {
  request: async ({ reason }) => {
    console.log(`\nAPPROVAL REQUIRED\n${reason}\n`)
    const answer = await rl.question('Type APPROVE for this one request, anything else to reject: ')
    return answer.trim() === 'APPROVE' ? 'allowed-once' : 'denied'
  },
}
const remote = Object.create(HyperRemote.prototype)
remote.cfg = {
  network: 'testnet', tradingMode: 'live', signer: 'web3',
  web3Account: account.id, tradingAddress: address, autonomousLive: false,
  allowedCoins: ['BTC'], maxOrderUsd: 100, maxDailyUsd: 500,
  maxPositionUsd: 100, maxLeverage: 1, dataDir,
}
remote.client = new HyperliquidClient({ network: 'testnet' })
remote.store = new HyperStore(dataDir)
remote.store.registerSession(sessionId, { coin: 'BTC', title: 'Funded testnet acceptance' })
remote.guard = new TradingGuard(dataDir, remote.cfg)
remote.hostCtx = { get: (name) => name === 'wallet' ? wallet : name === 'approval' ? approval : null }
remote.marketsCache = null
remote.marketsAt = 0
remote.lastTouch = new Map()
remote.desk = { coin: 'BTC', interval: '15m' }
let callCount = 0
const exec = () => ({ agent: { id: sessionId }, callId: `funded-testnet-${++callCount}` })
const report = { network: 'testnet', address, startedAt: new Date().toISOString(), checks: [] }
const record = (name, detail) => {
  report.checks.push({ name, detail })
  console.log(JSON.stringify({ name, detail }))
}
const state = async () => {
  const [perp, orders, fills] = await Promise.all([
    remote.client.clearinghouseState(address), remote.client.openOrders(address), remote.client.userFills(address),
  ])
  return {
    equity: Number(perp?.marginSummary?.accountValue ?? 0),
    withdrawable: Number(perp?.withdrawable ?? 0),
    btcSize: Number(perp?.assetPositions?.find((p) => p?.position?.coin === 'BTC')?.position?.szi ?? 0),
    orders, fills,
  }
}
const waitFor = async (predicate, label) => {
  for (let i = 0; i < 12; i += 1) {
    const current = await state()
    if (predicate(current)) return current
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`${label}: exchange response not reflected in account state`)
}
const planAndPlace = async (order) => {
  const thesis = '仅验证测试网真实下单、成交或撤单；使用固定小额并在验收结束时清理仓位。'
  const plan = await remote.prepareOrder({ ...order, thesis }, sessionId)
  return remote.executeToolOrder({ ...order, decisionId: plan.decisionId }, exec(), sessionId)
}

try {
  const before = await state()
  assert.ok(before.equity >= 100, 'Perps equity below 100 mock USDC')
  assert.equal(before.btcSize, 0, 'existing BTC position: stop for review')
  assert.equal(before.orders.length, 0, 'existing open orders: stop for review')
  assert.equal(before.fills.length, 0, 'account has prior fills: stop to prevent rerun')
  record('funded initial state', { equity: before.equity, orders: 0, positions: 0, fills: 0 })

  await wallet.unlock()
  const leverage = await remote.executeToolLeverage({ coin: 'BTC', leverage: 1, marginMode: 'cross' }, exec())
  record('set BTC leverage 1x', leverage.response)

  const mid = await remote.midOf('BTC')
  const restingPx = Number(sigFigs(mid * 0.8, 5, 1))
  const resting = await planAndPlace({ coin: 'BTC', isBuy: true, sz: 0.001, type: 'limit', px: restingPx, tif: 'Gtc', reduceOnly: false })
  const restingState = await waitFor((s) => s.orders.some((o) => o.coin === 'BTC'), 'resting order')
  const order = restingState.orders.find((o) => o.coin === 'BTC')
  assert.ok(Number.isInteger(Number(order?.oid)))
  record('GTC order rests', { cloid: resting.cloid, oid: order.oid, px: order.limitPx ?? restingPx })

  await remote.executeToolCancel({ coin: 'BTC', oid: Number(order.oid) }, exec())
  await waitFor((s) => s.orders.every((o) => Number(o.oid) !== Number(order.oid)), 'cancel')
  record('GTC order canceled', { oid: order.oid })

  const entry = await planAndPlace({ coin: 'BTC', isBuy: true, sz: 0.001, type: 'market', reduceOnly: false })
  const openState = await waitFor((s) => s.btcSize > 0, 'IOC fill')
  assert.ok(openState.btcSize <= 0.001 + 1e-9, 'unexpected BTC size')
  record('IOC buy fills', { cloid: entry.cloid, btcSize: openState.btcSize, fills: openState.fills.length })

  const close = await planAndPlace({ coin: 'BTC', isBuy: false, sz: openState.btcSize, type: 'market', reduceOnly: true })
  const final = await waitFor((s) => s.btcSize === 0 && s.orders.length === 0 && s.fills.length >= 2, 'reduce-only close')
  record('reduce-only close fills', { cloid: close.cloid, equity: final.equity, fills: final.fills.length })
  report.ok = true
} catch (error) {
  report.ok = false
  report.error = String(error?.stack ?? error)
  try {
    const current = await state()
    report.remaining = { equity: current.equity, btcSize: current.btcSize, openOrders: current.orders.map((o) => ({ coin: o.coin, oid: o.oid })), fills: current.fills.length }
  } catch (stateError) {
    report.remainingError = String(stateError?.message ?? stateError)
  }
  process.exitCode = 1
} finally {
  console.log(JSON.stringify(report, null, 2))
  rl.close()
  wallet.lock()
  remote.client.close()
}
