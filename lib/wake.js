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
    '2. 判市：对照 hyper_journal 里与这条线相关的计划与策略条件，判断是触发、作废还是仅观察；盘中穿线不等于收盘确认。',
    '3. 执行：条件成立 → hyper_decide + hyper_order，开仓必须带 stopLossPx；减仓不必先撤保护单；要移止损/补止损用 hyper_order action=protect；计划失效或方向翻转 → 只撤本策略挂单；完成后核对成交和实际止损挂单。',
    '4. 汇报：两三句话讲清发生了什么、做了什么；与计划无关时一句话即可。不调用 ask_user_question 等需要用户回答的工具。',
    '红线：提现不可做，自动开仓必须带止损；其余授权操作仍受交易限额与档案纪律约束。',
  ].join('\n')
}

/** One closed-candle decision opportunity, never a claim that a trade signal exists. */
export function marketBarWakeText(events) {
  const lines = events.map((event) => {
    const c = event.candle
    return `- ${event.coin} ${event.interval ?? '15m'} 已收盘 K 线 ${new Date(c.t).toISOString()}：O ${c.o} / H ${c.h} / L ${c.l} / C ${c.c} / V ${c.v}；候选策略 ${event.strategyIds.join(', ') || '无'}`
  })
  // Merged events of one session share a coin; the newest snapshot describes the market now.
  const digest = [...events].reverse().find((event) => Array.isArray(event.digest) && event.digest.length)?.digest
  return [
    '[交易台盯盘] 本会话已开启盯盘（含自主交易），盯盘周期已收盘，无需等用户，执行一轮：',
    ...lines,
    ...(digest ? ['交易台快照（本轮刚读取，已收盘 K 线；需要盘口、成交或更细数据再取）：', ...digest.map((line) => `  ${line}`)]
      : ['（快照未取到：自己读 hyper_account state/orders 与本周期 + 两个更高周期的 indicators。）']),
    '1. 判市：先大后小。用快照一句话定状态：大周期方向、本周期结构、动量与量能。本周期信号与大周期方向相反时，不按本周期单独开仓；大周期已转向就跟着换方向或空仓等待，不在原方向反复接。',
    '2. 保护：快照里有 ⚠ 先处理——用 hyper_order action=protect 补足止损，再做别的。浮盈扩大或结构上移时也用 protect 移止损（只往有利方向挪），不要“全平再重建”。',
    '3. 调整：计划失效、方向翻转或价位漂移 → 只撤归属可确认的本策略挂单，更新 plan 与图上关键位/提醒（alert=true）；图上的头寸框必须和真实挂单一致。只有可核对的新信号才修订策略（写明 why）。',
    '4. 入场：本会话应持有一笔归属自己的仓位，但“在场”不是入场理由。刚被止损或止盈离场后，至少等下一根盯盘周期收盘、按大周期重新判断方向（可以反向）再进；同方向重进必须有新的结构信号。不急的入场优先贴近现价的 Alo 限价单（挂单费约为吃单的 1/3），预期收益要明显覆盖往返手续费。自动开仓必须带 stopLossPx，提交后核对成交与实际止损挂单。',
    '5. 阻断：同一个错误不要每轮重试；先用 protect 保住仓位，再在汇报第一行写清阻断原因和需要谁处理。',
    '6. 汇报：有动作说两三句；无动作只回一行（结构 + 动作）。不调用 ask_user_question 等需要用户回答的工具，自主判断、事后汇报。同时收到多条盯盘消息时只按最新一根处理。',
    '红线：提现不可做，自动开仓必须带止损；数据过期不决策。',
  ].join('\n')
}
