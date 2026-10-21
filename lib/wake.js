/**
 * dsh-hyperliquid — wake the trading session's agent when something it should know about happens
 * (a price alert on one of its lines). v1 is notify-only: the message asks the agent to re-check and
 * tell the trader; it is explicitly not an instruction or an authorisation to trade.
 *
 * Guard rails (codex review): each event is delivered once, events within a short window are merged,
 * a session is woken at most once per cooldown (later events wait for the next slot and are merged),
 * stale events are dropped, and deliveries for one session are serial.
 * @module lib/wake
 */

const DEFAULTS = { debounceMs: 5_000, cooldownMs: 5 * 60_000, staleMs: 10 * 60_000 }

/**
 * @param {{ deliver: (sessionId: string, text: string) => Promise<boolean>, describe?: (events: object[]) => string,
 *   now?: () => number, setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout, debounceMs?: number, cooldownMs?: number, staleMs?: number }} options
 */
export function createAgentWaker(options) {
  const { deliver, describe = alertWakeText, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = options
  const { debounceMs, cooldownMs, staleMs } = { ...DEFAULTS, ...options }
  let disposed = false
  const controller = new AbortController()
  const seen = new Set()
  const sessions = new Map() // sessionId → { pending: event[], timer, lastAt, busy }
  const state = (id) => { if (!sessions.has(id)) sessions.set(id, { pending: [], timer: null, lastAt: -Infinity, busy: false }); return sessions.get(id) }

  const flush = async (sessionId) => {
    if (disposed) return
    const s = state(sessionId)
    s.timer = null
    if (s.busy) { schedule(sessionId, debounceMs); return }
    // A timer set while the previous delivery was in flight may fire early: honour the cooldown here.
    const wait = s.lastAt + cooldownMs - now()
    if (wait > 0) { schedule(sessionId, wait); return }
    const fresh = s.pending.filter((event) => now() - event.at <= staleMs)
    s.pending = []
    if (!fresh.length) return
    s.busy = true
    try {
      if (await deliver(sessionId, describe(fresh), { signal: controller.signal })) s.lastAt = now()
    } catch { /* the desk still shows the alert; never retry into a loop */ }
    finally { s.busy = false }
    if (s.pending.length) schedule(sessionId, Math.max(debounceMs, s.lastAt + cooldownMs - now()))
  }
  const schedule = (sessionId, delay) => {
    if (disposed) return
    const s = state(sessionId)
    if (s.timer) return
    s.timer = setTimer(() => { void flush(sessionId) }, Math.max(0, delay))
    s.timer?.unref?.()
  }

  return {
    /** Queue one event (`{ id, at, sessionId, ... }`); returns false when it was a duplicate or unroutable. */
    notify(event) {
      if (disposed || !event?.sessionId || !event.id) return false
      const key = `${event.id}:${event.at}`
      if (seen.has(key)) return false
      seen.add(key)
      if (seen.size > 5000) seen.delete(seen.values().next().value)
      const s = state(event.sessionId)
      s.pending.push(event)
      schedule(event.sessionId, Math.max(debounceMs, s.lastAt + cooldownMs - now()))
      return true
    },
    /** Last delivery time for a session (the turn-origin guard uses it when a turn was not observed). */
    wokenAt(sessionId) { const s = sessions.get(sessionId); return s && Number.isFinite(s.lastAt) ? s.lastAt : undefined },
    dispose() { disposed = true; controller.abort(); for (const s of sessions.values()) if (s.timer) clearTimer(s.timer); sessions.clear() },
  }
}

const fmtPrice = (value) => Number(value).toLocaleString('en-US', { maximumFractionDigits: Number(value) >= 100 ? 2 : 6 })

/** The message the agent receives: facts first, then the closed-loop watch protocol. */
export function alertWakeText(events) {
  const lines = events.map((event) => `- ${event.coin} 价格${event.direction === 'up' ? '上穿' : '下穿'}「${event.label}」（线价 ${fmtPrice(event.line)}，现价 ${fmtPrice(event.price)}，${new Date(event.at).toISOString().slice(11, 19)}Z）`)
  return [
    '[交易台事件] 价格提醒已触发：',
    ...lines,
    '这是交易台自动事件。本会话已开启盯盘，按盯盘闭环自主处理，无需等待用户：',
    '1. 取数：hyper_context + hyper_account state/orders 核对最新价格、仓位、挂单与资金费；',
    '2. 判市：对照 hyper_journal 里与这条线相关的计划与策略条件，判断是触发、作废还是仅观察；',
    '3. 执行：条件成立 → hyper_decide + hyper_order，开仓必须带 stopLossPx；计划失效或方向翻转 → 只撤本策略挂单；完成后核对成交和实际止损挂单，保护未生效先处理裸露仓位；',
    '4. 汇报：两三句话讲清发生了什么、做了什么；与计划无关时一句话即可。',
    '红线：提现不可做，自动开仓必须带止损；其余授权操作仍受交易限额与档案纪律约束。',
  ].join('\n')
}

/** One closed-candle decision opportunity, never a claim that a trade signal exists. */
export function marketBarWakeText(events) {
  const lines = events.map((event) => {
    const c = event.candle
    return `- ${event.coin} ${event.interval ?? '15m'} 已收盘 K 线 ${new Date(c.t).toISOString()}：O ${c.o} / H ${c.h} / L ${c.l} / C ${c.c} / V ${c.v}；候选策略 ${event.strategyIds.join(', ') || '无'}`
  })
  return [
    '[交易台盯盘] 本会话已开启盯盘（含自主交易），盯盘周期已收盘，无需等用户，执行一轮：',
    ...lines,
    '1. 取数：hyper_context、hyper_account state/orders、hyper_journal read、hyper_market indicators（交易周期 + 高周期各一次）与 candles；旧图上价位不能替代当前结构。',
    '2. 判市：先用一句话定当前市场状态（趋势/区间、方向闸、关键结构位变化、动量与量能、资金费），再逐条核对候选策略的触发与作废条件。',
    '3. 调整：条件失效、方向翻转或价位漂移 → 只撤归属可确认的本策略挂单，更新本策略 plan 与图上关键位/提醒（alert=true）；有可核对新信号 → 修订策略条目（写明 why）。',
    '4. 执行：本会话必须至少持有一笔归属自己的仓位，其他会话的持仓不算；若本会话空仓，以最小可行风险尽快入场，不能只留下远价挂单。自动开仓必须带 stopLossPx；提交后核对本会话成交与实际止损挂单，保护未生效先处理裸露仓位。遇到数据、限额、保证金或反向仓位冲突要报告具体阻断。',
    '5. 汇报：有动作或状态变化才说话（两三句）；无变化不汇报。',
    '红线：提现不可做，自动开仓必须带止损；数据过期不决策。',
  ].join('\n')
}
