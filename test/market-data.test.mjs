import assert from 'node:assert/strict'
import { HyperliquidClient, keys } from '../lib/hl.js'
import { HyperRemote } from '../lib/remote.js'
import { buildToolDefinitions } from '../lib/tools.js'

const remote = Object.create(HyperRemote.prototype)
remote.cfg = { tradingMode: 'paper', network: 'testnet' }
let metaCalls = 0
remote.client = {
  meta: async () => { metaCalls += 1; throw new Error('redundant meta call') },
  metaAndAssetCtxs: async () => [{ universe: [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }] }, [{ markPx: '100' }]],
  snapshot: () => ({ at: Date.now(), data: { mids: { BTC: '101' } } }),
  allMids: async () => { throw new Error('fresh WS cache should avoid REST') },
}
remote.marketsCache = null
remote.marketsAt = 0
remote.lastTouch = new Map()
remote.catalogDexIndex = new Map()
remote.client.subs = new Map()
remote.client.subscribe = (key) => remote.client.subs.set(key, { listeners: 1 })
const market = await remote.markets()
assert.equal(market.universe[0].ctx.markPx, '100')
assert.equal(metaCalls, 0)
const coreDetail = await remote.marketDetail({ coin: 'BTC' })
assert.equal(coreDetail.market.kind, 'perp')
assert.equal(coreDetail.market.ctx.markPx, '100')
assert.equal(remote.catalogCache == null, true, 'core detail does not load the broad catalog')
let catalogCalls = 0
let spotMark = '2'
remote.client.info = async (type) => {
  catalogCalls += 1
  if (type === 'spotMetaAndAssetCtxs') return [{ tokens: [{ index: 0, name: 'USDC' }, { index: 1, name: 'PURR' }], universe: [{ name: 'PURR/USDC', tokens: [1, 0] }, { name: '@1', tokens: [1, 0] }] }, [{ markPx: spotMark, dayNtlVlm: '30' }, { markPx: '3', dayNtlVlm: '10' }]]
  if (type === 'allPerpMetas') return [{ universe: [{ name: 'BTC' }] }, { universe: [{ name: 'test:ABC', maxLeverage: 3 }] }]
  if (type === 'perpCategories') return [['test:ABC', 'stocks']]
  if (type === 'outcomeMeta') return { outcomes: [{ outcome: 12, name: 'Will BTC rise?', sideSpecs: [{ name: 'Yes' }, { name: 'No' }] }] }
  if (type === 'metaAndAssetCtxs') return [{ universe: [{ name: 'test:ABC' }] }, [{ markPx: '25', oraclePx: '24' }]]
  throw new Error('unexpected info type')
}
remote.catalogCache = null
remote.catalogAt = 0
const catalog = await remote.marketCatalog(null)
assert.deepEqual(catalog.markets.map((row) => [row.name, row.kind, row.tradable]), [
  ['BTC', 'perp', true], ['test:ABC', 'hip3', false], ['PURR/USDC', 'spot', false], ['@1', 'spot', false], ['#120', 'outcome', false], ['#121', 'outcome', false],
])
assert.equal(catalog.markets[2].ctx.markPx, '2')
assert.equal(catalog.markets[3].ctx.markPx, '3', 'spot context is matched by universe order, not coin field')
assert.equal(catalog.markets[3].label, 'PURR/USDC')
assert.equal(catalog.markets[1].category, 'stocks')
const marketTool = buildToolDefinitions(remote).find((tool) => tool.name === 'hyper_market')
const tagged = await marketTool.execute({ action: 'catalog', category: 'tradfi' })
assert.deepEqual(tagged.markets.map((row) => row.name), ['test:ABC'], 'agent catalog uses official category labels')
await remote.marketCatalog(null)
assert.equal(catalogCalls, 4, 'catalog should reuse its one-minute cache')
remote.detailCache = new Map()
assert.equal((await remote.marketDetail({ coin: 'test:ABC' })).market.ctx.markPx, '25')
assert.equal((await remote.marketDetail({ coin: 'test:ABC' })).market.ctx.markPx, '25')
assert.equal(catalogCalls, 5, 'selected HIP-3 DEX detail should be cached')
const midsSnapshot = remote.client.snapshot
remote.client.snapshot = (key) => key === keys.allDexsAssetCtxs()
  ? { at: Date.now(), data: { ctxs: [['test', [{ markPx: '31', dayNtlVlm: '1000' }]]] } }
  : midsSnapshot(key)
const liveCatalog = await remote.marketCatalog(null)
assert.equal(liveCatalog.markets[1].ctx.markPx, '31', 'one all-DEX WS payload fills HIP-3 price by metadata index')
assert.equal((await remote.marketDetail({ coin: 'test:ABC' })).market.ctx.markPx, '31', 'fresh WS context avoids per-DEX REST')
assert.equal(catalogCalls, 5)
remote.client.snapshot = midsSnapshot
remote.client.l2Book = async () => ({ levels: [[{ px: '0.4' }], [{ px: '0.6' }]] })
assert.equal((await remote.marketDetail({ coin: '#120' })).market.ctx.markPx, '0.5')
assert.equal((await remote.marketDetail({ coin: 'PURR/USDC' })).market.ctx.markPx, '2')
spotMark = '4'
assert.equal((await remote.marketDetail({ coin: 'PURR/USDC' })).market.ctx.markPx, '2', 'spot detail reuses the 15-second cache')
remote.detailCache.get('__spot__').at -= 16_000
assert.equal((await remote.marketDetail({ coin: 'PURR/USDC' })).market.ctx.markPx, '4', 'selected spot context refreshes after cache expiry')
let outcomeRestCalls = 0
remote.client.l2Book = async () => { outcomeRestCalls += 1; throw new Error('fresh WS book should avoid REST') }
remote.client.snapshot = (key) => key === keys.l2Book('#120')
  ? { at: Date.now(), data: { levels: [[{ px: '0.2' }], [{ px: '0.4' }]] } }
  : midsSnapshot(key)
assert.equal((await remote.marketDetail({ coin: '#120' })).market.ctx.markPx, '0.3')
assert.equal(outcomeRestCalls, 0)
remote.client.snapshot = midsSnapshot
const candleClose = Date.now() + 180_000
remote.client.candleSnapshot = async (_coin, interval) => [{ t: candleClose - 180_000, T: candleClose - 1, o: '1', h: '2', l: '1', c: '2', v: '3', i: interval }]
const candleResponse = await remote.candles({ coin: 'BTC', interval: '3m' })
assert.equal(candleResponse.candles.length, 1)
assert.equal(candleResponse.candles[0].T, candleClose - 1, 'host preserves exchange candle close time')
const parsed = []
const wsRemote = Object.create(HyperRemote.prototype)
wsRemote.lastTouch = new Map()
wsRemote.client = { subs: new Map(), subscribe(_key, args) { parsed.push(args) } }
wsRemote.touch(keys.l2Book('test:ABC'))
wsRemote.touch(keys.candle('test:ABC', '1h'))
wsRemote.touch(keys.allDexsAssetCtxs())
assert.deepEqual(parsed, [{ type: 'l2Book', coin: 'test:ABC' }, { type: 'candle', coin: 'test:ABC', interval: '1h' }, { type: 'allDexsAssetCtxs' }])
wsRemote.touch(keys.allDexsClearinghouseState('0x' + '12'.repeat(20)))
assert.deepEqual(parsed.at(-1), { type: 'allDexsClearinghouseState', user: '0x' + '12'.repeat(20) })
wsRemote.touch(keys.l2Book('unit:ES', { nSigFigs: 5, mantissa: 2 }))
assert.deepEqual(parsed.at(-1), { type: 'l2Book', coin: 'unit:ES', nSigFigs: 5, mantissa: 2 })
const depthRemote = Object.create(HyperRemote.prototype)
depthRemote.desk = { interval: '15m' }
depthRemote.lastTouch = new Map()
const depthCalls = []
depthRemote.client = {
  subs: new Map(), subscribe(key) { this.subs.set(key, { listeners: 1 }) },
  snapshot(key) {
    if (key === keys.l2Book('BTC')) return { at: Date.now(), seq: 1, data: { levels: [[{ px: '83046.1', sz: '1' }], [{ px: '83046.2', sz: '1' }]] } }
    if (key === keys.allMids()) return { at: Date.now(), seq: 1, data: { mids: { BTC: '83046.15' } } }
    return null
  },
  l2Book: async (coin, grouping) => { depthCalls.push([coin, grouping]); return { levels: [[{ px: '83040.0', sz: '8' }], [{ px: '83050.0', sz: '7' }]] } },
  wsStatus: () => ({ state: 'open' }),
}
const depth = await depthRemote.snapshot({ coin: 'BTC', interval: '15m', bookGrouping: '4' })
assert.equal(depth.book.levels[0][0].px, '83046.1', 'risk snapshot keeps full precision')
assert.equal(depth.groupedBook.levels[0][0].sz, '8', 'display book comes from exchange aggregation')
assert.deepEqual(depthCalls, [['BTC', { nSigFigs: 4 }]])
assert.ok(depth.observedAt.groupedBook > 0)
await assert.rejects(depthRemote.snapshot({ coin: 'BTC', bookGrouping: '9' }), /不支持的盘口价格档位/)
console.log('HIP-3 冒号币种的盘口/K 线订阅与按 DEX 行情刷新通过')
console.log('市场目录聚合永续、HIP-3 与现货，且只读市场不会标成可交易')
remote.store = { paperAccount: () => ({ usd: 100, positions: { BTC: { size: 1, entryPx: 100 } }, fills: [] }) }
assert.equal((await remote.account()).positions[0].markPx, 101)
console.log('markets 与 paper 账户复用合并元数据和新鲜 WS 缓存')

const client = new HyperliquidClient({ network: 'testnet' })
const attempts = new Map()
client._openChannel = async (key) => {
  const next = (attempts.get(key) ?? 0) + 1
  attempts.set(key, next)
  if (next === 1) throw new Error('transient channel failure')
  return { unsubscribe() {} }
}

try {
  client.subscribe('allMids', { type: 'allMids' })
  client.subscribe('l2Book:BTC', { type: 'l2Book', coin: 'BTC' })
  await new Promise((resolve) => setTimeout(resolve, 3_150))
  assert.equal(attempts.get('allMids'), 2)
  assert.equal(attempts.get('l2Book:BTC'), 2)
  assert.equal(client.subs.get('allMids')?.channel != null, true)
  assert.equal(client.subs.get('l2Book:BTC')?.channel != null, true)
  console.log('多个 WS 频道可独立重试')
} finally {
  client.close()
}
