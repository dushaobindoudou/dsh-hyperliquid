/** Wake one trading session when a strategy market completes a fresh 15m bar. */
import { closedCandles } from './indicators.js'

const BAR_MS = 15 * 60_000
const FRESH_MS = 2 * 60_000

export function createStrategyBarMonitor(remote, { notify, now = Date.now } = {}) {
  const seen = new Map()
  let nextPollAt = 0
  let busy = false
  let disposed = false
  let network = remote.cfg.network

  return {
    async check() {
      if (disposed || busy) return []
      const at = now()
      if (remote.cfg.network !== network) { seen.clear(); network = remote.cfg.network; nextPollAt = 0 }
      if (!remote.cfg.agentAutoTradeTestnet || remote.cfg.tradingMode !== 'live' || !remote.isManaged()) return []
      const sessions = remote.store.listSessions().filter((row) => row.tradingEnabled !== false)
      if (at < nextPollAt && sessions.every((row) => seen.has(`${network}:${row.sessionId}:${row.coin}`))) return []
      nextPollAt = Math.floor(at / BAR_MS) * BAR_MS + BAR_MS + 5_000
      busy = true
      const events = []
      try {
        const byCoin = new Map()
        for (const session of sessions) {
          const coin = session.coin
          const strategies = remote.store.journal(session.sessionId).strategies.filter((row) => ['active', 'testing'].includes(row.status))
          const strategyIds = strategies.filter((row) => !row.markets || String(row.markets).split(',').map((s) => s.trim()).some((name) => name === coin || name === '*')).map((row) => row.id)
          if (!byCoin.has(coin)) byCoin.set(coin, remote.candles({ coin, interval: '15m', limit: 4 }))
          const { candles } = await byCoin.get(coin)
          if (disposed || remote.cfg.network !== network || remote.cfg.tradingMode !== 'live') return []
          const { rows, closeTime } = closedCandles(candles, { now: at, interval: '15m' })
          const candle = rows.at(-1)
          if (!candle) continue
          const key = `${network}:${session.sessionId}:${coin}`
          const previous = seen.get(key)
          seen.set(key, candle.t)
          if (previous == null ? session.requirePosition === false : candle.t <= previous || at - closeTime(candle) > FRESH_MS) continue
          const event = { id: `bar:${network}:${session.sessionId}:${coin}:${candle.t}`, type: 'market-bar', at,
            sessionId: session.sessionId, coin, interval: '15m', candle, strategyIds, requirePosition: true }
          if (notify(event)) events.push(event)
        }
        return events
      } finally { busy = false }
    },
    dispose() { disposed = true; seen.clear() },
  }
}
