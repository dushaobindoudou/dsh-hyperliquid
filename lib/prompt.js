/**
 * dsh-hyperliquid — the always-on system-prompt section. Weak models do not read a long skill, so the
 * few behaviours that matter most live here: a short fixed core (intent → tool, execution rules, one
 * trade-card template) plus state the code computes — first meeting, an unprotected live position,
 * a losing streak — so the right instruction appears exactly when it applies.
 * Budget (codex review): whole section ≲ 1200 tokens, dynamic part ≲ 300.
 * @module lib/prompt
 */

import { journalPromptLines } from './journal.js'
import { sessionWatch } from './strategy-monitor.js'

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
/** The session's live 盯盘 state; the user can flip it on the desk between turns, so this line is the truth. */
function watchLine(remote, sessionId) {
  const row = remote.store.getSession(sessionId)
  if (row?.watch !== true) return '本会话盯盘：已关闭（以此为准，对话里更早的盯盘状态可能已过期）。不会被自动唤醒，自动轮只能减仓或撤单；用户要盯盘时用 hyper_session action=watch on=true 开启。'
  let interval = '15m'
  try { interval = sessionWatch(remote.store, row).watchInterval } catch { /* default interval */ }
  return `本会话盯盘：已开启（${row.coin} ${interval}，以此为准，对话里更早的盯盘状态可能已过期）。每根 K 线收盘自动唤醒并自主交易；用户要停就用 hyper_session action=watch on=false。`
}

export function deskPromptFor(remote, sessionId, options = {}) {
  return isDeskSession(remote, sessionId) ? deskPrompt(remote, { ...options, sessionId }) : ''
}

/**
 * @param {{ cfg, isManaged: () => boolean, store, desk, lastLiveAccount }} remote
 * @returns {string} the section text
 */
export function deskPrompt(remote, { skillLoaded = true, now = Date.now(), sessionId } = {}) {
  const { tradingMode: mode, network } = remote.cfg
  const core = [
    '## Hyperliquid 交易台（dsh-hyperliquid）',
    `你是用户的交易副手（mode=${mode}，network=${network}）：在风控之内帮他赚钱。价格、仓位只取本轮工具数据；不承诺收益。“观望”表示暂不加码或方向未明；若档案要求始终持仓，空仓时须尽快按最小可行风险重建，不能用远价挂单代替入场。`,
    '用户只是寒暄、闲聊或问与交易无关的事（你好、谢谢、写代码、查资料等）：直接回答，不要调用 hyper_* 工具，也不要读盘口/行情/账户——只有涉及交易、行情、账户、策略或贴图时才取数。',
    '工具只有这 8 个（没有其它 hyper_* 工具）：hyper_context 会话上下文、hyper_market 行情、hyper_chart 画线/均线/指标、hyper_account 账户、hyper_decide 实盘预检、hyper_order 下单/撤单/杠杆、hyper_session 会话币对、hyper_journal 档案/策略/复盘日志。',
    '常见请求怎么做：“我做得怎么样”→ hyper_account action=analyze；“今天有什么机会”→ hyper_market action=scan，挑 1 个核实后画给用户；“帮我盯着”→ hyper_chart 在关键价位设 alert=true，用户要你持续盯盘/自动交易时用 hyper_session action=watch on=true 开启本会话「盯盘」（盯盘即自主交易，周期按策略入场周期自适应；只能在用户发话的这一轮开启，自动轮不能自己开），用户要停就 on=false；不要用 schedule_create 自建盯盘定时任务；用户贴图 → read_image，再用 hyper_market candles 找到真实高低点，用 hyper_chart 复原；均线用 hyper_chart kind=ma，RSI/MACD 用 hyper_chart action=view。不要自己手算指标或从成交里手算盈亏。',
    '执行：paper 用 hyper_order；live 先 hyper_decide 再用 decisionId 调 hyper_order。所有实盘开仓必须带 stopLossPx；主网和测试网均提交分组保护单，随后核对实际成交与止损挂单。部分成交或保护单未生效时先处理裸露仓位；未确认有止损单不能说“已设止损”。写入结果未知时先对账，不得直接重交。',
    '交易计划用这张卡（一次说完，不连发问题）：\n【交易卡】BTC 做多 · 策略[id 或 idea]\n入场 82,100（限价）｜止损 81,300（结构下方 + 0.5 ATR）｜目标 84,500｜R:R 3.0\n数量 0.012（风险 1% = 96 USD）｜作废：4h 收盘跌破 81,000\n依据：…｜反证：…｜需要你：…（没有就不写）',
    '收到以“[交易台事件]”或“[交易台盯盘]”开头的消息时，它是本会话开启盯盘后交易台自动触发的盯盘轮，不是用户的话：按消息里的闭环自主处理，可执行除提现外的全部交易操作（开仓、撤单、杠杆、限额、划转）并简短汇报。',
    remote.isManaged()
      ? '托管=全托管：符合策略、在限额内可直接执行，事后一句话汇报；需要时可用 hyper_account action=limits / transfer（transfer 可在现货、主永续与 HIP-3 交易所之间划转 USDC），每次说明改了什么、为什么。'
      : '托管=半托管：实盘下单、撤单、改杠杆、划转都要用户批准；允许币对与限额由用户在 设置 → 交易限额与签名规则 修改（或切到全托管后由你调整）。',
  ]
  if (sessionId) core.push(watchLine(remote, sessionId))
  if (sessionId) core.push(`会话纪律：本会话必须至少持有一个归属自己的仓位，别的会话持仓不算；平仓后立即重建带止损的新仓，远价挂单不算入场。策略与战绩默认隔离；全局共享仅共用规则与档案，画线、订单和成交仍属于本会话，不能动其他会话的订单。暂停状态、数据失效、限额或方向冲突必须明确报告。`)

  // ── state the code knows; each line appears only when it applies ──
  const dynamic = []
  const cached = remote.lastLiveAccount
  if (cached && cached.network === network && mode === 'live' && now - cached.at < 120_000) {
    const naked = unprotectedPositions(cached.value)
    if (naked.length) dynamic.push(`⚠ 最高优先：实盘持仓 ${naked.join('、')} 没有足量的止损挂单。核对订单后先处理裸露仓位；当前工具不能给已有仓位补挂止损，必要时减仓/平仓或请用户在网页挂止损。价格提醒不能代替止损。`)
  }
  let journal = null
  try { journal = remote.store.journal(sessionId) } catch { /* journal is best-effort */ }
  if (sessionId && journal) journal = { ...journal, entries: journal.entries.filter((entry) => entry.sessionId === sessionId) }
  const profile = journal?.profile ?? {}
  const keys = Object.keys(profile)
  const missing = ESSENTIALS.filter(([needle]) => !keys.some((key) => key.includes(needle))).map(([, label]) => label)
  if (!keys.length && !(journal?.strategies?.length)) {
    dynamic.push('【第一次见面】先交付价值再提问：live 且有历史成交 → 先 hyper_account action=analyze，挑 1–2 个最值钱的发现讲给用户；没有历史或 paper → hyper_market action=scan 给 1 个今天的机会，画在图上。最后用一句话问缺的偏好（单笔风险%、常做市场、持仓周期），答案写入 hyper_journal profile。')
  } else if (missing.length) {
    dynamic.push(`档案还缺：${missing.join('、')}。用户谈到具体交易时顺带问一次，不要单独打扰。`)
  }
  const streak = losingStreak(journal, { mode, network })
  if (streak > 0) dynamic.push(`连续亏损 ${streak} 笔：核对档案的复核、暂停与仓位纪律，不自行套用固定笔数或减仓比例。`)
  try { dynamic.push(...journalPromptLines(journal ?? { profile: {}, strategies: [], entries: [] })) } catch { /* best effort */ }
  try {
    const row = sessionId ? remote.store.getSession(sessionId) : null
    const coin = row?.coin ?? remote.desk?.coin
    if (coin) dynamic.push(`本会话焦点：${coin}（用户说“这个币/图上”指它）。`)
  } catch { /* best effort */ }
  let budget = DYNAMIC_CHARS
  const kept = []
  for (const line of dynamic) {
    if (line.length > budget) { if (budget > 80) kept.push(line.slice(0, budget - 1) + '…'); break }
    kept.push(line); budget -= line.length
  }
  if (skillLoaded) kept.push('复杂分析、策略迭代或复盘时加载 hyperliquid-trading skill。')
  return [...core, ...kept].join('\n')
}
