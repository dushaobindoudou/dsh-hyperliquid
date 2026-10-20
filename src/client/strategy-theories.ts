/** Closed-candle strategy study cards. These are observable conditions, not trade signals. */
import type { Candle, Interval } from './types'
import { chartIndicators } from './chart-indicators'

export type StrategyState = 'candidate' | 'watch' | 'stale' | 'insufficient'
export interface StrategyStudy {
  id: 'trend' | 'breakout' | 'reentry'
  title: string
  state: StrategyState
  summary: string
  evidence: string[]
  invalidation: string
  source: string
  prompt: string
}

const MINUTES: Record<Exclude<Interval, '1M'>, number> = {
  '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '2h': 120,
  '4h': 240, '8h': 480, '12h': 720, '1d': 1440, '3d': 4320, '1w': 10080,
}
const SOURCES = {
  trend: 'https://doi.org/10.1016/j.jfineco.2011.11.003',
  breakout: 'https://www.bollingerbands.com/bollinger-band-rules',
  reentry: 'https://www.bollingerbands.com/bollinger-band-rules',
}
const higher: Partial<Record<Interval, Interval>> = {
  '1m': '15m', '3m': '15m', '5m': '1h', '15m': '1h', '30m': '4h', '1h': '4h', '2h': '8h', '4h': '1d',
  '8h': '1d', '12h': '1d', '1d': '1w', '3d': '1w', '1w': '1M',
}

function closedAt(candle: Candle, interval: Interval): number {
  if (interval === '1M') {
    const d = new Date(candle.t)
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
  }
  return candle.t + MINUTES[interval] * 60_000
}

function num(value: number | undefined, decimals = 4): string {
  return value == null || !Number.isFinite(value) ? '—' : Number(value.toFixed(decimals)).toString()
}

function pointAt(points: Array<{ time: number; value: number }>, candle: Candle | undefined): number | undefined {
  return candle ? points.find((point) => point.time === Math.floor(candle.t / 1000))?.value : undefined
}

function atr14(rows: Candle[]): number | undefined {
  if (rows.length < 15) return undefined
  const ranges = rows.slice(1).map((candle, index) => Math.max(candle.h - candle.l,
    Math.abs(candle.h - rows[index].c), Math.abs(candle.l - rows[index].c)))
  let value = ranges.slice(0, 14).reduce((sum, item) => sum + item, 0) / 14
  for (const item of ranges.slice(14)) value = (value * 13 + item) / 14
  return value
}

export function evaluateStrategyStudies(candles: Candle[], coin: string, interval: Interval, now = Date.now(), english = false): StrategyStudy[] {
  const say = (zh: string, en: string) => english ? en : zh
  const valid = candles.filter((row) => Number.isFinite(row.t) && Number.isFinite(row.c) && row.c > 0 &&
    Number.isFinite(row.h) && Number.isFinite(row.l) && row.h >= row.l && Number.isFinite(row.v))
  const rows = [...new Map(valid.map((row) => [row.t, row])).values()]
    .sort((a, b) => a.t - b.t).filter((row) => closedAt(row, interval) <= now)
  const latest = rows.at(-1)
  const previous = rows.at(-2)
  const periodMs = interval === '1M' ? 31 * 86400_000 : MINUTES[interval] * 60_000
  const dataState: StrategyState | null = rows.length < 60 ? 'insufficient'
    : latest && now - closedAt(latest, interval) > periodMs * 3 ? 'stale' : null
  const stateSummary = dataState === 'insufficient'
    ? say(`仅有 ${rows.length} 根已收盘 K 线；至少需要 60 根。`, `Only ${rows.length} closed candles; at least 60 are required.`)
    : dataState === 'stale' ? say('最新已收盘 K 线过期，等待行情恢复。', 'The latest closed candle is stale; wait for market data.') : ''
  const studies = chartIndicators(rows)
  const close = latest?.c
  const ema20 = pointAt(studies.ema20, latest)
  const ema50 = pointAt(studies.ema50, latest)
  const ema20Prior = pointAt(studies.ema20, rows.at(-6))
  const rsi = pointAt(studies.rsi14, latest)
  const upper = pointAt(studies.upper, latest)
  const lower = pointAt(studies.lower, latest)
  const previousUpper = pointAt(studies.upper, previous)
  const previousLower = pointAt(studies.lower, previous)
  const range = rows.slice(-21, -1)
  const high20 = range.length === 20 ? Math.max(...range.map((row) => row.h)) : undefined
  const low20 = range.length === 20 ? Math.min(...range.map((row) => row.l)) : undefined
  const volumeMean = range.length === 20 ? range.reduce((sum, row) => sum + row.v, 0) / 20 : undefined
  const volumeRatio = latest && volumeMean && volumeMean > 0 ? latest.v / volumeMean : undefined
  const atr = atr14(rows)
  const stamp = latest ? new Date(closedAt(latest, interval)).toISOString() : '—'
  const risk = say(`ATR14=${num(atr)}；还需核对盘口滑点、手续费、资金费、仓位与止损距离。`,
    `ATR14=${num(atr)}; also check book slippage, fees, funding, positions and stop distance.`)
  const prompt = (title: string, evidence: string[], invalidation: string) => say(
    `请仅分析，不要下单。用“${title}”框架核对 ${coin} ${interval}：${evidence.join('；')}；${risk}。最新已收盘时间 ${stamp}。请调用 hyper_context 和 hyper_market indicators，核对当前周期及 ${higher[interval] ?? interval} 高一级周期、盘口、资金费、账户风险与数据时间；说明入场条件、失效条件（${invalidation}）、退出和不交易条件。不要把历史理论当作本市场的收益保证。`,
    `Analysis only; do not place an order. Evaluate ${coin} ${interval} with the ${title} framework: ${evidence.join('; ')}; ${risk}. Latest closed candle ${stamp}. Use hyper_context and hyper_market indicators to verify this and the ${higher[interval] ?? interval} higher interval, order book, funding, account risk and freshness. State entry, invalidation (${invalidation}), exit and no-trade conditions. Do not treat historical research as a profit guarantee.`)
  const make = (id: StrategyStudy['id'], title: string, candidate: boolean, summary: string, evidence: string[], invalidation: string): StrategyStudy => ({
    id, title, state: dataState ?? (candidate ? 'candidate' : 'watch'), summary: dataState ? stateSummary : summary,
    evidence: dataState ? [] : evidence, invalidation, source: SOURCES[id], prompt: prompt(title, evidence, invalidation),
  })

  const trendUp = close != null && ema20 != null && ema50 != null && ema20Prior != null && close > ema20 && ema20 > ema50 && ema20 > ema20Prior
  const trendDown = close != null && ema20 != null && ema50 != null && ema20Prior != null && close < ema20 && ema20 < ema50 && ema20 < ema20Prior
  const trendEvidence = [say(`收盘 ${num(close)}，EMA20 ${num(ema20)}，EMA50 ${num(ema50)}`, `Close ${num(close)}, EMA20 ${num(ema20)}, EMA50 ${num(ema50)}`)]
  const breakoutUp = close != null && high20 != null && close > high20 && volumeRatio != null && volumeRatio >= 1.5
  const breakoutDown = close != null && low20 != null && close < low20 && volumeRatio != null && volumeRatio >= 1.5
  const breakoutEvidence = [say(`前 20 根高/低 ${num(high20)} / ${num(low20)}，量比 ${num(volumeRatio, 2)}×`,
    `Prior 20-bar high/low ${num(high20)} / ${num(low20)}, volume ratio ${num(volumeRatio, 2)}x`)]
  const flat = close != null && ema20 != null && ema50 != null && Math.abs(ema20 - ema50) / close < .02
  const reentryUp = flat && previous != null && previousLower != null && lower != null && rsi != null && previous.c < previousLower && close! > lower && rsi < 45
  const reentryDown = flat && previous != null && previousUpper != null && upper != null && rsi != null && previous.c > previousUpper && close! < upper && rsi > 55
  const reentryEvidence = [say(`布林上下轨 ${num(lower)} / ${num(upper)}，RSI14 ${num(rsi, 1)}，EMA20/50 差距 ${close ? num(Math.abs((ema20 ?? 0) - (ema50 ?? 0)) / close * 100, 2) : '—'}%`,
    `Bollinger lower/upper ${num(lower)} / ${num(upper)}, RSI14 ${num(rsi, 1)}, EMA20/50 gap ${close ? num(Math.abs((ema20 ?? 0) - (ema50 ?? 0)) / close * 100, 2) : '—'}%`)]
  return [
    make('trend', say('趋势跟随', 'Trend following'), Boolean(trendUp || trendDown),
      trendUp ? say('上行排列；等待回撤与风险核对。', 'Uptrend alignment; check pullback and risk.')
        : trendDown ? say('下行排列；等待反弹与风险核对。', 'Downtrend alignment; check rebound and risk.')
          : say('均线与价格尚未同向排列。', 'Price and moving averages are not aligned.'), trendEvidence,
      say('收盘重新穿越 EMA20 或更高周期趋势改变', 'a close across EMA20 or a higher-timeframe trend change')),
    make('breakout', say('区间突破', 'Range breakout'), Boolean(breakoutUp || breakoutDown),
      breakoutUp ? say('收盘突破前 20 根高点且量比达到 1.5 倍。', 'Close above the prior 20-bar high with 1.5x volume.')
        : breakoutDown ? say('收盘跌破前 20 根低点且量比达到 1.5 倍。', 'Close below the prior 20-bar low with 1.5x volume.')
          : say('收盘突破与量能尚未同时满足。', 'Close breakout and volume confirmation are not both present.'), breakoutEvidence,
      say('收盘重新回到突破前区间', 'a close back inside the prior range')),
    make('reentry', say('波动带回归', 'Band re-entry'), Boolean(reentryUp || reentryDown),
      reentryUp ? say('前根跌出下轨，本根收回轨内；需排除单边下跌。', 'Prior close below lower band, now back inside; rule out a strong downtrend.')
        : reentryDown ? say('前根涨出上轨，本根收回轨内；需排除单边上涨。', 'Prior close above upper band, now back inside; rule out a strong uptrend.')
          : say('未出现平缓趋势中的轨外回归确认。', 'No band re-entry confirmation in a mild trend.'), reentryEvidence,
      say('再次收盘于轨外或趋势明显加速', 'another close outside the band or accelerating trend')),
  ]
}
