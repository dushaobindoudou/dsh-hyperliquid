const INTERVALS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d', '3d', '1w', '1M']
export function normalizeResearch(input = {}) {
  const next = { layout: 'single', intervals: ['1h', '4h', '1d'], syncTime: true, syncCursor: true, ...input }
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['layout', 'intervals', 'syncTime', 'syncCursor'].includes(key)) || !['single', 'dual', 'quad'].includes(next.layout)
    || !Array.isArray(next.intervals) || next.intervals.length !== 3 || next.intervals.some((iv) => !INTERVALS.includes(iv)) || typeof next.syncTime !== 'boolean' || typeof next.syncCursor !== 'boolean') throw Error('多周期研究配置无效')
  return next
}
/** Simulation assumptions; not the exchange account's actual fee tier. */
export function normalizePaperCosts(input = { feeBps: 4.5, slippageBps: 5 }) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2 || !['feeBps', 'slippageBps'].every((key) => typeof input[key] === 'number' && Number.isFinite(input[key]) && input[key] >= 0 && input[key] <= 100)) throw Error('模拟费用和滑点必须为 0–100 bps')
  return { feeBps: input.feeBps, slippageBps: input.slippageBps }
}
