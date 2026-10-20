/**
 * dsh-hyperliquid — bottom table with HL-style tabs
 * (positions / orders & fills / account).
 * uPnL coloring follows Hyperliquid: profit green, loss red.
 * @module src/client/components/bottom-table
 */

import * as React from 'react'
import { t, tr } from '../remote'
import { fmt, fmtPrice } from '../format'
import { loadTradeHistory, queueToAgent, saveSessionWorkspace } from '../data'
import { useStore } from '../store'

import { TradeReview } from './trade-review'

type Tab = 'positions' | 'orders' | 'account' | 'review'

export function BottomTable({ account, accountError }: { account: any; accountError: string | null }) {
  const s = useStore()
  const tab: Tab = s.workspaceSessionId === s.activeSessionId ? s.workspace?.bottomTab ?? 'positions' : 'positions'
  const [orderView, setOrderView] = React.useState<'open' | 'history' | 'fills'>('open')
  const [historyLimit, setHistoryLimit] = React.useState(100)
  const positions = account?.positions ?? []
  const orders = account?.openOrders ?? []
  const history = s.tradeHistory

  React.useEffect(() => {
    if (tab === 'orders') void loadTradeHistory()
  }, [tab, account?.address, s.status?.network])

  const requestCancel = (coin: string, oid: number) => {
    queueToAgent(tr(`请核对 ${coin} 当前挂单 oid=${oid} 的状态，并用 hyper_order action=cancel 撤销该订单。若已成交或已撤销，请说明结果；不要创建新订单。`,
      `Check the current status of ${coin} order oid=${oid}, then cancel it with hyper_order action=cancel. If already filled or cancelled, explain the outcome. Do not place a new order.`))
  }

  const tabs: Array<[Tab, string]> = [
    ['positions', t('tab.positions', '持仓')],
    ['orders', t('tab.orders', '委托与成交')],
    ['account', t('tab.account', '账户')],
    ['review', tr('交易复盘', 'Trade review')],
  ]
  const head = (...cells: string[]) => (
    <div className="dhl-posrow dhl-poshead">{cells.map((c) => <span key={c}>{c}</span>)}</div>
  )

  let body: React.ReactNode = null
  if (tab === 'positions') {
    body = (
      <div className="dhl-positions-table">
        <div className="dhl-posrow dhl-posrow-position dhl-poshead">
          {[t('positions.coin', '合约'), t('positions.size', '数量'), t('positions.entry', '开仓价'), t('positions.mark', '标记'), t('positions.upnl', '未实现'), 'ROE', tr('清算价', 'Liquidation')].map((label) => <span key={label}>{label}</span>)}
        </div>
        {positions.length === 0
          ? <div className="dhl-posrow"><span style={{ color: 'var(--dsw-alias-label-secondary)' }}>{t('positions.none', '（无持仓）')}</span></div>
          : positions.map((p: any, i: number) => {
            const roe = p.returnOnEquity == null ? null : Number(p.returnOnEquity) * 100
            const leverage = typeof p.leverage === 'number' ? p.leverage : Number(p.leverage?.value)
            return <div key={`${p.coin}:${i}`}>
              <div className="dhl-posrow dhl-posrow-position">
                <span>{p.coin}</span><span>{`${p.size > 0 ? '+' : ''}${fmt(p.size, 4)}`}</span>
                <span>{fmtPrice(p.entryPx)}</span><span>{p.markPx == null ? '—' : fmtPrice(p.markPx)}</span>
                <span className={p.uPnl >= 0 ? 'dhl-up' : 'dhl-down'}>{fmt(p.uPnl)}</span>
                <span className={roe == null ? '' : roe >= 0 ? 'dhl-up' : 'dhl-down'}>{roe == null ? '—' : `${fmt(roe)}%`}</span>
                <span>{p.liquidationPx == null ? '—' : fmtPrice(p.liquidationPx)}</span>
              </div>
              {account?.mode === 'live' ? <div className="dhl-position-extra">
                <span>{tr('保证金', 'Margin')} {p.marginUsed == null ? '—' : `${fmt(p.marginUsed)} USDC`}</span>
                <span>{tr('杠杆', 'Leverage')} {Number.isFinite(leverage) && leverage > 0 ? `${leverage}x` : '—'}</span>
                <span>{tr('开仓以来资金费', 'Funding since open')} {p.cumFunding?.sinceOpen == null ? '—' : `${fmt(p.cumFunding.sinceOpen)} USDC`}</span>
              </div> : null}
            </div>
          })}
      </div>
    )
  } else if (tab === 'orders') {
    const rows = orderView === 'open' ? orders : orderView === 'history' ? history?.orders ?? [] : history?.fills ?? []
    body = (
      <div>
        <div className="dhl-history-controls">
          {([['open', tr('当前挂单', 'Open')], ['history', tr('历史委托', 'Order history')], ['fills', tr('成交记录', 'Fills')]] as const).map(([id, label]) => <button type="button" key={id} className={orderView === id ? 'on' : ''} onClick={() => { setOrderView(id); setHistoryLimit(100) }}>{label}</button>)}
          <button type="button" className="dhl-history-refresh" onClick={() => void loadTradeHistory(true)}>{tr('刷新', 'Refresh')}</button>
        </div>
        {orderView !== 'open' && s.tradeHistoryError ? <div className="dhl-inline-error" role="status">{s.tradeHistoryError}</div> : null}
        {head(
          t('orders.coin', '合约'), t('orders.side', '方向'),
          t('orders.px', '价格'), t('orders.sz', '数量'), t('orders.status', '状态'),
        )}
        {rows.length === 0 ? <div className="dhl-posrow"><span style={{ color: 'var(--dsw-alias-label-secondary)' }}>{orderView !== 'open' && !s.tradeHistoryAt && !s.tradeHistoryError ? tr('正在读取历史…', 'Loading history…') : accountError && orderView === 'open' ? tr('挂单状态未确认', 'Order status unconfirmed') : tr('暂无记录', 'No records')}</span></div> : null}
        {rows.slice(0, orderView === 'open' ? 30 : historyLimit).map((row: any, index: number) => {
          const buy = row.isBuy ?? row.side === 'B'
          const time = Number(row.timestamp ?? row.time ?? row.statusTimestamp)
          const reason = orderView === 'fills' ? row.reason || history?.orders.find((order: any) => order.oid != null && order.oid === row.oid)?.reason : row.reason
          const displayReason = typeof reason === 'string' && !reason.startsWith('session:') && !['tool', 'chat', 'order'].includes(reason) ? reason : ''
          return <div key={`${orderView}:${row.oid ?? row.tid ?? index}:${time}`}>
            <div className="dhl-posrow">
              <span>{row.coin ?? '—'}</span>
              <span className={buy ? 'dhl-up' : 'dhl-down'}>{buy ? t('side.buy', '买') : t('side.sell', '卖')}</span>
              <span>{fmtPrice(row.limitPx ?? row.px)}</span>
              <span>{fmt(row.origSz ?? row.sz, 4)}</span>
              <span className="dhl-order-action"><span>{orderView === 'open' ? t('orders.open', '挂单中') : orderView === 'fills' ? tr('已成交', 'Filled') : String(row.status ?? '—')}</span>
                {orderView === 'open' && Number.isInteger(Number(row.oid)) && Number(row.oid) > 0 ? <button type="button" className="dhl-ghost" onClick={() => requestCancel(String(row.coin), Number(row.oid))}>{tr('撤单', 'Cancel')}</button> : null}
              </span>
            </div>
            {orderView !== 'open' ? <div className="dhl-history-detail">
              <span>{Number.isFinite(time) && time > 0 ? new Date(time).toLocaleString() : '—'}</span>
              {orderView === 'fills' && row.closedPnl != null ? <span>P&L {fmt(row.closedPnl)} · {tr('手续费', 'Fee')} {fmt(row.fee)}</span> : null}
              {displayReason ? <span title={displayReason}>{tr('下单原因', 'Order reason')}：{displayReason}</span> : null}
            </div> : null}
          </div>
        })}
        {orderView !== 'open' && rows.length > historyLimit ? <button type="button" className="dhl-history-more" onClick={() => setHistoryLimit((limit) => limit + 100)}>{tr('显示更多', 'Show more')} · {Math.min(historyLimit, rows.length)}/{rows.length}</button> : null}
      </div>
    )
  } else if (tab === 'review') {
    body = <TradeReview />
  } else {
    body = (
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 11.5, fontVariantNumeric: 'tabular-nums', padding: '4px 0' }}>
        {account?.mode === 'paper'
          ? [
            <span key="c">{`${t('account.cash', '现金')}: ${fmt(account.usd)}`}</span>,
            <span key="e">{`${t('account.equity', '权益')}: ${fmt(account.equity)}`}</span>,
            <span key="m">{`${tr('已用保证金', 'Margin used')}: ${fmt(account.marginUsed)}`}</span>,
            <span key="a">{`${tr('可用保证金', 'Available margin')}: ${fmt(account.availableMargin)}`}</span>,
            <span key="u" style={{ color: account.uPnl >= 0 ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)' }}>
              {`uPnL: ${fmt(account.uPnl)}`}
            </span>,
          ]
          : [
            account?.accountMode
              ? <span key="mode">{`${tr('账户模式', 'Account mode')}: ${({ unifiedAccount: 'Unified', portfolioMargin: 'Portfolio', disabled: 'Standard', default: 'Standard', dexAbstraction: 'DEX abstraction' } as Record<string, string>)[account.accountMode] ?? account.accountMode}`}</span>
              : null,
            account?.accountDex ? <span key="dex">{`${tr('永续 DEX', 'Perp DEX')}: ${account.accountDex}`}</span> : null,
            account?.marginSummary
              ? <span key="v">{`${account.accountDex ? tr('DEX 抵押账户价值', 'DEX collateral value') : t('account.value', '账户价值')}: ${fmt(account.marginSummary.accountValue)}`}</span>
              : null,
            account?.balanceSource === 'spot'
              ? <span key="usdc">{`${tr('USDC 余额', 'USDC balance')}: ${fmt(account.usdcBalance)} · ${tr('未占用', 'Unheld')}: ${fmt(account.unheldUsdc)}`}</span>
              : account ? <span key="a">{`${account.accountDex ? tr('DEX 可用', 'DEX available') : t('account.available', '可用')}: ${fmt(account.withdrawable)}`}</span> : null,
            account?.address
              ? <span key="addr" style={{ color: 'var(--dsw-alias-label-secondary)' }}>
                {account.address.slice(0, 6) + '…' + account.address.slice(-4)}
              </span>
              : null,
          ]}
      </div>
    )
  }

  return (
    <div className="dhl-card" style={{ margin: '0 14px 12px', flex: 'none' }}>
      {accountError ? <div className="dhl-account-warning" role="status">{tr('账户与挂单状态未确认', 'Account and order status unconfirmed')}：{accountError}</div> : null}
      <div style={{ display: 'flex', gap: 2, marginBottom: 6 }}>
        {tabs.map(([id, label]) => (
          <button key={id} className={'dhl-tab' + (tab === id ? ' on' : '')} onClick={() => saveSessionWorkspace({ bottomTab: id })}>
            {label}
          </button>
        ))}
      </div>
      {body}
      {account?.mode === 'paper' ? <p className="dhl-ticket-note">{tr(account.simulation, 'Configured slippage and fees; depth, funding and liquidation are not simulated.')}</p> : null}
    </div>
  )
}
