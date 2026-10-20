/**
 * Track who started the current turn (bookkeeping + persisted origin store), and gate money tools by
 * the owner's mandate (2026-10-20): the agent holds every trading permission except withdrawal —
 * automatic rounds (closed-bar, price alert, schedule) and human rounds are equal; naked opens,
 * leverage changes, limit changes and transfers all pass, on testnet and mainnet alike, subject to
 * the configured risk limits and the custody mode's own approval flow. The tool surface has no
 * withdrawal at all; the explicit check below keeps it that way even if one is ever added.
 */

const isPluginEvent = (source) => source?.kind === 'plugin:dsh-hyperliquid' && ['event', 'market-bar'].includes(source.form)
const isAutomatic = (source) => isPluginEvent(source) || source?.kind === 'schedule'
const sessionIdOf = (session) => session?.id ?? null

/**
 * @param ctx - host context (`session/event`).
 * @param options.origin - persisted `{ get(sessionId): boolean | undefined, set(sessionId, alert: boolean) }`.
 * @param options.canAutoTrade - `(sessionId) => boolean`; when false, automatic rounds keep the
 *   degraded allowance (stop-carrying opens, reduce-only, cancels) instead of the full mandate.
 */
export function createTurnOriginGuard(ctx, { origin = { get: () => undefined, set: () => {} }, canAutoTrade = () => false } = {}) {
  const turns = new WeakMap()
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') turns.set(session, { automatic: false, human: false, form: null })
    if (event.type !== 'user/message') return
    const source = event.data?.source
    if (isAutomatic(source)) {
      turns.set(session, { automatic: true, human: false, form: source.form ?? source.kind })
      if (sessionIdOf(session)) origin.set(sessionIdOf(session), true)
    } else if (source?.kind === 'user') {
      // A human instruction makes this a trusted turn — even mid-auto-round — and retires the
      // persisted alert origin.
      turns.set(session, { automatic: false, human: true, form: null })
      if (sessionIdOf(session)) origin.set(sessionIdOf(session), false)
    }
  })
  return (tool, args, exec) => {
    const money = tool === 'hyper_order' || tool === 'hyper_decide' || (tool === 'hyper_account' && ['limits', 'transfer', 'withdraw'].includes(args?.action))
    if (!money) return
    if (tool === 'hyper_account' && args?.action === 'withdraw') {
      throw new Error('提现不在交易台权限内：插件不实现出金，请在 Hyperliquid 网页操作')
    }
    const turn = turns.get(exec?.agent?.session)
    if (!turn?.automatic) return
    // Automatic round: full mandate when the switch is on; degraded allowance otherwise.
    const sessionId = sessionIdOf(exec?.agent?.session)
    if (canAutoTrade(sessionId)) return
    const orderAction = tool === 'hyper_order' && args?.action === 'place'
    const decision = tool === 'hyper_decide'
    const cancelAction = tool === 'hyper_order' && args?.action === 'cancel'
    const mayOpen = (decision || orderAction) && (args?.reduceOnly === true || Number(args?.stopLossPx) > 0)
    if (mayOpen || cancelAction) return
    throw new Error('交易台自动通知不能授权下单、改限额或划转；开启自主交易开关（agentAutoTradeTestnet）后自动轮可执行除提现外的全部交易操作')
  }
}
