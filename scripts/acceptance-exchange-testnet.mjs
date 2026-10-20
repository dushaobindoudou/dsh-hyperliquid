/**
 * Signed testnet rejection acceptance for an unfunded, isolated dsh-web3 wallet.
 * This intentionally submits real /exchange requests only while the account
 * has zero equity, no positions, no open orders, and no fills. It refuses to
 * run if the account is ever funded.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { WalletVault } from 'dsh-web3-core'
import { WalletService } from '../node_modules/dsh-web3/lib/service.js'
import { createSecretStore } from '../node_modules/dsh-web3/lib/keychain.js'
import { HyperliquidClient, sigFigs } from '../lib/hl.js'
import { HyperRemote } from '../lib/remote.js'
import { TradingGuard } from '../lib/trading-guard.js'

const vaultPath = resolve(homedir(), '.dsh-hyperliquid-test-web3')
const vault = await WalletVault.open({ directory: vaultPath, autoLockMs: 900_000 })
const wallet = new WalletService(vault, {
  vaultPath, autoLockMs: 900_000, passphraseMode: 'auto', env: {},
  credentials: undefined, keychain: createSecretStore('auto', vaultPath),
  rpcOverrides: {}, tokens: {}, allowModelSecretReveal: false,
})
const account = wallet.listAccounts().find((a) => a.label === 'hyperliquid-testnet')
assert.ok(account?.address, 'missing dedicated testnet account')
const client = new HyperliquidClient({ network: 'testnet' })
const remote = Object.create(HyperRemote.prototype)
const guardDir = mkdtempSync(join(tmpdir(), 'dhl-live-guard-'))
remote.cfg = {
  network: 'testnet', tradingMode: 'live', signer: 'web3', web3Account: account.id,
  tradingAddress: account.address, allowedCoins: ['BTC'], maxOrderUsd: 100,
  maxDailyUsd: 500, maxPositionUsd: 500, maxLeverage: 2, dataDir: guardDir,
}
remote.client = client
remote.guard = new TradingGuard(guardDir, remote.cfg)
remote.marketsCache = null
remote.marketsAt = 0
remote.hostCtx = { get: (name) => name === 'wallet' ? wallet : name === 'approval' ? { request: async () => 'allowed-once' } : null }
const exec = { agent: { id: 'testnet-acceptance' }, callId: 'testnet-acceptance' }
const report = { network: 'testnet', address: account.address, observedAt: new Date().toISOString(), checks: [] }

const stateOf = async () => {
  const [state, orders, fills] = await Promise.all([
    client.clearinghouseState(account.address), client.openOrders(account.address), client.userFills(account.address),
  ])
  return { equity: Number(state?.marginSummary?.accountValue), positions: state?.assetPositions?.length, orders: orders?.length, fills: fills?.length }
}
const check = (name, ok, detail) => {
  report.checks.push({ name, ok, detail })
  if (!ok) throw new Error(`${name}: ${JSON.stringify(detail)}`)
}
const rejected = async (name, action) => {
  const result = await remote.submitAction(action, exec)
  const message = typeof result?.response === 'string' ? result.response : JSON.stringify(result?.response)
  const reportedAddress = /User or API Wallet (0x[0-9a-f]{40})/i.exec(message)?.[1]
  check(name, result?.status === 'err' && /does not exist|insufficient|not found/i.test(message)
    && (!reportedAddress || reportedAddress.toLowerCase() === account.address.toLowerCase()),
  { status: result?.status, response: message?.slice(0, 220) })
}

try {
  const before = await stateOf()
  check('unfunded and empty before signed requests', before.equity === 0 && before.positions === 0 && before.orders === 0 && before.fills === 0, before)
  const markets = await client.meta()
  const btc = markets.universe.findIndex((market) => market.name === 'BTC')
  assert.ok(btc >= 0)
  const mids = await client.allMids()
  const mid = Number(mids?.mids?.BTC ?? mids?.BTC)
  assert.ok(mid > 0)
  await assert.rejects(remote.checkLiveOrder({ coin: 'BTC', isBuy: true, sz: 0.001, type: 'market', reduceOnly: false }), /账户权益|敞口/)
  check('live order guard rejects zero-equity account', true, { mid })
  await wallet.unlock()
  await rejected('signed leverage request', { type: 'updateLeverage', asset: btc, isCross: true, leverage: 1 })
  await rejected('signed IOC order request', {
    type: 'order', grouping: 'na',
    orders: [{ s: '0.001', t: { limit: { tif: 'Ioc' } }, a: btc, b: true, p: sigFigs(mid * 1.01, 5, 6), r: false }],
  })
  const parentPx = sigFigs(mid * 0.8, 5, 1)
  const tpPx = sigFigs(mid * 1.2, 5, 1)
  const slPx = sigFigs(mid * 0.6, 5, 1)
  await rejected('signed normalTpsl grouped request', {
    type: 'order', grouping: 'normalTpsl', orders: [
      { a: btc, b: true, p: parentPx, s: '0.001', r: false, t: { limit: { tif: 'Gtc' } } },
      { a: btc, b: false, p: tpPx, s: '0.001', r: true, t: { trigger: { isMarket: true, triggerPx: tpPx, tpsl: 'tp' } } },
      { a: btc, b: false, p: slPx, s: '0.001', r: true, t: { trigger: { isMarket: true, triggerPx: slPx, tpsl: 'sl' } } },
    ],
  })
  await rejected('signed cancel request', { type: 'cancel', cancels: [{ a: btc, o: 1 }] })
  const after = await stateOf()
  check('account unchanged after rejected requests', after.equity === 0 && after.positions === 0 && after.orders === 0 && after.fills === 0, after)
} finally {
  wallet.lock()
  client.close()
  rmSync(guardDir, { recursive: true, force: true })
}

console.log(JSON.stringify(report, null, 2))
