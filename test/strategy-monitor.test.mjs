import assert from 'node:assert/strict'
import { createStrategyBarMonitor } from '../lib/strategy-monitor.js'

const BAR = 15 * 60_000
let clock = BAR * 10 + 60_000
let last = { t: BAR * 9, o: 100, h: 102, l: 99, c: 101, v: 1000 }
const events = []
let reads = 0
const sessions = [{ sessionId: 'a', coin: 'BTC' }, { sessionId: 'b', coin: 'BTC' }, { sessionId: 'archived', coin: 'ETH', tradingEnabled: false }]
const remote = {
  cfg: { network: 'testnet', tradingMode: 'live', agentAutoTradeTestnet: true }, isManaged: () => true,
  store: { journal: (sessionId) => ({ strategies: sessionId === 'a' ? [{ id: 'only-a', status: 'testing', markets: 'BTC' }] : [] }), listSessions: () => sessions },
  candles: async () => { reads++; return { candles: [last] } },
}
const monitor = createStrategyBarMonitor(remote, { now: () => clock, notify: (event) => { events.push(event); return true } })
assert.equal((await monitor.check()).length, 2, 'first check wakes each enabled session, even without a strategy')
assert.equal(reads, 1, 'one market read serves both BTC sessions')
assert.deepEqual(events.map((event) => event.strategyIds), [['only-a'], []])
assert.equal(new Set(events.map((event) => event.id)).size, 2, 'wake dedupe includes session')
assert.deepEqual(await monitor.check(), [])
clock = BAR * 11 + 6_000
last = { ...last, t: BAR * 10 }
assert.equal((await monitor.check()).length, 2, 'both same-coin strategies get every closed bar')
remote.cfg.network = 'mainnet'
assert.equal((await monitor.check()).length, 2, 'mainnet gets its own initial check')
clock = BAR * 12 + 6_000; last = { ...last, t: BAR * 11 }
assert.equal((await monitor.check()).length, 2, 'mainnet continues after the first check')
sessions.push({ sessionId: 'new', coin: 'BTC' })
assert.equal((await monitor.check()).length, 1, 'new sessions enter monitoring before the next bar')
monitor.dispose()
console.log('盯盘：逐会话路由、同币取数复用、首次入场检查、暂停排除与主网连续唤醒通过')
