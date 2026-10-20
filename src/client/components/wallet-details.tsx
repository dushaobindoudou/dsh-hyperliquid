import * as React from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { hyperCall, tr } from '../remote'
import { fmt } from '../format'
import { useStore } from '../store'

type Period = 'day' | 'week' | 'month' | 'allTime'
const PERIODS: Array<[Period, string, string]> = [
  ['day', '24 小时', '24h'], ['week', '7 天', '7d'], ['month', '30 天', '30d'], ['allTime', '全部', 'All'],
]

function ProfitLine({ points }: { points: Array<[number, string]> }) {
  const values = points.map((row) => Number(row[1])).filter(Number.isFinite)
  if (values.length < 2) return null
  const min = Math.min(...values); const span = Math.max(...values) - min || 1
  const path = values.map((value, index) => `${index ? 'L' : 'M'}${(index / (values.length - 1) * 100).toFixed(2)},${(40 - (value - min) / span * 36).toFixed(2)}`).join(' ')
  return <svg className="dhl-wallet-graph" viewBox="0 0 100 44" preserveAspectRatio="none" role="img" aria-label={tr('收益走势', 'P&L trend')}><path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" /></svg>
}

export function WalletDetails({ open, onClose }: { open: boolean; onClose: () => void }) {
  const s = useStore()
  const [period, setPeriod] = React.useState<Period>('day')
  const [portfolio, setPortfolio] = React.useState<any>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)
  React.useEffect(() => {
    if (!open) return undefined
    let active = true
    setPortfolio(null); setError(null); setLoading(true)
    void hyperCall('portfolio').then((result) => { if (active) setPortfolio(result) })
      .catch((e) => { if (active) setError(String((e as Error)?.message ?? e)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [open, s.status?.network, s.status?.tradingMode, s.status?.address])

  const account = s.account
  const shared = account?.balanceSource === 'spot'
  const sample = portfolio?.series?.[period]
  const pnl = sample?.pnlHistory?.length ? Number(sample.pnlHistory.at(-1)[1]) : NaN
  const value = sample?.accountValueHistory?.length ? Number(sample.accountValueHistory.at(-1)[1]) : NaN
  const stats: Array<[string, string]> = account?.mode === 'paper' ? [
    [tr('账户权益', 'Equity'), `${fmt(account.equity)} USDC`],
    [tr('可用保证金', 'Available margin'), `${fmt(account.availableMargin)} USDC`],
    [tr('保留成交毛盈亏', 'Retained fills gross P&L'), `${fmt(portfolio?.realizedPnl)} USDC`],
    [tr('保留成交扣费净额', 'Retained fills net after fees'), portfolio?.netRealizedPnl == null ? '—' : `${fmt(portfolio.netRealizedPnl)} USDC`],
    [tr('未实现收益', 'Unrealized P&L'), `${fmt(account.uPnl)} USDC`],
  ] : [
    [shared ? tr('USDC 余额', 'USDC balance') : tr('永续账户价值', 'Perp account value'), `${fmt(shared ? account?.usdcBalance : account?.marginSummary?.accountValue)} USDC`],
    [shared ? tr('未占用 USDC', 'Unheld USDC') : tr('可提取', 'Withdrawable'), `${fmt(shared ? account?.unheldUsdc : account?.withdrawable)} USDC`],
    [tr('当前仓位未实现收益', 'Open position P&L'), `${fmt((account?.positions ?? []).reduce((sum: number, p: any) => sum + Number(p.uPnl ?? 0), 0))} USDC`],
    [tr('交易所组合账户价值', 'Exchange portfolio value'), Number.isFinite(value) ? `${fmt(value)} USDC` : '—'],
  ]
  return <Modal open={open} onClose={onClose} title={tr('钱包详情与收益', 'Wallet and P&L')} closeLabel={tr('关闭', 'Close')} className="dhl-wallet-modal">
    <div className="dhl-wallet-address">{s.status?.address ?? tr('模拟账户 · 本地账本', 'Paper account · local ledger')}</div>
    <div className="dhl-wallet-stats">{stats.map(([label, amount]) => <div key={label}><span>{label}</span><strong>{amount}</strong></div>)}</div>
    {account?.mode === 'live' ? <>
      <div className="dhl-wallet-periods">{PERIODS.map(([id, zh, en]) => <button type="button" key={id} className={period === id ? 'on' : ''} onClick={() => setPeriod(id)}>{tr(zh, en)}</button>)}</div>
      <div className="dhl-wallet-pnl"><span>{tr('期间收益', 'Period P&L')}</span><strong className={pnl >= 0 ? 'dhl-up' : 'dhl-down'}>{Number.isFinite(pnl) ? `${pnl >= 0 ? '+' : ''}${fmt(pnl)} USDC` : '—'}</strong></div>
      <ProfitLine points={sample?.pnlHistory ?? []} />
      <p className="dhl-ticket-note">{tr('收益曲线使用 Hyperliquid 组合账户样本（含入出金调整）；与当前可交易余额口径不同。', 'P&L uses Hyperliquid portfolio samples adjusted for deposits and withdrawals; it differs from tradable balance.')}</p>
    </> : <p className="dhl-ticket-note">{tr('模拟权益已扣除新成交的配置手续费；历史统计仅覆盖保留成交，旧记录费用可能未知。未模拟资金费及强平。', 'Paper equity deducts configured fees on new fills. History totals cover retained fills only; legacy fees may be unknown. No funding or liquidation simulation.')}</p>}
    {loading ? <div className="dhl-empty">{tr('正在读取收益…', 'Loading P&L…')}</div> : null}
    {error ? <div className="dhl-inline-error" role="status">{error}</div> : null}
  </Modal>
}
