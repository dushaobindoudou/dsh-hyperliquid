import assert from 'node:assert/strict'
import { createStrategyBarMonitor, watchIntervalOf } from '../lib/strategy-monitor.js'
import { marketBarWakeText } from '../lib/wake.js'

assert.equal(watchIntervalOf([]), '15m', 'no strategy watches the default 15m bar')
assert.equal(watchIntervalOf([{ timeframe: '4h 结构 + 15m 入场' }]), '15m', 'the entry (shortest) timeframe wins')
assert.equal(watchIntervalOf([{ timeframe: '1H' }, { timeframe: '4h' }]), '1h')
assert.equal(watchIntervalOf([{ timeframe: '1m 剥头皮' }]), '15m', 'intervals below 5m are not watched')

const BAR = 15 * 60_000
const HOUR = 60 * 60_000
let clock = BAR * 10 + 60_000
let last = { t: BAR * 9, o: 100, h: 102, l: 99, c: 101, v: 1000 }
const events = []
const reads = []
const sessions = [{ sessionId: 'a', coin: 'BTC', watch: true }, { sessionId: 'b', coin: 'BTC' }, { sessionId: 'c', coin: 'BTC', watch: true },
  { sessionId: 'archived', coin: 'ETH', watch: true }]
const remote = {
  cfg: { network: 'testnet', tradingMode: 'live' },
  isSessionActive: (id) => id !== 'archived',
  store: {
    journal: (sessionId) => ({ strategies: sessionId === 'b' ? [{ id: 'b1', status: 'active', markets: 'BTC' }] : sessionId === 'a' ? [{ id: 'only-a', status: 'testing', markets: 'BTC' }] : [] }),
    listSessions: () => sessions,
  },
  candles: async ({ interval }) => { reads.push(interval); return { candles: [last] } },
}
const monitor = createStrategyBarMonitor(remote, { now: () => clock, notify: (event) => { events.push(event); return true } })
assert.deepEqual(await monitor.check(), [], 'start-up only records the baseline: a restart never replays a wake')
assert.deepEqual(reads, ['15m'], 'one market read serves every watched BTC session')
assert.deepEqual(await monitor.check(), [], 'nothing is read again before the next bar closes')
assert.equal(reads.length, 1)
clock = BAR * 11 + 6_000
last = { ...last, t: BAR * 10 }
assert.deepEqual((await monitor.check()).map((event) => event.sessionId), ['a', 'c'], 'only watched sessions wake; b has a strategy but no 盯盘')
assert.deepEqual(events.map((event) => event.strategyIds), [['only-a'], []])
assert.deepEqual(await monitor.check(), [], 'one wake per closed bar')

sessions[0].watch = false
clock = BAR * 12 + 6_000; last = { ...last, t: BAR * 11 }
assert.deepEqual((await monitor.check()).map((event) => event.sessionId), ['c'], 'turning 盯盘 off stops the wakes at once')

const journal = remote.store.journal
remote.store.journal = (sessionId) => sessionId === 'c' ? { strategies: [{ id: 'swing', status: 'active', timeframe: '1h' }] } : journal(sessionId)
clock = HOUR * 4 + 6_000; last = { ...last, t: HOUR * 3 }
assert.deepEqual(await monitor.check(), [], 'a new interval starts from a baseline')
clock = HOUR * 4 + BAR + 6_000
assert.deepEqual(await monitor.check(), [], 'a 1h watch ignores the 15m closes')
clock = HOUR * 5 + 6_000; last = { ...last, t: HOUR * 4 }
const hourly = await monitor.check()
assert.deepEqual(hourly.map((event) => [event.sessionId, event.interval]), [['c', '1h']], 'the watch follows the strategy timeframe')

remote.cfg.network = 'mainnet'
assert.deepEqual(await monitor.check(), [], 'a network switch starts a new baseline')
monitor.dispose()

assert.match(marketBarWakeText(hourly), /BTC 1h 已收盘/)
console.log('盯盘：只唤醒用户开启盯盘的会话、周期跟随策略、重启不补发、同币取数复用通过')
