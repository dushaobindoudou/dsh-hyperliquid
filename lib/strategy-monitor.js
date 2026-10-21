/**
 * Wake a trading session when the user has turned on 盯盘 (watch) for it and
 * its watch interval completes a fresh bar. A session the user does not watch
 * is never woken. The interval follows the shortest timeframe named by the
 * session's active strategies on its coin (5m to 4h, default 15m), and the
 * first bar seen after start-up, a watch toggle or an interval change only
 * sets the baseline, so a restart never replays a wake.
 */
import { closedCandles } from './indicators.js'

const INTERVAL_MS = { '5m': 5 * 60_000, '15m': 15 * 60_000, '30m': 30 * 60_000, '1h': 60 * 60_000, '2h': 2 * 60 * 60_000, '4h': 4 * 60 * 60_000 }
export const WATCH_INTERVALS = Object.keys(INTERVAL_MS)
const DEFAULT_INTERVAL = '15m'
const FRESH_MS = 2 * 60_000

const activeStrategies = (journal, coin) => journal.strategies.filter((row) => ['active', 'testing'].includes(row.status) &&
  (!row.markets || String(row.markets).split(',').map((s) => s.trim()).some((name) => name === coin || name === '*')))

/** The shortest watchable timeframe named by the strategies (the entry timeframe), else 15m. */
export function watchIntervalOf(strategies) {
  const named = strategies.flatMap((row) => String(row.timeframe ?? '').toLowerCase().match(/\d+\s*[mh]\b/g) ?? [])
    .map((token) => token.replace(/\s+/g, '')).filter((token) => INTERVAL_MS[token])
  return named.sort((a, b) => INTERVAL_MS[a] - INTERVAL_MS[b])[0] ?? DEFAULT_INTERVAL
}

/** The session's watch state as the desk shows it. */
export function sessionWatch(store, row) {
  return { watch: row.watch === true, watchInterval: watchIntervalOf(activeStrategies(store.journal(row.sessionId), row.coin)) }
}

export function createStrategyBarMonitor(remote, { notify, now = Date.now } = {}) {
  const seen = new Map()
  const nextDue = new Map()
  let busy = false
  let disposed = false
  let network = remote.cfg.network

  return {
    async check() {
      if (disposed || busy) return []
      const at = now()
      if (remote.cfg.network !== network) { seen.clear(); nextDue.clear(); network = remote.cfg.network }
      const sessions = remote.store.listSessions().filter((row) => row.watch === true && (remote.isSessionActive?.(row.sessionId) ?? true))
      busy = true
      const events = []
      try {
        const reads = new Map()
        for (const session of sessions) {
          const coin = session.coin
          const strategies = activeStrategies(remote.store.journal(session.sessionId), coin)
          const interval = watchIntervalOf(strategies)
          const key = `${network}:${session.sessionId}:${coin}:${interval}`
          if (at < (nextDue.get(key) ?? 0)) continue
          const readKey = `${coin}:${interval}`
          if (!reads.has(readKey)) reads.set(readKey, remote.candles({ coin, interval, limit: 4 }))
          const { candles } = await reads.get(readKey)
          if (remote.isSessionActive && !remote.isSessionActive(session.sessionId)) continue
          if (disposed || remote.cfg.network !== network) return []
          const { rows, closeTime } = closedCandles(candles, { now: at, interval })
          const candle = rows.at(-1)
          if (!candle) continue
          const previous = seen.get(key)
          seen.set(key, candle.t)
          nextDue.set(key, closeTime(candle) + INTERVAL_MS[interval] + 5_000)
          if (previous == null || candle.t <= previous || at - closeTime(candle) > FRESH_MS) continue
          const event = { id: `bar:${network}:${session.sessionId}:${coin}:${interval}:${candle.t}`, type: 'market-bar', at,
            sessionId: session.sessionId, coin, interval, candle, strategyIds: strategies.map((row) => row.id) }
          if (notify(event)) events.push(event)
        }
        return events
      } finally { busy = false }
    },
    dispose() { disposed = true; seen.clear(); nextDue.clear() },
  }
}
