/** Incremental chart feeds, with full replacement after historical corrections. */
export type SeriesPoint = { time: number; value?: number; open?: number; high?: number; low?: number; close?: number; color?: string }
type Series = { setData: (data: any[]) => void; update: (point: any) => void }
const fedShape = new WeakMap<object, { data: SeriesPoint[]; sig: string }>()
const fields = ['time', 'value', 'open', 'high', 'low', 'close', 'color'] as const

function samePrefix(previous: SeriesPoint[], data: SeriesPoint[], length: number): boolean {
  for (let i = 0; i < length; i++) for (const key of fields) if (previous[i][key] !== data[i][key]) return false
  return true
}

export function feed(series: Series, data: SeriesPoint[], sig = ''): void {
  const prev = fedShape.get(series)
  const len = data.length, first = data[0]?.time, last = data.at(-1)?.time
  const tailOnly = prev && prev.sig === sig && len > 0 && first === prev.data[0]?.time &&
    (len === prev.data.length ? last === prev.data.at(-1)?.time : len === prev.data.length + 1 && data.at(-2)?.time === prev.data.at(-1)?.time) &&
    samePrefix(prev.data, data, prev.data.length - 1)
  if (tailOnly) {
    if (len === prev.data.length + 1) series.update(data.at(-2))
    series.update(data.at(-1))
  } else series.setData(data)
  fedShape.set(series, { data, sig })
}
