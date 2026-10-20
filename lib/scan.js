/**
 * dsh-hyperliquid — market radar (市场雷达). Scans the most liquid tradable perps (core + USDC HIP-3)
 * for a few plain, verifiable signals and returns the top few of each with the data time, so the
 * agent opens a conversation with something concrete instead of a questionnaire.
 * Kept deliberately small (codex review): ~20 markets, cached, no OI-anomaly claims without a baseline.
 * @module lib/scan
 */

import { closedCandles } from './indicators.js'

const num = (value) => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value)

/**
 * Pure part: rank markets by signal. `ranges` maps coin → { high, low, bars } of the last closed 1h bars.
 * @returns {{ funding, movers, premium, levels }} top entries per signal
 */
export function rankSignals(markets, ranges = {}, { top = 3 } = {}) {
  const rows = markets.map((m) => {
    const ctx = m.ctx ?? {}
    const mark = num(ctx.markPx), prev = num(ctx.prevDayPx), oracle = num(ctx.oraclePx), funding = num(ctx.funding)
    return { coin: m.name, kind: m.kind, mark, change24h: mark && prev ? mark / prev - 1 : null,
      fundingApr: funding == null ? null : funding * 24 * 365, premium: mark && oracle ? mark / oracle - 1 : null, volume: num(ctx.dayNtlVlm) }
  }).filter((row) => row.mark != null)
  const pick = (list, score) => list.filter((row) => score(row) != null).sort((a, b) => Math.abs(score(b)) - Math.abs(score(a))).slice(0, top)
  const levels = rows.map((row) => {
    const range = ranges[row.coin]
    if (!range || !(range.high > range.low)) return null
    const toHigh = range.high / row.mark - 1, toLow = row.mark / range.low - 1
    const side = toHigh <= toLow ? 'high' : 'low'
    return { ...row, side, distance: Math.min(Math.abs(toHigh), Math.abs(toLow)), high: range.high, low: range.low, bars: range.bars, broken: row.mark > range.high || row.mark < range.low }
  }).filter(Boolean).sort((a, b) => (Number(b.broken) - Number(a.broken)) || a.distance - b.distance).slice(0, top)
  return {
    funding: pick(rows, (row) => row.fundingApr),
    movers: pick(rows, (row) => row.change24h),
    premium: pick(rows.filter((row) => row.kind === 'hip3' || Math.abs(row.premium ?? 0) > 0.001), (row) => row.premium),
    levels,
  }
}

const cache = new Map()

/** Live part: pick the liquid tradable perps, read their last 20 closed 1h bars, rank. Cached 60s. */
export async function scanMarkets(remote, { limit = 20, minVolumeUsd = 1_000_000 } = {}) {
  const network = remote.cfg?.network, client = remote.client
  const assertCurrent = () => { if (remote.cfg?.network !== network || remote.client !== client) throw new Error('网络已切换，请重新扫描') }
  const key = `${network}:${limit}:${minVolumeUsd}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < 60_000) return hit.result
  const catalog = await remote.marketCatalog()
  assertCurrent()
  // HIP-3 contexts normally arrive over the websocket; when the catalog has none, read each dex once.
  const missing = [...new Set(catalog.markets.filter((m) => m.kind === 'hip3' && m.tradable && !m.ctx).map((m) => m.name.split(':')[0]))]
  const filled = new Map()
  await Promise.all(missing.map(async (dex) => {
    try {
      const [meta, ctxs] = await client.info('metaAndAssetCtxs', { dex })
      for (const [index, asset] of (meta?.universe ?? []).entries()) if (ctxs?.[index]) filled.set(asset.name, ctxs[index])
    } catch { /* that dex simply stays out of this scan */ }
  }))
  assertCurrent()
  if (filled.size) catalog.markets = catalog.markets.map((m) => !m.ctx && filled.has(m.name) ? { ...m, ctx: filled.get(m.name) } : m)
  // Core perps dominate volume; reserve a quarter of the slots for HIP-3 (indices, stocks, commodities).
  const liquid = (kind) => catalog.markets.filter((m) => m.kind === kind && m.tradable && num(m.ctx?.dayNtlVlm) >= minVolumeUsd)
    .sort((a, b) => num(b.ctx.dayNtlVlm) - num(a.ctx.dayNtlVlm))
  const hip3 = liquid('hip3').slice(0, Math.floor(limit / 4))
  const markets = [...liquid('perp').slice(0, limit - hip3.length), ...hip3]
  const ranges = {}
  await Promise.all(markets.map(async (m) => {
    try {
      const { candles } = await remote.candles({ coin: m.name, interval: '1h' })
      // Closed bars only: the forming bar is not part of the range it might be breaking.
      const rows = closedCandles(candles, { interval: '1h' }).rows.slice(-20)
      if (rows.length >= 20) ranges[m.name] = { high: Math.max(...rows.map((r) => r.h)), low: Math.min(...rows.map((r) => r.l)), bars: rows.length }
    } catch { /* one market's candles must not sink the scan */ }
  }))
  assertCurrent()
  const result = { ...rankSignals(markets, ranges), scanned: markets.length, observedAt: catalog.ctxObservedAt ?? catalog.observedAt ?? Date.now(), network }
  cache.set(key, { at: Date.now(), result })
  return result
}

export function scanText(result) {
  const pct = (v, d = 2) => v == null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%`
  const lines = [`市场雷达 · 扫描 ${result.scanned} 个可交易永续（成交额最大的核心永续，另留 1/4 名额给成交额最大的 HIP-3）· 数据时间 ${new Date(result.observedAt).toISOString().slice(0, 16)}Z`]
  if (result.levels.length) lines.push('贴近/突破 20 根 1h 区间：' + result.levels.map((r) => `${r.coin} ${r.broken ? (r.mark > r.high ? '已上破' : '已下破') : `距${r.side === 'high' ? '高点' : '低点'} ${(r.distance * 100).toFixed(2)}%`}（区间 ${r.low}–${r.high}）`).join('；'))
  if (result.funding.length) lines.push('资金费极值（年化）：' + result.funding.map((r) => `${r.coin} ${pct(r.fundingApr, 1)}${r.fundingApr > 0 ? '（多头付费）' : '（空头付费）'}`).join('；'))
  if (result.movers.length) lines.push('24h 涨跌最大：' + result.movers.map((r) => `${r.coin} ${pct(r.change24h)}`).join('；'))
  if (result.premium.length) lines.push('标记价相对预言机：' + result.premium.map((r) => `${r.coin} ${pct(r.premium, 3)}`).join('；'))
  lines.push('下一步：只挑 1 个与用户偏好最匹配的机会，用 hyper_market candles/indicators 核实，再用 hyper_chart 画出区间和 long/short 头寸框给用户看；雷达只是线索，不是交易信号。')
  return lines.join('\n')
}
