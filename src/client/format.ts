/**
 * dsh-hyperliquid — client number/time formatting.
 * @module src/client/format
 */

import { t } from './remote'
import type { Interval } from './types'

export const INTERVALS: Interval[] = ['1m', '5m', '15m', '1h', '4h', '1d']
export const MORE_INTERVALS: Interval[] = ['3m', '30m', '2h', '8h', '12h', '3d', '1w', '1M']

// Drawing labels and live market rows format hundreds of values per frame.
// Reuse the formatter; toLocaleString with options constructs one on every call.
const numberFormats = new Map<number, Intl.NumberFormat>()

export function fmt(n: unknown, d = 2): string {
  const v = Number(n)
  if (!Number.isFinite(v)) return '—'
  let formatter = numberFormats.get(d)
  if (!formatter) {
    formatter = new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
    numberFormats.set(d, formatter)
  }
  return formatter.format(v)
}

/** Price with magnitude-aware precision (prices span 1e-5 … 1e5). */
export function fmtPrice(n: unknown): string {
  const v = Number(n)
  if (!Number.isFinite(v)) return '—'
  if (v >= 1000) return fmt(v, 1)
  if (v >= 1) return fmt(v, 3)
  return fmt(v, 5)
}

export function relTime(ms: number): string {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return ''
  const dt = Date.now() - n
  if (dt < 60_000) return t('time.now', '刚刚')
  if (dt < 3_600_000) return `${Math.floor(dt / 60_000)}m`
  if (dt < 86_400_000) return `${Math.floor(dt / 3_600_000)}h`
  return `${Math.floor(dt / 86_400_000)}d`
}
