import type { Candle } from './types'

export type ChartType = 'candles' | 'bars' | 'line' | 'area' | 'heikinAshi'
export type ChartAction =
  { kind: 'live' } | { kind: 'fit' } | { kind: 'snapshot' } | { kind: 'range'; duration: number } | { kind: 'date'; time: number }
export type ChartCommand = ChartAction & { at: number }

/** Heikin Ashi changes only the picture; quoting and trading retain exchange OHLC. */
export function chartBars(candles: readonly Candle[], type: ChartType): Candle[] {
  if (type !== 'heikinAshi') return [...candles]
  const result: Candle[] = []
  for (const candle of candles) {
    const prior = result.at(-1)
    const o = prior ? (prior.o + prior.c) / 2 : (candle.o + candle.c) / 2
    const c = (candle.o + candle.h + candle.l + candle.c) / 4
    result.push({ ...candle, o, c, h: Math.max(candle.h, o, c), l: Math.min(candle.l, o, c) })
  }
  return result
}

/** First bar at or after the requested time; clamps to the loaded range. */
export function candleIndex(candles: readonly Candle[], time: number): number {
  let low = 0, high = candles.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (candles[mid].t < time) low = mid + 1; else high = mid
  }
  return Math.min(low, candles.length - 1)
}

/** Numeric exchange data only, with UTC timestamps and explicit symbol/interval columns. */
export function candlesCsv(candles: readonly Candle[], coin: string, interval: string): string {
  const cell = (value: string) => '"' + value.replaceAll('"', '""') + '"'
  return '\ufeff' + ['symbol,interval,time_utc,open,high,low,close,volume', ...candles.map((bar) =>
    [cell(coin), cell(interval), new Date(bar.t).toISOString(), bar.o, bar.h, bar.l, bar.c, bar.v].join(','))].join('\r\n') + '\r\n'
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url; link.download = filename
  document.body.append(link); link.click(); link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
