/** The trading desk hosts DSH's native Conversation body for the selected Session. */

import * as React from 'react'
import { getContext, t, tr } from '../remote'
import { notify, setActiveRef, store, useStore } from '../store'
import { queueToAgent } from '../data'
import { chartReferenceChipsReady } from '../dsh-extensions'
import { CHART_REFERENCE_SOURCE, encodeChartReference } from '../chart-reference'
import { TradeTicket } from './trade-ticket'
import type { RetainedSession } from '../types'
import { FoldIcon } from './panel-icons'
import { readNativeSessionList } from '../native-session-list'

interface ConversationKit {
  SessionProvider?: React.ComponentType<{ session: RetainedSession; children: React.ReactNode }>
  renderFactorySlot?: (name: string, props?: Record<string, unknown>, options?: Record<string, unknown>) => React.ReactNode
}

/** Keep the embedded occurrence on Chat even if the main Conversation shows another View. */
function FixedChatView({ renderSlot }: { renderSlot: (name: string, props?: Record<string, unknown>) => React.ReactNode }) {
  return <>{renderSlot('conversation.session', { view: 'chat' })}</>
}

export function ChatColumn({ width, fill = false, onCollapse, SessionProvider, renderFactorySlot }: { width?: number; fill?: boolean; onCollapse: () => void } & ConversationKit) {
  const s = useStore()
  const activeId = s.activeSessionId
  const nativeKnown = Boolean(activeId && s.nativeSessionIds.includes(activeId))
  const [bindError, setBindError] = React.useState<string | null>(null)
  const [ref, setRef] = React.useState<RetainedSession | null>(null)
  const [legacy, setLegacy] = React.useState(false)
  const [showTicket, setShowTicket] = React.useState(false)

  // Clicking a book price is an explicit request to edit a limit-order intent.
  React.useEffect(() => {
    if (s.ticketDraft) setShowTicket(true)
  }, [s.ticketDraft?.at])
  React.useEffect(() => { setShowTicket(false) }, [s.activeSessionId])

  React.useEffect(() => {
    setActiveRef(null)
    setRef(null)
    setLegacy(false)
    setBindError(null)
    if (!activeId) return undefined
    let cancelled = false
    let retained: RetainedSession | null = null
    const setup = async () => {
      try {
        const sessionsSvc = getContext()?.get('sessions')
        if (!sessionsSvc) throw new Error(tr('sessions 服务不可用', 'DSH sessions service unavailable'))
        // On reload the plugin registry may arrive before DSH has hydrated
        // its native session list. Retain only after that session is known;
        // otherwise retain() rejects and the chat never retries.
        const nativeList = readNativeSessionList(sessionsSvc.list)
        if (nativeList && !nativeList.byId?.[activeId]) {
          if (nativeList.phase === 'ready') throw new Error(tr('该交易会话已不在 DSH 会话列表中', 'This trading session no longer exists in DSH'))
          return
        }
        if (typeof sessionsSvc.retain !== 'function') {
          // DSH 0.1.x owns one selected Session; open() only changes that
          // selection. The main-panel choice remains on this trading desk.
          sessionsSvc.open(activeId)
          const binding = sessionsSvc.binding?.(activeId)
          if (binding) setActiveRef({ binding })
          if (!cancelled) setLegacy(true)
          return
        }
        retained = sessionsSvc.retain(activeId, { source: 'dsh-hyperliquid.desk' }) as RetainedSession
        await retained.ready
        if (cancelled) { try { retained.release?.() } catch { /* gone */ } return }
        setActiveRef(retained)
        setRef(retained)
      } catch (e) {
        if (!cancelled) setBindError(String((e as Error)?.message ?? e))
      }
    }
    void setup()
    return () => {
      cancelled = true
      setActiveRef(null)
      try { retained?.release?.() } catch { /* already gone */ }
    }
  }, [activeId, nativeKnown, s.nativeSessionsReady])

  const title = React.useMemo(() => {
    if (!activeId) return ''
    const row = readNativeSessionList(getContext()?.get('sessions')?.list)?.byId?.[activeId]
    return s.sessionTitles?.[activeId] ?? row?.displayTitle ?? s.sessions.find((r) => r.sessionId === activeId)?.title ?? t('session.defaultTitle', 'Hyperliquid 交易会话')
  }, [activeId, s.sessions, s.sessionTitles, s.localeRevision])
  const readyRef = ref?.sessionId === activeId ? ref : null
  const pendingQuotes = s.chartReferences.filter((item) => item.sessionId === activeId)

  React.useEffect(() => {
    if (pendingQuotes.length && showTicket) setShowTicket(false)
  }, [pendingQuotes.length, showTicket])
  React.useEffect(() => {
    if (!pendingQuotes.length || !readyRef || showTicket) return
    const sessionCtx = readyRef.binding?.ctx
    const input = sessionCtx ? getContext()?.get('conversation')?.input?.for?.(sessionCtx) : null
    const actions = input?.actions
    if (!actions?.captureInsertion || !actions?.insertText || !input?.state?.getSnapshot) {
      notify(tr('当前 DSH 输入框无法接收图表引用', 'This DSH composer cannot accept chart quotes'))
      store.patch((current) => ({ chartReferences: current.chartReferences.filter((item) => item.sessionId !== activeId) }))
      return
    }
    const inserted: number[] = []
    const chips = chartReferenceChipsReady() && typeof input.insertReference === 'function'
    for (const quote of pendingQuotes) {
      const draft = String(input.state.getSnapshot().draft ?? '')
      // Collapse a selected range so citing a chart point never deletes the
      // trader's existing words or structured reference chips.
      const captured = actions.captureInsertion()
      const span = { ...captured, start: captured.end }
      // A chip shows a short label; the full point text reaches the model on send.
      const ok = chips
        ? input.insertReference({ source: CHART_REFERENCE_SOURCE, label: quote.label, clipboardText: quote.text,
          ref: encodeChartReference({ coin: quote.coin, interval: quote.interval, t: quote.t, text: quote.text }) }, span)
        : actions.insertText(`${draft ? '\n\n' : ''}${quote.text}`, span)
      if (!ok) break
      inserted.push(quote.id)
    }
    if (inserted.length) {
      store.patch((current) => ({ chartReferences: current.chartReferences.filter((item) => !inserted.includes(item.id)) }))
      requestAnimationFrame(() => input.focus?.())
    }
  }, [activeId, readyRef, showTicket, s.chartReferences])

  // Quick prompts name the exact tools, so even a weak model takes the intended path.
  const QUICK: Array<[string, string, string, string]> = [
    ['交易体检', 'Trading check-up',
      '请用 hyper_account action=analyze 给我做一次交易体检（近 90 天）：先讲最值钱的 1–2 个发现和建议规则，再问我是否采用。不要下单。',
      'Run a trading check-up with hyper_account action=analyze (last 90 days): lead with the 1–2 most valuable findings and suggested rules, then ask whether I want to adopt them. Do not trade.'],
    ['今天有什么机会', "Today's opportunities",
      '请用 hyper_market action=scan 看看今天的机会，结合我的档案挑 1 个最值得关注的，用 hyper_market candles/indicators 核实，再用 hyper_chart 画出关键位和头寸框，按交易卡格式给出计划。不要下单。',
      'Use hyper_market action=scan for today\'s opportunities, pick the one that best fits my profile, verify it with hyper_market candles/indicators, draw the levels and a position box with hyper_chart, and give the plan as a trade card. Do not trade.'],
    ['帮我盯着仓位', 'Watch my positions',
      '请用 hyper_context 检查我的仓位和挂单：每个仓位是否有足量止损、离止损和目标多远、资金费成本；在关键价位用 hyper_chart 设价格提醒（alert=true）；需要定期检查的话先问我一次，再用 schedule_create 安排。不要下单或撤单。',
      'Use hyper_context to check my positions and orders: is each one covered by a stop, how far are stop and target, what does funding cost; set price alerts (alert=true) at key levels with hyper_chart; if periodic checks would help, ask me once, then use schedule_create. Do not place or cancel orders.'],
    ['把图上画线变成策略', 'Turn my drawings into a strategy',
      `请用 hyper_chart action=list 读取 ${s.activeCoin} 图上的画线，结合 hyper_market candles 理解我的思路，整理成一条可核对的策略（依据、入场、离场、作废、仓位），用 hyper_journal action=strategy 存为 idea，并说明还需要验证什么。不要下单。`,
      `Read my drawings on ${s.activeCoin} with hyper_chart action=list, use hyper_market candles to understand the idea, write it up as a checkable strategy (thesis, entry, exit, invalidation, sizing), save it with hyper_journal action=strategy as an idea, and say what still needs verifying. Do not trade.`],
  ]

  const content = !activeId
    ? <div className="dhl-empty">{t('chat.noSession', '选择左侧交易会话，在这里直接与交易 agent 对话。')}</div>
    : bindError
      ? <div className="dhl-inline-error" role="alert">{t('chat.bindError', '会话绑定失败：') + bindError}</div>
      : legacy
        ? <div className="dhl-chat-unavailable" role="alert">{t('chat.upgrade', '当前 DSH 版本不支持嵌入原生会话；请使用 DSH 0.2 或更新版本。')}</div>
      : !readyRef
        ? <div className="dhl-empty">{t('chat.linking', '正在接入会话…')}</div>
        : !SessionProvider || !renderFactorySlot
          ? <div className="dhl-inline-error" role="alert">{t('chat.noFactory', 'DSH 原生会话组件不可用。')}</div>
          : <div className="dhl-chatmount" data-trading-session={activeId}>
              <SessionProvider session={readyRef}>
                {renderFactorySlot('conversation.content', { variant: 'embedded', phase: 'active', hero: false }, { slots: { views: FixedChatView } })}
              </SessionProvider>
            </div>

  return (
    <div id="dhl-panel-chat" className="dhl-col-chat" style={fill ? { flex: '1 1 0', width: 'auto' } : width ? { width } : undefined}>
      <div className="dhl-chat-header">
        <div className="dhl-chat-heading">
          <strong>{t('chat.title', '交易会话')}</strong>
          {activeId ? <span title={title}>{title}</span> : null}
        </div>
        <button type="button" className="dhl-chat-ticket-toggle" aria-expanded={showTicket} onClick={() => setShowTicket((value) => !value)}>
          {showTicket ? t('chat.back', '返回会话') : t('chat.ticket', '交易票据')}
        </button>
        <button className="dhl-panel-iconbtn" type="button" onClick={onCollapse} aria-label={tr('收起对话栏', 'Collapse chat')} title={tr('收起对话栏', 'Collapse chat')}><FoldIcon direction="right" /></button>
      </div>
      {activeId && !showTicket && !legacy ? <div className="dhl-chat-prompts" role="group" aria-label={t('chat.prompts', '快捷提问')}>
        {QUICK.map(([zh, en, askZh, askEn]) => <button key={zh} type="button" onClick={() => queueToAgent(tr(askZh, askEn))}>{tr(zh, en)}</button>)}
      </div> : null}
      {showTicket ? <TradeTicket key={activeId ?? 'anonymous'} onSubmitted={() => setShowTicket(false)} /> : content}
    </div>
  )
}
