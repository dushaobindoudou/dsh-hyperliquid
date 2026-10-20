/**
 * dsh-hyperliquid — extensions into DSH's own conversation surfaces.
 *
 *   inputTriggers source   chart quotes become composer reference chips; the
 *                          chip serializes to the full point text on send and
 *                          reopens the point on the chart when clicked
 *   tool.call.toolview     readable rows for every hyper_* tool call, built on
 *                          DSH's DisclosureRow so they look like native rows
 *   approval detail        an order card inside DSH's approval takeover for
 *                          hyper_* calls; every other tool keeps the default
 * @module src/client/dsh-extensions
 */

import * as React from 'react'
import { DisclosureRow } from '@deepseek-ai/dsh-client-ui-primitives'
import { hyperCall, tr } from './remote'
import { CHART_REFERENCE_SOURCE, decodeChartReference } from './chart-reference'
import { focusChartReference } from './data'
import { fmt } from './format'
import { HL_MARK_PATH } from './components/brand-mark'

const HYPER_TOOLS = ['hyper_context', 'hyper_market', 'hyper_chart', 'hyper_account', 'hyper_decide', 'hyper_order', 'hyper_session'] as const

let chartSourceReady = false
/** Whether quote chips can be serialized; otherwise quotes fall back to plain draft text. */
export function chartReferenceChipsReady(): boolean { return chartSourceReady }

export function registerDshExtensions(ctx: any, slots: any): void {
  // ── chart quote chips ──────────────────────────────────────────────
  const source = {
    trigger: '@', name: CHART_REFERENCE_SOURCE, order: 1000, showGroupTitle: false,
    // Chips are inserted from the chart, never picked from the @ menu.
    async candidates() { return [] },
    onPick() { return undefined },
    openReference(_session: unknown, reference: { ref: string }) {
      const ref = decodeChartReference(reference.ref)
      if (!ref) return false
      void focusChartReference(ref)
      return true
    },
    codec: {
      clipboardText: (ref: string) => decodeChartReference(ref)?.text ?? ref,
      serialize: (ref: string) => Promise.resolve(decodeChartReference(ref)?.text ?? ref),
    },
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['inputTriggers'], (sub: any) => {
      sub.effect(() => {
        const off = sub.get('inputTriggers').registerSource(source)
        chartSourceReady = true
        return () => { chartSourceReady = false; off() }
      }, 'dsh-hyperliquid: chart reference source')
    })
  }

  if (!slots) return
  // ── hyper_* tool rows ──────────────────────────────────────────────
  for (const key of HYPER_TOOLS) {
    ctx.effect(() => slots.inject('tool.call.toolview', () => slots.register(
      { name: 'tool.call.toolview', key, registrant: 'dsh-hyperliquid' }, HyperToolRow)), `dsh-hyperliquid: ${key} row`)
  }
  // ── approval detail (lower priority shadows the shipped one) ───────
  ctx.effect(() => slots.inject('conversation.approval.detail', () => slots.register(
    { name: 'conversation.approval.detail', priority: -1, registrant: 'dsh-hyperliquid' }, ApprovalDetail)), 'dsh-hyperliquid: approval detail')
}

/* ------------------------------------------------------------------ */

function parseArgs(raw: unknown): Record<string, any> {
  if (typeof raw !== 'string') return {}
  try { const value = JSON.parse(raw); return value && typeof value === 'object' ? value : {} } catch { return {} }
}

/** Agent-supplied prices verbatim, only grouped: 81200 → 81,200; 0.00123 stays 0.00123. */
function exact(value: unknown): string {
  const n = Number(value)
  return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 10 }) : '—'
}

function side(args: Record<string, any>): string {
  return args.isBuy === true ? tr('买入', 'Buy') : args.isBuy === false ? tr('卖出', 'Sell') : ''
}

function priceOf(args: Record<string, any>): string {
  return args.type === 'limit' && args.px != null ? `@ ${exact(args.px)}` : tr('市价', 'market')
}

/** Title and one-line summary for a hyper_* call, in the trader's words. */
export function describeHyperCall(name: string, args: Record<string, any>): { title: string; summary: string } {
  const coin = typeof args.coin === 'string' ? args.coin : ''
  switch (name) {
    case 'hyper_context': return { title: tr('读取交易上下文', 'Read trading context'), summary: tr('行情 · 盘口 · 账户 · 风险限额', 'market · book · account · limits') }
    case 'hyper_market': {
      const action = ({ overview: tr('市场概览', 'overview'), catalog: tr('搜索市场', 'catalog'), book: tr('盘口', 'order book'), candles: tr('K 线', 'candles'), indicators: tr('技术指标', 'indicators'), trades: tr('最近成交', 'trades') } as Record<string, string>)[args.action] ?? args.action ?? ''
      return { title: tr('查询行情', 'Market data'), summary: [action, coin, args.interval].filter(Boolean).join(' · ') }
    }
    case 'hyper_chart': {
      if (args.action === 'remove') return { title: tr('图表标注', 'Chart marks'), summary: tr('删除标注', 'remove mark') }
      if (args.action === 'list') return { title: tr('图表标注', 'Chart marks'), summary: [tr('列出标注', 'list marks'), coin].filter(Boolean).join(' · ') }
      const what = args.kind === 'trend' ? tr('趋势线', 'trend line') : `${tr('水平线', 'level')}${args.price != null ? ' ' + exact(args.price) : ''}`
      return { title: tr('图表标注', 'Chart marks'), summary: [args.label || what, coin].filter(Boolean).join(' · ') }
    }
    case 'hyper_account': {
      const action = ({ state: tr('权益与持仓', 'equity & positions'), orders: tr('挂单', 'open orders'), fills: tr('成交', 'fills'), orderStatus: tr('订单状态', 'order status') } as Record<string, string>)[args.action] ?? args.action ?? ''
      return { title: tr('查询账户', 'Account'), summary: [action, args.oid].filter(Boolean).join(' · ') }
    }
    case 'hyper_decide': return { title: tr('交易预检', 'Trade pre-check'), summary: [side(args), args.sz, coin, priceOf(args)].filter(Boolean).join(' ') }
    case 'hyper_order': {
      if (args.action === 'cancel') return { title: tr('撤单', 'Cancel order'), summary: [coin, args.oid != null ? `oid ${args.oid}` : ''].filter(Boolean).join(' · ') }
      if (args.action === 'leverage') return { title: tr('调整杠杆', 'Set leverage'), summary: [coin, args.leverage != null ? `${args.leverage}x` : '', args.marginMode].filter(Boolean).join(' · ') }
      return { title: tr('下单', 'Place order'), summary: [side(args), args.sz, coin, priceOf(args), args.reduceOnly ? tr('只减仓', 'reduce-only') : ''].filter(Boolean).join(' ') }
    }
    case 'hyper_session': return { title: tr('交易会话', 'Trading session'), summary: args.action === 'bind' ? [tr('切换币种', 'bind'), coin].filter(Boolean).join(' · ') : tr('读取焦点', 'status') }
    default: return { title: name, summary: '' }
  }
}

function resultText(block: any): string {
  return (block?.content ?? []).filter((item: any) => item?.type === 'text').map((item: any) => String(item.text ?? '')).join('\n').trim()
}

/** First line of the result, used as the settled verdict (e.g. "交易预检通过：…"). */
function verdictOf(text: string): string {
  const line = text.split('\n')[0] ?? ''
  return line.length > 72 ? line.slice(0, 71) + '…' : line
}

function Mark() {
  return <svg viewBox="0 0 200 200" width="14" height="14" aria-hidden="true"><path d={HL_MARK_PATH} fill="currentColor" /></svg>
}

/** One hyper_* call: title · summary while running, the result's verdict once settled. */
function HyperToolRow(props: any) {
  const { phase, block, toolName } = props
  const disclosure = props.useDisclosure()
  const args = parseArgs(phase === 'result' ? block?.call?.argsRaw : block?.argsRaw)
  const { title, summary } = describeHyperCall(toolName, args)
  const text = phase === 'result' ? resultText(block) : ''
  const failed = phase === 'result' && block?.isError === true
  const verdict = phase === 'result' ? verdictOf(text) : ''
  const heading = [title, summary].filter(Boolean).join(' · ')
  return (
    <DisclosureRow
      icon={<Mark />}
      title={heading}
      open={disclosure.expanded}
      expandable={phase === 'result' && text.length > 0}
      onToggle={disclosure.toggle}
      running={phase !== 'result'}
      expandOnRowClick
      collapsedContent={verdict ? <span className={'dhl-tool-verdict' + (failed ? ' err' : '')}>{verdict}</span> : null}
    >
      {phase === 'result' ? <pre className="dhl-tool-output">{text}</pre> : null}
    </DisclosureRow>
  )
}

/* ------------------------------------------------------------------ */

/** Mirrors the shipped detail (a call's `command`) for every non-hyper tool. */
function ApprovalDetail({ callId, useChat }: { callId: string; useChat: (selector: (snapshot: any) => any) => any }) {
  const call = useChat((snapshot: any) => {
    for (const node of snapshot.nodes.values()) {
      const root = node.kind === 'tool-call' ? node.data.root : undefined
      if (root !== undefined && root.callId === callId && !('kind' in root) && root.phase === 'start') return root
    }
    return undefined
  })
  if (!call) return null
  const args = parseArgs(call.argsRaw)
  if (typeof call.name === 'string' && call.name.startsWith('hyper_')) return <HyperApprovalCard name={call.name} args={args} />
  return typeof args.command === 'string' ? args.command : null
}

function HyperApprovalCard({ name, args }: { name: string; args: Record<string, any> }) {
  const [status, setStatus] = React.useState<any>(null)
  React.useEffect(() => {
    let live = true
    void hyperCall('status').then((value) => { if (live) setStatus(value) }).catch(() => {})
    return () => { live = false }
  }, [])
  const { title } = describeHyperCall(name, args)
  const coin = String(args.coin ?? '')
  const rows: Array<[string, string, string?]> = []
  if (name === 'hyper_order' && args.action === 'cancel') {
    rows.push([tr('合约', 'Market'), coin], [tr('订单', 'Order'), `oid ${args.oid ?? '—'}`])
  } else if (name === 'hyper_order' && args.action === 'leverage') {
    rows.push([tr('合约', 'Market'), coin], [tr('杠杆', 'Leverage'), `${args.leverage ?? '—'}x`, Number(args.leverage) > Number(status?.riskLimits?.maxLeverage ?? Infinity) ? 'warn' : ''])
    if (args.marginMode) rows.push([tr('保证金模式', 'Margin'), args.marginMode === 'isolated' ? tr('逐仓', 'Isolated') : tr('全仓', 'Cross')])
  } else {
    const px = args.type === 'limit' ? Number(args.px) : NaN
    const notional = Number.isFinite(px) ? px * Number(args.sz) : NaN
    rows.push(
      [tr('方向', 'Side'), side(args) || '—', args.isBuy ? 'up' : 'down'],
      [tr('合约', 'Market'), coin],
      [tr('数量', 'Size'), String(args.sz ?? '—')],
      [tr('价格', 'Price'), args.type === 'limit' ? exact(px) : tr('市价（IOC）', 'Market (IOC)')],
    )
    if (Number.isFinite(notional)) rows.push([tr('预估名义价值', 'Est. notional'), `${fmt(notional)} USD`])
    if (args.takeProfitPx != null) rows.push([tr('止盈', 'Take profit'), exact(args.takeProfitPx)])
    if (args.stopLossPx != null) rows.push([tr('止损', 'Stop loss'), exact(args.stopLossPx)])
    if (args.reduceOnly) rows.push([tr('只减仓', 'Reduce-only'), tr('是', 'Yes')])
  }
  const limits = status?.riskLimits
  return (
    <div className="dhl-approval-card">
      <div className="dhl-approval-head">
        <Mark /><strong>{title}</strong>
        {status ? <span className="dhl-approval-env">{status.network === 'mainnet' ? tr('主网', 'Mainnet') : tr('测试网', 'Testnet')} · {status.tradingMode === 'paper' ? tr('模拟盘', 'Paper') : tr('实盘', 'Live')}</span> : null}
      </div>
      <dl className="dhl-approval-rows">
        {rows.map(([label, value, tone]) => <div key={label}><dt>{label}</dt><dd className={tone === 'up' ? 'dhl-up' : tone === 'down' ? 'dhl-down' : tone === 'warn' ? 'dhl-warn' : ''}>{value}</dd></div>)}
      </dl>
      {limits ? <div className="dhl-approval-limits">
        {tr('交易限额', 'Limits')}：{tr('单笔', 'per order')} ≤ {fmt(limits.maxOrderUsd)} USD · {tr('今日', 'today')} {fmt(limits.usedTodayUsd ?? 0)} / {fmt(limits.maxDailyUsd)} USD · {tr('杠杆', 'leverage')} ≤ {fmt(limits.maxLeverage, 0)}x
      </div> : null}
      {typeof args.reason === 'string' && args.reason ? <p className="dhl-approval-reason">{args.reason}</p> : null}
    </div>
  )
}
