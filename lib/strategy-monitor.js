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
      if (at < nextPollAt) return []
      nextPollAt = Math.floor(at / BAR_MS) * BAR_MS + BAR_MS + 5_000
      busy = true
      const events = []
      try {
        const strategies = remote.store.journal().strategies.filter((row) => ['active', 'testing'].includes(row.status))
        const byCoin = new Map()
        for (const strategy of strategies) for (const coin of String(strategy.markets ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
          if (!byCoin.has(coin)) byCoin.set(coin, [])
          byCoin.get(coin).push(strategy.id)
        }
        const sessions = remote.store.listSessions()
        for (const [coin, strategyIds] of byCoin) {
          const session = sessions.find((row) => row.coin === coin)
          if (!session) continue
          const { candles } = await remote.candles({ coin, interval: '15m', limit: 4 })
          if (disposed || remote.cfg.network !== network || remote.cfg.tradingMode !== 'live') return []
          const { rows, closeTime } = closedCandles(candles, { now: at, interval: '15m' })
          const candle = rows.at(-1)
          if (!candle) continue
          const key = `${network}:${session.sessionId}:${coin}`
          const previous = seen.get(key)
          seen.set(key, candle.t)
          if (previous == null || candle.t <= previous || at - closeTime(candle) > FRESH_MS) continue
          const event = { id: `bar:${network}:${coin}:${candle.t}`, type: 'market-bar', at,
            sessionId: session.sessionId, coin, interval: '15m', candle, strategyIds }
          if (notify(event)) events.push(event)
        }
        return events
      } finally { busy = false }
    },
    dispose() { disposed = true; seen.clear() },
  }
}
