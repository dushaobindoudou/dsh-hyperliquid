/**
 * dsh-hyperliquid — trading check-up (交易体检). Turns raw fills into round trips and measures what a
 * trader cannot easily see by hand: expectancy, payoff, holding time, where the money is made or lost
 * (coin, hour, weekday) and behaviour leaks (re-entering right after a loss, over-trading days,
 * weekends). Deterministic, so a weak model never has to add up hundreds of fills in its head.
 * @module lib/analysis
 */

const HOUR = 3_600_000
const num = (value) => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value)

/** Fills from the exchange (side 'B'/'A') or the paper ledger (isBuy), oldest first. */
export function normalizeFills(fills) {
  const seen = new Set()
  return (fills ?? []).filter((fill) => {
    // The exchange can return the same fill twice across pages; tid (or the paper oid) identifies it.
    const id = fill?.tid != null ? `${fill.coin}:${fill.tid}` : fill?.oid != null && fill?.time != null ? `${fill.coin}:${fill.oid}:${fill.time}` : null
    if (id == null) return true
    if (seen.has(id)) return false
    seen.add(id); return true
  }).map((fill) => {
    const buy = typeof fill.isBuy === 'boolean' ? fill.isBuy : fill.side === 'B' ? true : fill.side === 'A' ? false : null
    return { coin: fill.coin, time: num(fill.time), buy, sz: num(fill.sz), px: num(fill.px), start: num(fill.startPosition),
      closedPnl: num(fill.closedPnl ?? fill.realized) ?? 0, fee: num(fill.fee) ?? 0, feeToken: fill.feeToken == null ? 'USDC' : String(fill.feeToken) }
  })
    // USDC-settled perps only: spot (@n, A/B) and outcome (#n) fills, or fees in another token, are not USD P&L.
    .filter((fill) => fill.coin && !/^[@#]/.test(fill.coin) && !fill.coin.includes('/') && fill.feeToken === 'USDC')
    .filter((fill) => fill.time != null && fill.buy != null && fill.sz > 0 && fill.px > 0)
    // Same-millisecond fills: the one starting from the smaller position goes first (an open before its close).
    .sort((a, b) => a.time - b.time || Math.abs(a.start ?? 0) - Math.abs(b.start ?? 0))
}

/**
 * Round trips: a trip opens when the position leaves zero and closes when it returns to zero (a flip
 * closes one trip and opens the next). Trips already open at the window start are marked `partial`
 * and left out of the statistics, because their entry is unknown.
 */
export function roundTrips(fills) {
  const trips = [], open = new Map(), position = new Map()
  for (const fill of normalizeFills(fills)) {
    const prev = fill.start ?? position.get(fill.coin) ?? 0
    const signed = fill.buy ? fill.sz : -fill.sz
    const next = prev + signed
    let trip = open.get(fill.coin)
    if (!trip) {
      trip = { coin: fill.coin, side: Math.sign(prev || signed) > 0 ? 'long' : 'short', openTime: fill.time, closeTime: null, net: 0, fees: 0, fills: 0, maxNotional: 0, partial: Math.abs(prev) > 1e-12 }
      open.set(fill.coin, trip)
    }
    const flat = Math.abs(next) < 1e-9 * Math.max(1, Math.abs(prev), fill.sz)
    const flipped = !flat && prev !== 0 && Math.sign(next) !== Math.sign(prev)
    const openingFee = flipped ? fill.fee * Math.abs(next) / fill.sz : 0
    const closingFee = fill.fee - openingFee
    trip.net += fill.closedPnl - closingFee
    trip.fees += closingFee
    trip.fills += 1
    trip.maxNotional = Math.max(trip.maxNotional, (flipped ? 0 : Math.abs(next)) * fill.px, Math.abs(prev) * fill.px)
    if (flat || flipped) {
      trip.closeTime = fill.time
      trips.push(trip)
      open.delete(fill.coin)
      if (flipped) open.set(fill.coin, { coin: fill.coin, side: next > 0 ? 'long' : 'short', openTime: fill.time, closeTime: null, net: -openingFee, fees: openingFee, fills: 1, maxNotional: Math.abs(next) * fill.px, partial: false })
    }
    position.set(fill.coin, next)
  }
  return { closed: trips, open: [...open.values()] }
}

function summarize(trips) {
  const wins = trips.filter((t) => t.net > 0), losses = trips.filter((t) => t.net <= 0)
  const total = trips.reduce((s, t) => s + t.net, 0)
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.net, 0) / wins.length : 0
  const avgLoss = losses.length ? -losses.reduce((s, t) => s + t.net, 0) / losses.length : 0
  return { trades: trips.length, winRate: trips.length ? wins.length / trips.length : 0, net: total, expectancy: trips.length ? total / trips.length : 0,
    avgWin, avgLoss, payoff: avgLoss > 0 ? avgWin / avgLoss : null,
    profitFactor: losses.length && avgLoss > 0 ? wins.reduce((s, t) => s + t.net, 0) / (avgLoss * losses.length) : null }
}

const groupBy = (trips, keyOf) => {
  const out = new Map()
  for (const trip of trips) { const key = keyOf(trip); if (!out.has(key)) out.set(key, []); out.get(key).push(trip) }
  return [...out].map(([key, rows]) => ({ key, ...summarize(rows) }))
}

/**
 * The check-up. `timeZone` buckets hours and weekdays in the trader's local time.
 * @returns {{ summary, byCoin, byHour, byWeekday, holding, behaviour, findings, coverage }}
 */
export function analyzeTrading(fills, { timeZone = 'Asia/Shanghai', revengeMinutes = 30, funding = null } = {}) {
  const { closed, open } = roundTrips(fills)
  const trips = closed.filter((t) => !t.partial)
  // Funding paid/received while a trip was open belongs to that trip; without funding data it stays unknown.
  if (Array.isArray(funding)) for (const trip of trips) {
    trip.funding = funding.filter((row) => row?.delta?.coin === trip.coin && Number(row.time) > trip.openTime && Number(row.time) <= trip.closeTime)
      .reduce((sum, row) => sum + (num(row.delta.usdc) ?? 0), 0)
    trip.net += trip.funding
  }
  const summary = summarize(trips)
  const fees = trips.reduce((s, t) => s + t.fees, 0)
  const gross = trips.reduce((s, t) => s + t.net + t.fees, 0)
  const local = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23', weekday: 'short' })
  const parts = (time) => Object.fromEntries(local.formatToParts(new Date(time)).map((p) => [p.type, p.value]))
  const hold = (t) => (t.closeTime - t.openTime) / HOUR
  const holdBucket = (t) => hold(t) < 1 ? '<1h' : hold(t) < 24 ? '1–24h' : '>1d'
  const byHour = groupBy(trips, (t) => { const h = Number(parts(t.openTime).hour); const b = Math.floor(h / 4) * 4; return `${String(b).padStart(2, '0')}–${String(b + 4).padStart(2, '0')}` })
  const byWeekday = groupBy(trips, (t) => parts(t.openTime).weekday)
  const byCoin = groupBy(trips, (t) => t.coin).sort((a, b) => b.trades - a.trades)
  const holding = groupBy(trips, holdBucket)
  const holds = trips.map(hold).sort((a, b) => a - b)

  // Behaviour leaks, each compared with the rest of the trades.
  const revenge = [], calm = []
  trips.forEach((trip, index) => {
    const lastLoss = [...trips.slice(0, index)].reverse().find((prev) => prev.closeTime <= trip.openTime)
    const quick = lastLoss && lastLoss.net < 0 && trip.openTime - lastLoss.closeTime <= revengeMinutes * 60_000
    ;(quick ? revenge : calm).push(trip)
  })
  const dayKey = (t) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t.openTime))
  const perDay = groupBy(trips, dayKey)
  const counts = perDay.map((d) => d.trades).sort((a, b) => a - b)
  const median = counts.length ? counts[Math.floor(counts.length / 2)] : 0
  const busyDays = new Set(perDay.filter((d) => d.trades >= Math.max(4, median * 2)).map((d) => d.key))
  const busy = trips.filter((t) => busyDays.has(dayKey(t)))
  const weekend = trips.filter((t) => ['Sat', 'Sun'].includes(parts(t.openTime).weekday))
  let streak = 0, worstStreak = 0, peak = 0, equity = 0, drawdown = 0
  for (const trip of trips) {
    streak = trip.net < 0 ? streak + 1 : 0; worstStreak = Math.max(worstStreak, streak)
    equity += trip.net; peak = Math.max(peak, equity); drawdown = Math.max(drawdown, peak - equity)
  }
  const behaviour = {
    afterLoss: { minutes: revengeMinutes, ...summarize(revenge), others: summarize(calm).expectancy },
    busyDays: { days: busyDays.size, ...summarize(busy) },
    weekend: summarize(weekend),
    worstLosingStreak: worstStreak,
    maxDrawdown: drawdown,
    feeShareOfGross: gross > 0 ? fees / gross : null,
  }

  // Findings: concrete, ranked by money at stake, each with a rule the trader could adopt.
  const findings = []
  // Too few trips to say anything about habits: report the numbers, draw no behavioural conclusions.
  const enough = trips.length >= 10
  if (enough && revenge.length >= 3 && summarize(revenge).expectancy < 0 && summarize(revenge).expectancy < summarize(calm).expectancy)
    findings.push({ impact: -summarize(revenge).net, text: `亏损平仓后 ${revengeMinutes} 分钟内又开仓的 ${revenge.length} 笔，合计 ${summarize(revenge).net.toFixed(2)} USD，平均每笔 ${summarize(revenge).expectancy.toFixed(2)}（其他交易平均 ${summarize(calm).expectancy.toFixed(2)}）`, rule: `亏损平仓后冷静 ${revengeMinutes} 分钟再开新仓` })
  if (enough && busy.length >= 4 && summarize(busy).net < 0)
    findings.push({ impact: -summarize(busy).net, text: `${busyDays.size} 个高频交易日（单日 ≥ ${Math.max(4, median * 2)} 笔）合计 ${summarize(busy).net.toFixed(2)} USD`, rule: `单日交易超过 ${Math.max(3, median + 1)} 笔后停止开新仓` })
  if (enough && weekend.length >= 3 && summarize(weekend).net < 0)
    findings.push({ impact: -summarize(weekend).net, text: `周末开的 ${weekend.length} 笔合计 ${summarize(weekend).net.toFixed(2)} USD`, rule: '周末减半仓位或只做计划内交易' })
  if (enough) for (const coin of byCoin) if (coin.trades >= 5 && coin.net < 0 && coin.expectancy < summary.expectancy)
    findings.push({ impact: -coin.net, text: `${coin.key} 做了 ${coin.trades} 笔，合计 ${coin.net.toFixed(2)} USD，胜率 ${(coin.winRate * 100).toFixed(0)}%`, rule: `暂停 ${coin.key}，或只按策略库里的规则做` })
  if (enough) for (const bucket of holding) if (bucket.trades >= 5 && bucket.net < 0)
    findings.push({ impact: -bucket.net, text: `持仓 ${bucket.key} 的 ${bucket.trades} 笔合计 ${bucket.net.toFixed(2)} USD`, rule: bucket.key === '<1h' ? '减少 1 小时内的短线进出' : `检查持仓 ${bucket.key} 时的离场规则` })
  if (enough && behaviour.feeShareOfGross != null && behaviour.feeShareOfGross > 0.25 && fees > 5)
    findings.push({ impact: fees * 0.5, text: `手续费 ${fees.toFixed(2)} USD，占毛利的 ${(behaviour.feeShareOfGross * 100).toFixed(0)}%`, rule: '入场优先用挂单（Alo），减少追价和频繁进出' })
  const best = byCoin.filter((c) => c.trades >= 5 && c.net > 0).sort((a, b) => b.net - a.net)[0]
  if (enough && best) findings.push({ impact: 0, strength: true, text: `强项：${best.key} ${best.trades} 笔合计 +${best.net.toFixed(2)} USD，胜率 ${(best.winRate * 100).toFixed(0)}%`, rule: `把 ${best.key} 的做法整理成策略库里的一条规则` })
  findings.sort((a, b) => b.impact - a.impact)

  return {
    summary: { ...summary, fees, gross, funding: Array.isArray(funding) ? trips.reduce((s, t) => s + (t.funding ?? 0), 0) : null, sampleEnough: enough, medianHoldHours: holds.length ? holds[Math.floor(holds.length / 2)] : null, openTrips: open.length, partialTrips: closed.length - trips.length },
    byCoin, byHour, byWeekday, holding, behaviour, findings,
    coverage: { fills: normalizeFills(fills).length, from: trips[0]?.openTime ?? null, to: trips.at(-1)?.closeTime ?? null },
  }
}

/** Short, model-friendly text: headline numbers, ranked findings, then the profile the trades imply. */
export function checkupText(result, { days, mode }) {
  const s = result.summary
  const pct = (v) => `${(v * 100).toFixed(0)}%`
  const money = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`
  if (!s.trades) return `近 ${days} 天（${mode}）没有完整的往返交易可分析（成交 ${result.coverage.fills} 笔，未平仓 ${s.openTrips} 笔）。新用户：改为用 hyper_market action=scan 给出今天的机会，并建议先用模拟盘验证一个策略。`
  const lines = [
    `交易体检 · 近 ${days} 天 · ${mode} · ${s.trades} 笔完整往返（另有 ${s.partialTrips} 笔窗口前开仓未计入、${s.openTrips} 笔未平仓）`,
    `净盈亏 ${money(s.net)} USD · 胜率 ${pct(s.winRate)} · 盈亏比 ${s.payoff == null || s.avgWin === 0 ? '—' : s.payoff.toFixed(2)} · 每笔期望 ${money(s.expectancy)} USD · 手续费 ${s.fees.toFixed(2)} USD · 中位持仓 ${s.medianHoldHours == null ? '—' : s.medianHoldHours.toFixed(1) + 'h'}`,
    `资金费 ${s.funding == null ? '未取得（净盈亏未含资金费）' : money(s.funding) + ' USD（已计入净盈亏）'} · 最长连亏 ${result.behaviour.worstLosingStreak} 笔 · 最大回撤 ${result.behaviour.maxDrawdown.toFixed(2)} USD`,
    s.sampleEnough ? '' : `样本只有 ${s.trades} 笔完整往返，不足以判断交易习惯；以下只是数字，不要据此给用户下结论。`,
    `按币种：${result.byCoin.slice(0, 6).map((c) => `${c.key} ${c.trades}笔 ${money(c.net)} 胜率${pct(c.winRate)}`).join('；')}`,
    `按开仓时段（本地）：${result.byHour.sort((a, b) => a.key.localeCompare(b.key)).map((h) => `${h.key} ${money(h.net)}`).join('；')}`,
    `按持仓时长：${result.holding.map((h) => `${h.key} ${h.trades}笔 ${money(h.net)}`).join('；')}`,
    result.findings.length ? '发现（按金额影响排序）：\n' + result.findings.slice(0, 5).map((f, i) => `${i + 1}. ${f.text} → 建议规则：${f.rule}`).join('\n') : s.sampleEnough ? '没有发现明显的习惯问题。' : '',
    '下一步：挑影响最大的 1–2 条给用户看，问他是否设为规则；用户同意后才写入 hyper_journal（profile 或 lesson），不要自行修改档案。',
  ]
  return lines.filter(Boolean).join('\n')
}
