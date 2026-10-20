/** Real Hyperliquid market data + isolated paper execution acceptance.
 * This script never calls /exchange and never reads a wallet secret.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HyperRemote } from '../lib/remote.js'
import { HyperliquidClient } from '../lib/hl.js'
import { HyperStore } from '../lib/store.js'
import { TradingGuard } from '../lib/trading-guard.js'
import { buildToolDefinitions } from '../lib/tools.js'
import { computeIndicators } from '../lib/indicators.js'

const network = process.argv.includes('--mainnet-data') ? 'mainnet' : 'testnet'
const dir = mkdtempSync(join(tmpdir(), 'dhl-online-'))
const remote = Object.create(HyperRemote.prototype)
remote.cfg = { tradingMode: 'paper', network, signer: 'local', privateKey: '', dataDir: dir,
  allowedCoins: ['BTC'], maxOrderUsd: 300, maxDailyUsd: 1000, maxPositionUsd: 300, maxLeverage: 2 }
remote.client = new HyperliquidClient({ network })
remote.store = new HyperStore(dir, network)
remote.paperGuard = new TradingGuard(dir, remote.cfg, { budgetName: network === 'mainnet' ? 'paper-budget-mainnet.json' : 'paper-budget.json' })
remote.desk = { coin: 'BTC', interval: '15m' }
remote.lastTouch = new Map()
remote.marketsCache = null
remote.marketsAt = 0

const report = { network, observedAt: new Date().toISOString(), checks: [] }
const withTimeout = (promise, ms) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${ms / 1000}s timeout`)), ms)
  promise.then((value) => { clearTimeout(timer); resolve(value) }, (error) => { clearTimeout(timer); reject(error) })
})
const step = async (name, fn) => {
  const start = Date.now()
  try {
    const detail = await withTimeout(fn(), 20_000)
    report.checks.push({ name, ok: true, ms: Date.now() - start, detail })
  } catch (err) {
    report.checks.push({ name, ok: false, ms: Date.now() - start, error: String(err?.message ?? err) })
  }
}

try {
  await step('real market and order book', async () => {
    const [markets, snap] = await Promise.all([remote.markets(), remote.snapshot({ coin: 'BTC' })])
    const btc = markets.universe.find((m) => m.name === 'BTC')
    const bid = Number(snap.book?.levels?.[0]?.[0]?.px)
    const ask = Number(snap.book?.levels?.[1]?.[0]?.px)
    assert.ok(btc && bid > 0 && ask > bid)
    return { markets: markets.universe.length, bid, ask, spreadBps: (ask / bid - 1) * 10000, szDecimals: btc.szDecimals }
  })
  await step('exchange-aggregated order book', async () => {
    const snap = await remote.snapshot({ coin: 'BTC', interval: '15m', bookGrouping: '4' })
    const rawBid = Number(snap.book?.levels?.[0]?.[0]?.px)
    const groupedBid = Number(snap.groupedBook?.levels?.[0]?.[0]?.px)
    const rawAsk = Number(snap.book?.levels?.[1]?.[0]?.px)
    const groupedAsk = Number(snap.groupedBook?.levels?.[1]?.[0]?.px)
    assert.ok(rawBid > 0 && groupedBid > 0 && groupedBid <= rawBid)
    assert.ok(rawAsk > 0 && groupedAsk >= rawAsk)
    assert.ok(snap.observedAt.groupedBook > 0)
    return { rawBid, groupedBid, rawAsk, groupedAsk, rawLevels: snap.book.levels[0].length,
      groupedLevels: snap.groupedBook.levels[0].length }
  })
  await step('real candles and trades', async () => {
    const [candles, trades] = await Promise.all([
      remote.candles({ coin: 'BTC', interval: '15m' }), remote.client.recentTrades('BTC'),
    ])
    assert.ok(candles.candles.length >= 2 && trades.length > 0)
    assert.ok(candles.candles.every((c, i, a) => i === 0 || c.t > a[i - 1].t))
    assert.ok(candles.candles.every((c) => c.T >= c.t), 'exchange close time T must be preserved')
    const indicators = computeIndicators(candles.candles, { interval: '15m' })
    assert.equal(indicators.ready, true)
    assert.ok(indicators.observedAt <= Date.now() && indicators.candlesUsed >= 50)
    return { candles: candles.candles.length, trades: trades.length, lastClose: candles.candles.at(-1).c,
      indicatorClosedAt: indicators.observedAt, excludedOpen: indicators.excludedOpen }
  })
  remote.store.registerSession('acceptance-session', { coin: 'BTC' })
  await step('session trading context', async () => {
    const tool = buildToolDefinitions(remote).find((d) => d.name === 'hyper_context')
    const result = await tool.execute({}, { agent: { id: 'acceptance-session' } })
    assert.equal(result.context.coin, 'BTC')
    assert.ok(result.context.mark > 0 && result.context.candles.length >= 2)
    return { coin: result.context.coin, mark: result.context.mark, accountValue: result.context.accountValue, candles: result.context.candles.length }
  })
  await step('paper limit, fill, leverage and reduce-only close', async () => {
    await remote.setLeverage({ coin: 'BTC', leverage: 2 })
    const mid = await remote.midOf('BTC')
    await assert.rejects(remote.placeOrder({ coin: 'BTC', isBuy: true, sz: 0.001, type: 'limit', px: mid * 0.9 }), /可立即成交/)
    const entry = await remote.placeOrder({ coin: 'BTC', isBuy: true, sz: 0.001, type: 'limit', px: mid * 1.1 })
    assert.equal(entry.mode, 'paper')
    const afterEntry = await remote.account()
    assert.equal(afterEntry.positions.find((p) => p.coin === 'BTC')?.leverage, 2)
    assert.ok(afterEntry.positions.find((p) => p.coin === 'BTC')?.size > 0)
    await assert.rejects(remote.placeOrder({ coin: 'BTC', isBuy: false, sz: 0.002, reduceOnly: true }), /只减仓/)
    const close = await remote.placeOrder({ coin: 'BTC', isBuy: false, sz: 0.001, reduceOnly: true })
    const finalAccount = await remote.account()
    assert.equal(finalAccount.positions.length, 0)
    assert.equal((await remote.fills()).fills.length, 2)
    return { entryPx: entry.fill.px, exitPx: close.fill.px, realizedPnl: close.fill.realized, finalEquity: finalAccount.equity }
  })
  await step('paper cancel refusal', async () => {
    await assert.rejects(remote.cancelOrder({ coin: 'BTC', oid: 1 }), /没有挂单/)
    return 'paper has no resting orders; live cancel requires funded wallet'
  })
  await step('live execution fails closed without wallet', async () => {
    remote.cfg = { ...remote.cfg, tradingMode: 'live' }
    await assert.rejects(remote.prepareOrder({ coin: 'BTC', isBuy: true, sz: 0.001, thesis: '真实行情验收：没有签名钱包时拒绝交易。' }, 'acceptance-session'), /钱包|地址/)
    return 'no /exchange request sent'
  })
} finally {
  remote.client.close()
  rmSync(dir, { recursive: true, force: true })
}

console.log(JSON.stringify(report, null, 2))
if (report.checks.some((c) => !c.ok)) process.exitCode = 1
