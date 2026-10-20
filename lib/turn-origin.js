/**
 * Track who started the current turn (bookkeeping + persisted origin store), and gate money tools by
 * the owner's mandate (2026-10-20): automatic rounds (closed-bar, price alert, schedule) may
 * open only with a stop loss when autonomy is enabled; leverage changes, limit changes and
 * transfers pass on testnet and mainnet alike, subject to
 * the configured risk limits and the custody mode's own approval flow. The tool surface has no
 * withdrawal at all; the explicit check below keeps it that way even if one is ever added.
 */

const isPluginEvent = (source) => source?.kind === 'plugin:dsh-hyperliquid' && ['event', 'market-bar'].includes(source.form)
const isAutomatic = (source) => isPluginEvent(source) || source?.kind === 'schedule'
const sessionIdOf = (session) => session?.id ?? null

/**
 * @param ctx - host context (`session/event`).
 * @param options.origin - persisted `{ get(sessionId): boolean | undefined, set(sessionId, alert: boolean) }`.
 * @param options.isLive - `() => boolean`; live agent opens require a stop even in human turns.
 * @param options.canAutoTrade - `(sessionId) => boolean`; when false, automatic rounds may only
 *   reduce risk or cancel orders.
 */
export function createTurnOriginGuard(ctx, { origin = { get: () => undefined, set: () => {} }, canAutoTrade = () => false, isLive = () => false } = {}) {
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
    const opening = tool === 'hyper_decide' || (tool === 'hyper_order' && args?.action === 'place')
    if (isLive() && opening && args?.reduceOnly !== true && !(Number(args?.stopLossPx) > 0)) {
      throw new Error('实盘开仓必须带有效 stopLossPx；不能以价格提醒代替止损单')
    }
    const turn = turns.get(exec?.agent?.session)
    const sessionId = sessionIdOf(exec?.agent?.session)
    if (!(turn?.automatic || (turn == null && sessionId && origin.get(sessionId) === true))) return
    // Automatic round: stop-carrying opens when the switch is on; risk reduction otherwise.
    if (canAutoTrade(sessionId)) {
      if (opening && args?.reduceOnly !== true && !(Number(args?.stopLossPx) > 0)) {
        throw new Error('自主交易自动轮开仓必须带有效 stopLossPx；不能以价格提醒代替止损单')
      }
      return
    }
    const orderAction = tool === 'hyper_order' && args?.action === 'place'
    const decision = tool === 'hyper_decide'
    const cancelAction = tool === 'hyper_order' && args?.action === 'cancel'
    const mayOpen = (decision || orderAction) && args?.reduceOnly === true
    if (mayOpen || cancelAction) return
    throw new Error('交易台自动通知当前只允许减仓或撤单；开启自主交易开关（agentAutoTradeTestnet）后可带止损开仓及执行其他授权操作')
  }
}
