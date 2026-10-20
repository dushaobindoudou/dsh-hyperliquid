import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HyperRemote } from '../lib/remote.js'
import { HyperStore } from '../lib/store.js'
import { buildToolDefinitions } from '../lib/tools.js'

const calls = []
const remote = Object.create(HyperRemote.prototype)
remote.client = {
  async candleSnapshot(coin, interval) {
    calls.push([coin, interval])
    if (coin !== 'xyz:XYZ100') throw new Error('HttpRequestError: 500 Internal Server Error - null')
    const span = interval === '15m' ? 900_000 : 3_600_000
    const lastClosed = Math.floor(Date.now() / span) * span - span
    return Array.from({ length: 80 }, (_, index) => {
      const t = lastClosed - (79 - index) * span
      return { t, T: t + span - 1, o: '100', h: '102', l: '99', c: String(100 + index), v: '10' }
    })
  },
}
const market = buildToolDefinitions(remote).find((tool) => tool.name === 'hyper_market')
for (const interval of ['15m', '1h']) {
  const bars = await market.execute({ action: 'candles', coin: 'xyz:100', interval })
  assert.equal(bars.candles.length, 48)
  assert.equal(bars.coin, 'xyz:XYZ100')
  const result = await market.execute({ action: 'indicators', coin: 'xyz:100', interval })
  assert.equal(result.indicators.ready, true)
  assert.equal(result.coin, 'xyz:XYZ100')
}
assert.ok(calls.every(([coin]) => coin === 'xyz:XYZ100'), 'the exchange only receives the canonical market name')
remote.marketCatalog = async () => ({ markets: [{ name: 'xyz:XYZ100' }] })
const unavailable = new Error('500 Internal Server Error')
unavailable.response = { status: 500 }
remote.client.candleSnapshot = async () => { throw unavailable }
await assert.rejects(market.execute({ action: 'candles', coin: 'xyz:FAKE', interval: '1h' }), /未知市场 xyz:FAKE.*action=catalog/)
await assert.rejects(market.execute({ action: 'candles', coin: 'xyz:XYZ100', interval: '1h' }), (error) => error === unavailable,
  'an upstream error for a listed market must not be mislabeled as an invalid symbol')

const dataDir = mkdtempSync(join(tmpdir(), 'dhl-xyz100-'))
try {
  writeFileSync(join(dataDir, 'sessions.json'), JSON.stringify({ sessions: { old: { sessionId: 'old', coin: 'xyz:100', createdAt: 1, updatedAt: 1 } } }))
  const store = new HyperStore(dataDir)
  assert.equal(store.getSession('old').coin, 'xyz:XYZ100')
  assert.equal(JSON.parse(readFileSync(join(dataDir, 'sessions.json'), 'utf8')).sessions.old.coin, 'xyz:XYZ100')
  assert.equal(store.registerSession('new', { coin: 'xyz:100' }).coin, 'xyz:XYZ100')
  assert.equal(store.bindCoin('new', 'xyz:100').coin, 'xyz:XYZ100')
} finally {
  rmSync(dataDir, { recursive: true, force: true })
}
console.log('XYZ100 旧会话简称的 K 线与指标调用通过')
