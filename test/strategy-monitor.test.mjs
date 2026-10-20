import assert from 'node:assert/strict'
import { createStrategyBarMonitor } from '../lib/strategy-monitor.js'

const BAR = 15 * 60_000
let clock = BAR * 10 + 60_000
let last = { t: BAR * 9, o: 100, h: 102, l: 99, c: 101, v: 1000 }
const events = []
const remote = {
  cfg: { network: 'testnet', tradingMode: 'live', agentAutoTradeTestnet: true },
  isManaged: () => true,
  store: {
    journal: () => ({ strategies: [{ id: 's1', status: 'testing', markets: 'ETH', timeframe: '15m' }] }),
    listSessions: () => [{ sessionId: 'eth-session', coin: 'ETH' }],
  },
  candles: async () => ({ candles: [last] }),
}
const monitor = createStrategyBarMonitor(remote, { now: () => clock, notify: (event) => { events.push(event); return true } })
assert.deepEqual(await monitor.check(), [], 'first read establishes a baseline')
clock = BAR * 11 + 6_000
last = { t: BAR * 10, o: 101, h: 105, l: 100, c: 104, v: 2000 }
assert.equal((await monitor.check()).length, 1, 'newly closed 15m bar wakes the agent')
assert.equal(events[0].sessionId, 'eth-session')
assert.equal(events[0].strategyIds[0], 's1')
assert.deepEqual(await monitor.check(), [], 'same bar never wakes twice')
remote.cfg.network = 'mainnet'
clock = BAR * 12 + 6_000
last = { t: BAR * 11, o: 104, h: 106, l: 102, c: 103, v: 1300 }
assert.deepEqual(await monitor.check(), [], 'mainnet automatic decision turns stay disabled')
assert.equal(events.length, 1)
monitor.dispose()
console.log('strategy monitor: fresh closed bar, dedupe, session route and testnet gate passed')
