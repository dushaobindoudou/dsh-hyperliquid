/**
 * dsh-hyperliquid — the snapshot a 盯盘 wake carries: the watch interval plus the higher timeframes,
 * the session's own position and whether a real stop covers it, and the plan in force. Precomputed
 * so the round starts from the big picture (2026-10-22: 84 of 99 rounds read 15m only and kept
 * buying a falling market) and an unprotected position is the first thing the agent sees.
 * Every part is best-effort: a failed read drops that line, never the wake.
 * @module lib/watch-digest
 */
import { computeIndicators } from './indicators.js'

const INTERVAL_MS = { '5m': 5 * 60_000, '15m': 15 * 60_000, '30m': 30 * 60_000, '1h': 60 * 60_000, '2h': 2 * 60 * 60_000,
  '4h': 4 * 60 * 60_000, '1d': 24 * 60 * 60_000, '1w': 7 * 24 * 60 * 60_000 }
/** The frames read above each watch interval: one for direction, one for the regime. */
export const HIGHER_FRAMES = { '5m': ['15m', '1h', '4h'], '15m': ['1h', '4h', '1d'], '30m': ['2h', '4h', '1d'], '1h': ['4h', '1d'], '2h': ['4h', '1d'], '4h': ['1d', '1w'] }
const BARS = 260

const fmt = (value, digits = 2) => Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-US', { maximumFractionDigits: digits }) : '—'

/** One line per timeframe: close vs EMA20/EMA50, momentum and range, from closed bars only. */
export function frameLine(interval, candles, now = Date.now()) {
  const ind = computeIndicators(candles, { interval, now })
  if (!ind.ready) return `${interval}：数据不足（${ind.reason}）`
  const trend = ind.close > ind.ema20 && ind.ema20 > ind.ema50 ? '多头排列'
    : ind.close < ind.ema20 && ind.ema20 < ind.ema50 ? '空头排列' : '均线缠绕'
  return `${interval}：收 ${fmt(ind.close)}｜EMA20 ${fmt(ind.ema20)} / EMA50 ${fmt(ind.ema50)}（${trend}）｜RSI ${fmt(ind.rsi14, 1)}｜MACD 柱 ${fmt(ind.macd.histogram, 1)}｜ATR ${fmt(ind.atr14)}`
}

/** The session's position and how much of it a reduce-only stop of its own covers. */
export function protectionLine(view) {
  if (!view) return null
  if (!view.ownershipConfirmed) return `⚠ 本会话仓位归属未确认（账户净仓 ${fmt(view.accountSize, 6)}）：仓位缺止损时先 hyper_order action=protect 补挂（给 sz），再在汇报第一行告诉用户。`
  const size = Number(view.sessionSize ?? 0)
  if (!size) return '本会话：空仓。'
  const own = (view.pendingExits ?? []).filter((order) => order.sessionId === view.sessionId && order.isTrigger)
  const sizeOf = (order) => Math.abs(Number(order.sz ?? order.origSz ?? 0))
  const stops = own.filter((order) => /stop/i.test(String(order.orderType ?? '')))
  const targets = own.filter((order) => /take profit/i.test(String(order.orderType ?? '')))
  const covered = stops.reduce((sum, order) => sum + sizeOf(order), 0)
  const prices = (rows) => rows.map((order) => fmt(order.triggerPx)).join('/') || '—'
  const head = `本会话：${size > 0 ? '多' : '空'} ${fmt(Math.abs(size), 6)}${view.entryPx ? ` @ ${fmt(view.entryPx)}` : ''}`
  if (covered < Math.abs(size) * 0.99) return `⚠ ${head}｜止损只覆盖 ${fmt(covered, 6)}：本轮第一件事用 hyper_order action=protect 补足止损。`
  return `${head}｜止损 ${prices(stops)} ✓｜止盈 ${prices(targets)}`
}

/** The strategy and the latest plan this session recorded for the coin. */
export function planLine(journal, { sessionId, coin }) {
  const strategies = (journal?.strategies ?? []).filter((row) => ['active', 'testing'].includes(row.status)
    && (!row.markets || String(row.markets).split(',').map((name) => name.trim()).some((name) => name === coin || name === '*')))
  const plan = [...(journal?.entries ?? [])].reverse().find((entry) => entry.type === 'plan' && (!entry.sessionId || entry.sessionId === sessionId) && (!entry.coin || entry.coin === coin))
  const parts = []
  if (strategies.length) parts.push('策略 ' + strategies.map((row) => `[${row.id}] ${row.name ?? ''} v${row.version ?? 1}`).join('、'))
  if (plan) parts.push(`最近计划（${new Date(plan.at).toISOString().slice(5, 16)}Z）：${String(plan.text ?? '').slice(0, 140)}`)
  return parts.length ? parts.join('｜') : null
}

/**
 * @param {object} remote - the desk Remote (candles, sessionExecution, store)
 * @param {{ sessionId: string, coin: string, interval: string }} target
 * @returns {Promise<string[]>} the snapshot lines, possibly empty
 */
export async function watchDigest(remote, { sessionId, coin, interval, now = Date.now() }) {
  const frames = [interval, ...(HIGHER_FRAMES[interval] ?? ['1h', '4h'])]
  const [reads, view] = await Promise.all([
    Promise.allSettled(frames.map((frame) => remote.candles({ coin, interval: frame, startMs: now - INTERVAL_MS[frame] * BARS }))),
    remote.sessionExecution ? remote.sessionExecution(sessionId, coin, undefined, { fresh: false }).catch(() => null) : null,
  ])
  const lines = []
  reads.forEach((read, index) => { if (read.status === 'fulfilled') lines.push(frameLine(frames[index], read.value.candles, now)) })
  const protection = protectionLine(view)
  if (protection) lines.push(protection)
  try {
    const plan = planLine(remote.store.journal(sessionId), { sessionId, coin })
    if (plan) lines.push(plan)
  } catch { /* the journal is optional context */ }
  return lines
}
