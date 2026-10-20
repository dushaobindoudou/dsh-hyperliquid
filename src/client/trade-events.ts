import type { Candle } from './types'

export interface TradeEvent {
  kind: 'order' | 'fill'
  coin: string
  time: number
  candleTime: number
  isBuy: boolean
  px: number
  sz: number
  status: string
  reason: string
  /** Trading session whose decision produced it, when the desk recorded one. */
  sessionId: string | null
  id: string
}

/** Assign exchange timestamps to the candle that was open when the event occurred. */
export function chartTradeEvents(candles: Candle[], coin: string, orders: any[], fills: any[]): TradeEvent[] {
  if (!candles.length) return []
  const times = candles.map((candle) => candle.t)
  const interval = candles.length > 1 ? Math.max(1, candles[1].t - candles[0].t) : 60_000
  const barAt = (time: number): number | null => {
    if (!Number.isFinite(time) || time < times[0] || time >= times[times.length - 1] + interval) return null
    let lo = 0; let hi = times.length - 1
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if (times[mid] <= time) lo = mid
      else hi = mid - 1
    }
    return times[lo]
  }
  const cleanReason = (value: unknown) => typeof value === 'string' && !value.startsWith('session:') && !['tool', 'chat', 'order'].includes(value) ? value : ''
  const reasonByOid = new Map(orders.filter((row) => row?.oid != null && row.reason).map((row) => [String(row.oid), cleanReason(row.reason)]))
  const sessionByOid = new Map(orders.filter((row) => row?.oid != null && row.sessionId).map((row) => [String(row.oid), String(row.sessionId)]))
  const out: TradeEvent[] = []
  for (const [index, row] of orders.entries()) {
    if (row?.coin !== coin) continue
    const time = Number(row.timestamp ?? row.time ?? row.statusTimestamp)
    const candleTime = barAt(time)
    if (candleTime == null) continue
    out.push({ kind: 'order', coin, time, candleTime, isBuy: row.isBuy ?? row.side === 'B',
      px: Number(row.limitPx ?? row.px), sz: Number(row.origSz ?? row.sz), status: String(row.status ?? ''),
      reason: cleanReason(row.reason), sessionId: row.sessionId ?? null, id: `order:${row.oid ?? row.cloid ?? index}:${time}` })
  }
  for (const [index, row] of fills.entries()) {
    if (row?.coin !== coin) continue
    const time = Number(row.time ?? row.filledTime)
    const candleTime = barAt(time)
    if (candleTime == null) continue
    out.push({ kind: 'fill', coin, time, candleTime, isBuy: row.isBuy ?? row.side === 'B',
      px: Number(row.px ?? row.filledPx), sz: Number(row.sz ?? row.filledSz), status: 'filled',
      reason: cleanReason(row.reason) || reasonByOid.get(String(row.oid)) || '', sessionId: row.sessionId ?? sessionByOid.get(String(row.oid)) ?? null,
      id: `fill:${row.tid ?? row.hash ?? index}:${time}` })
  }
  return out.sort((a, b) => a.candleTime - b.candleTime || a.time - b.time).slice(-120)
}
