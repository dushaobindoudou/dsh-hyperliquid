import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHyperSkill } from '../lib/skill.js'
import { buildToolDefinitions } from '../lib/tools.js'

let registered
let removed = false
const remove = registerHyperSkill({ register(value) { registered = value; return () => { removed = true } } })
assert.equal(registered.name, 'hyperliquid-trading')
assert.equal(registered.source, 'bundled')
assert.match(registered.description, /Hyperliquid/)
assert.match(registered.content, /hyper_context/)
assert.match(registered.content, /hyper_decide/)
assert.match(registered.content, /orderStatus/)
assert.match(registered.content, /hyper_chart/)
assert.match(registered.content, /indicators/)
assert.equal(registered.content.startsWith('---'), false)
assert.match(readFileSync(registered.path, 'utf8'), /^---\nname: hyperliquid-trading\n/)
remove()
assert.equal(removed, true)
assert.equal(registerHyperSkill(null), null)
const staleAt = Date.now() - 20_000
const remote = {
  desk: { coin: 'ETH', interval: '15m' },
  store: { getSession: () => ({ coin: 'BTC' }) },
  markets: async () => ({ network: 'testnet', universe: [{ name: 'BTC', ctx: { markPx: '100', prevDayPx: '90', funding: '0.0001', dayNtlVlm: '1000' } }] }),
  snapshot: async () => ({ book: { levels: [[{ px: '99', sz: '2' }], [{ px: '101', sz: '3' }]] }, trades: [{ px: '100', sz: '1' }], observedAt: { book: staleAt, mids: staleAt }, ws: { state: 'open' } }),
  account: async () => ({ mode: 'paper', usd: 500, equity: 500, positions: [], openOrders: [] }),
  candles: async () => ({ candles: [{ t: Date.now(), c: 100 }] }),
  status: async () => ({ riskLimits: { allowedCoins: ['BTC'], maxOrderUsd: 100, maxDailyUsd: 500, maxLeverage: 2 }, autonomousLive: false, walletConfigured: false }),
}
const contextTool = buildToolDefinitions(remote).find((tool) => tool.name === 'hyper_context')
const result = await contextTool.execute({}, { agent: { id: 'session-1' } })
assert.equal(result.context.coin, 'BTC')
assert.equal(result.context.bookDepth.bids[0].px, '99')
assert.equal(result.context.recentTrades[0].px, '100')
assert.equal(result.context.riskLimits.maxOrderUsd, 100)
assert.match(result.text, /数据过期\/缺失，停止交易/)
const readonlyRemote = {
  ...remote,
  markets: async () => ({ network: 'testnet', universe: [] }),
  marketDetail: async () => ({ market: { name: 'unit:ES', kind: 'hip3', ctx: { markPx: '6200', prevDayPx: '6100', dayNtlVlm: '10' } }, observedAt: Date.now() }),
  marketCatalog: async () => ({ markets: [{ name: 'unit:ES', label: 'unit:ES', kind: 'hip3', tradable: false, ctx: { markPx: '6200' }, venue: 'unit' }], observedAt: Date.now() }),
}
const readonlyContext = await buildToolDefinitions(readonlyRemote).find((tool) => tool.name === 'hyper_context').execute({ coin: 'unit:ES' }, { agent: { id: 'session-1' } })
assert.equal(readonlyContext.context.marketKind, 'hip3')
assert.equal(readonlyContext.context.tradable, false)
assert.match(readonlyContext.text, /不代表该只读市场的余额/)
const catalog = await buildToolDefinitions(readonlyRemote).find((tool) => tool.name === 'hyper_market').execute({ action: 'catalog', kind: 'hip3', query: 'ES' })
assert.equal(catalog.markets[0].name, 'unit:ES')
const old = Date.now() - 79 * 3_600_000 - 30 * 60_000
const candleSeries = Array.from({ length: 80 }, (_, index) => ({
  t: old + index * 3_600_000, T: old + (index + 1) * 3_600_000 - 1,
  o: 100 + index, h: 102 + index, l: 99 + index, c: 101 + index, v: 100,
}))
const indicatorRemote = { ...remote, candles: async () => ({ candles: candleSeries }) }
const indicatorResult = await buildToolDefinitions(indicatorRemote).find((tool) => tool.name === 'hyper_market').execute({ action: 'indicators', coin: 'BTC', interval: '1h' })
assert.equal(indicatorResult.indicators.ready, true)
assert.equal(indicatorResult.indicators.excludedOpen, 1)
assert.match(indicatorResult.text, /已收盘 K 线/)
console.log('DSH Hyperliquid skill 注册与包内正文通过')
