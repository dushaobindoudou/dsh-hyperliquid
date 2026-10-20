/**
 * dsh-hyperliquid — the always-on system-prompt section. Weak models do not read a long skill, so the
 * few behaviours that matter most live here: a short fixed core (intent → tool, execution rules, one
 * trade-card template) plus state the code computes — first meeting, an unprotected live position,
 * a losing streak — so the right instruction appears exactly when it applies.
 * Budget (codex review): whole section ≲ 1200 tokens, dynamic part ≲ 300.
 * @module lib/prompt
 */

import { journalPromptLines } from './journal.js'

const DYNAMIC_CHARS = 700

/** Profile labels that matter before proposing a trade (matched loosely: the agent names the fields). */
const ESSENTIALS = [['风险', '单笔风险%'], ['市场', '常做市场'], ['周期', '持仓周期']]

/** Live positions without a reduce-only stop that covers their size (position TP/SL counts as full cover). */
export function unprotectedPositions(account) {
  if (!account || account.mode !== 'live') return []
  const orders = account.openOrders ?? []
  return (account.positions ?? []).filter((position) => Math.abs(Number(position.size)) > 0).filter((position) => {
    const closingSide = position.size > 0 ? 'A' : 'B'
    const stops = orders.filter((order) => order.coin === position.coin && order.isTrigger && (order.reduceOnly || order.isPositionTpsl)
      && /stop/i.test(String(order.orderType ?? '')) && (order.side == null || order.side === closingSide))
    if (stops.some((order) => order.isPositionTpsl)) return false
    const covered = stops.reduce((sum, order) => sum + Math.abs(Number(order.sz ?? order.origSz ?? 0)), 0)
    return covered < Math.abs(Number(position.size)) * 0.99
  }).map((position) => position.coin)
}

/** Trailing run of losing closed trades in the journal for this mode/network. */
export function losingStreak(journal, { mode, network }) {
  let streak = 0
  for (const entry of [...(journal?.entries ?? [])].reverse()) {
    if (entry.type !== 'trade' || !Number.isFinite(entry.resultR)) continue
    if (entry.mode && entry.mode !== mode) continue
    if (entry.network && entry.network !== network) continue
    if (entry.resultR < 0) streak += 1
    else break
  }
  return streak
}

/**
 * Whether one session is a trading session this desk registered.
 * @param {{ store }} remote - the desk Remote.
 * @param {string} sessionId - candidate session.
 * @returns {boolean} true only for sessions the desk created and registered.
 */
export function isDeskSession(remote, sessionId) {
  if (!sessionId) return false
  try {
    return Boolean(remote?.store?.sessions?.sessions?.[sessionId])
  } catch {
    return false
  }
}

/**
 * The section text for one agent scope: empty outside desk sessions, so the
 * trading persona never leaks into an unrelated conversation.
 * @param {{ cfg, isManaged: () => boolean, store, desk, lastLiveAccount }} remote
 * @param {string} sessionId - the session whose agent owns the scoped section.
 * @param {{ skillLoaded?: boolean, now?: number }} options - pass-through to deskPrompt.
 * @returns {string} the section text (possibly empty).
 */
export function deskPromptFor(remote, sessionId, options = {}) {
  return isDeskSession(remote, sessionId) ? deskPrompt(remote, options) : ''
}

/**
 * @param {{ cfg, isManaged: () => boolean, store, desk, lastLiveAccount }} remote
 * @returns {string} the section text
 */
export function deskPrompt(remote, { skillLoaded = true, now = Date.now() } = {}) {
  const { tradingMode: mode, network } = remote.cfg
  const core = [
    '## Hyperliquid 交易台（dsh-hyperliquid）',
    `你是用户的交易副手（mode=${mode}，network=${network}）：在风控之内帮他赚钱。所有价格、仓位都来自本次工具调用；不承诺收益，没有好机会就说“观望”并说明在等什么。`,
    '用户只是寒暄、闲聊或问与交易无关的事（你好、谢谢、写代码、查资料等）：直接回答，不要调用 hyper_* 工具，也不要读盘口/行情/账户——只有涉及交易、行情、账户、策略或贴图时才取数。',
    '工具只有这 8 个（没有其它 hyper_* 工具）：hyper_context 会话上下文、hyper_market 行情、hyper_chart 画线/均线/指标、hyper_account 账户、hyper_decide 实盘预检、hyper_order 下单/撤单/杠杆、hyper_session 会话币对、hyper_journal 档案/策略/复盘日志。',
    '常见请求怎么做：“我做得怎么样”→ hyper_account action=analyze；“今天有什么机会”→ hyper_market action=scan，挑 1 个核实后画给用户；“帮我盯着”→ hyper_chart 在关键价位设 alert=true，需要定期检查再用 schedule_create（先征得一次同意）；用户贴图 → read_image，再用 hyper_market candles 找到真实高低点，用 hyper_chart 复原；均线用 hyper_chart kind=ma，RSI/MACD 用 hyper_chart action=view。不要自己手算指标或从成交里手算盈亏。',
    '执行：paper 用 hyper_order；live 先 hyper_decide 再用返回的 decisionId 调 hyper_order，提交后用 hyper_account orderStatus/orders 对账。止盈止损分组单目前只在 testnet；主网没有确认存在的止损单就不能说“已设止损”。只读工具报错可换参数重试一次。下单、撤单、划转等写入失败或结果未知时，先查状态对账；未确认前不得再次提交。',
    '交易计划用这张卡（一次说完，不连发问题）：\n【交易卡】BTC 做多 · 策略[id 或 idea]\n入场 82,100（限价）｜止损 81,300（结构下方 + 0.5 ATR）｜目标 84,500｜R:R 3.0\n数量 0.012（风险 1% = 96 USD）｜作废：4h 收盘跌破 81,000\n依据：…｜反证：…｜需要你：…（没有就不写）',
    '收到以“[交易台事件]”或“[交易台市场检查]”开头的消息时，它是交易台自动触发的盯盘轮，不是用户的话：按消息里的闭环自主处理——自主交易开关开启时可执行除提现外的全部交易操作（开仓、撤单、杠杆、限额、划转）并简短汇报；未开启时只复核并简短告诉用户。',
    remote.isManaged()
      ? '托管=全托管：符合策略、在限额内可直接执行，事后一句话汇报；需要时可用 hyper_account action=limits / transfer（transfer 可在现货、主永续与 HIP-3 交易所之间划转 USDC），每次说明改了什么、为什么。'
      : '托管=半托管：实盘下单、撤单、改杠杆、划转都要用户批准；允许币对与限额由用户在 设置 → 交易限额与签名规则 修改（或切到全托管后由你调整）。',
  ]

  // ── state the code knows; each line appears only when it applies ──
  const dynamic = []
  const cached = remote.lastLiveAccount
  if (cached && cached.network === network && mode === 'live' && now - cached.at < 120_000) {
    const naked = unprotectedPositions(cached.value)
    if (naked.length) dynamic.push(`⚠ 最高优先：实盘持仓 ${naked.join('、')} 没有足量的止损挂单。先提醒用户这一风险并给出止损价（主网需用户在 Hyperliquid 网页挂止损，或由你设价格提醒）。`)
  }
  let journal = null
  try { journal = remote.store.journal() } catch { /* journal is best-effort */ }
  const profile = journal?.profile ?? {}
  const keys = Object.keys(profile)
  const missing = ESSENTIALS.filter(([needle]) => !keys.some((key) => key.includes(needle))).map(([, label]) => label)
  if (!keys.length && !(journal?.strategies?.length)) {
    dynamic.push('【第一次见面】先交付价值再提问：live 且有历史成交 → 先 hyper_account action=analyze，挑 1–2 个最值钱的发现讲给用户；没有历史或 paper → hyper_market action=scan 给 1 个今天的机会，画在图上。最后用一句话问缺的偏好（单笔风险%、常做市场、持仓周期），答案写入 hyper_journal profile。')
  } else if (missing.length) {
    dynamic.push(`档案还缺：${missing.join('、')}。用户谈到具体交易时顺带问一次，不要单独打扰。`)
  }
  const streak = losingStreak(journal, { mode, network })
  if (streak >= 3) dynamic.push(`连续亏损 ${streak} 笔：先复核策略条件和执行偏差，建议用户暂停开新仓一段时间；不要主动推荐新交易，用户坚持时减半风险。`)
  try { dynamic.push(...journalPromptLines(journal ?? { profile: {}, strategies: [], entries: [] })) } catch { /* best effort */ }
  try { if (remote.desk?.coin) dynamic.push(`交易台焦点：${remote.desk.coin} · ${remote.desk.interval ?? '15m'}（用户说“这个币/图上”指它）。`) } catch { /* best effort */ }
  let budget = DYNAMIC_CHARS
  const kept = []
  for (const line of dynamic) {
    if (line.length > budget) { if (budget > 80) kept.push(line.slice(0, budget - 1) + '…'); break }
    kept.push(line); budget -= line.length
  }
  if (skillLoaded) kept.push('复杂分析、策略迭代或复盘时加载 hyperliquid-trading skill。')
  return [...core, ...kept].join('\n')
}
