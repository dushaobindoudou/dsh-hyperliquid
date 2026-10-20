/** Bounded, auditable fills and order reconciliation, never an account-return estimate. */
import * as React from 'react'
import { hyperCall, tr } from '../remote'
import { useStore, store } from '../store'
import { queueToAgent, saveSessionWorkspace } from '../data'
import { reviewLedger } from '../../../lib/review.js'
import { fmt, fmtPrice } from '../format'
import { downloadBlob } from '../chart-basics'
import { Select } from './select'

const flags: Record<string, [string, string]> = {
  'unmatched-order': ['未匹配委托', 'Unmatched order'], 'missing-reason': ['未记录原因', 'Missing rationale'],
  'missing-fee': ['费用未知', 'Unknown fee'], 'missing-pnl': ['盈亏未知', 'Unknown P&L'], 'missing-trade-id': ['缺少成交 ID', 'Missing trade ID'],
  'size-gap': ['数量有差异', 'Size gap'], 'excess-fill': ['成交超出委托量', 'Excess fill'],
  'missing-price': ['价格未知', 'Unknown price'], 'missing-size': ['数量未知', 'Unknown size'], 'missing-time': ['时间未知', 'Unknown time'], 'missing-side': ['方向未知', 'Unknown side'],
  'matched': ['数量匹配', 'Quantity matched'], 'no-fill-in-window': ['窗口内无成交', 'No fill in window'],
}
export function TradeReview() {
  const s = useStore(), [days, setDays] = React.useState(30), [scope, setScope] = React.useState('coin')
  const [reload, setReload] = React.useState(0), [data, setData] = React.useState<any>(null), [error, setError] = React.useState(''), [limit, setLimit] = React.useState(50)
  const identity = `${s.status?.network}:${s.status?.tradingMode}:${s.account?.address ?? ''}:${days}`
  const [loadedFor, setLoadedFor] = React.useState('')
  React.useEffect(() => {
    let live = true
    setData(null); setError(''); setLimit(50); setLoadedFor('')
    void hyperCall('tradeHistory', { includeFunding: true, days }).then((value) => {
      if (live) { setData(value); setLoadedFor(identity) }
    }).catch((cause) => { if (live) setError(String(cause?.message ?? cause)) })
    return () => { live = false }
  }, [identity, reload])
  const payload = loadedFor === identity ? data : null
  const coin = scope === 'coin' ? s.activeCoin : ''
  const ledger = React.useMemo(() => payload ? reviewLedger(payload, coin) : null, [payload, coin])
  const showFlag = (flag: string) => flags[flag] ? tr(...flags[flag]) : flag
  const money = (value: number | null) => value == null ? tr('未知', 'Unknown') : `${fmt(value)} USDC`
  const coverage = payload?.coverage
  return <section className="dhl-review" aria-label={tr('交易复盘', 'Trade review')}>
    <div className="dhl-history-controls">
      <Select aria-label={tr('复盘时间范围', 'Review window')} value={days} onChange={(e) => setDays(Number(e.target.value))}>{[7, 30, 90].map((d) => <option value={d} key={d}>{tr(`最近 ${d} 天`, `Last ${d} days`)}</option>)}</Select>
      <Select aria-label={tr('复盘标的范围', 'Review markets')} value={scope} onChange={(e) => setScope(e.target.value)}><option value="coin">{s.activeCoin}</option><option value="all">{tr('全部标的', 'All markets')}</option></Select>
      <button type="button" onClick={() => setReload((v) => v + 1)}>{tr('刷新证据', 'Refresh evidence')}</button>
      <button type="button" disabled={!ledger} onClick={() => downloadBlob(new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), scope: coin || 'all', evidence: payload, reconciliation: ledger }, null, 2)], { type: 'application/json' }), `trade-review-${Date.now()}.json`)}>{tr('导出证据 JSON', 'Export evidence JSON')}</button>
      <button type="button" disabled={!ledger} onClick={() => queueToAgent(tr(`请用 hyper_account action=review days=${days}${coin ? ` coin=${coin}` : ''} 获取复盘证据，核对订单、成交、成本和原因。先说明覆盖缺口，再复盘决策与执行；不要把窗口统计当成账户收益率。`, `Use hyper_account action=review days=${days}${coin ? ` coin=${coin}` : ''} to review orders, fills, costs and rationale. Explain coverage gaps before reviewing decisions and execution. Window totals are not account returns.`))}>{tr('交给 AI 复盘', 'Review with AI')}</button>
    </div>
    {error ? <p className="dhl-inline-error" role="alert">{error}</p> : !ledger ? <p role="status">{tr('正在核对交易证据…', 'Checking trading evidence…')}</p> : <>
      <p className="dhl-evidence-note">{payload.mode === 'paper' ? tr('模拟账本', 'Paper ledger') : tr('交易所历史', 'Exchange history')} · {payload.network} · {new Date(coverage.startTime).toLocaleString()} — {new Date(coverage.endTime).toLocaleString()}<br />
        {tr('窗口统计，不代表账户收益或完整往返交易。仅核心 USDC 永续合并盈亏；其他抵押币种单独看原始记录。手续费已含 builder fee，不重复扣除。', 'Window statistics, not account returns or completed round trips. Combined P&L covers core USDC perpetuals only. Fees include builder fees once.')}
      </p>
      {coverage.fillsLimited || coverage.ordersLimited ? <p className="dhl-inline-error">{tr('历史数量达到保留上限，时间范围可能不完整；不能据此确认全部交易已核对。', 'History reaches its retention limit; this window may be incomplete.')}</p> : null}
      {coverage.fundingStatus !== 'complete' ? <p className="dhl-evidence-note">{tr('资金费', 'Funding')}：{coverage.fundingStatus === 'not-simulated' ? tr('未模拟', 'Not simulated') : tr('未完整取得', 'Incomplete')} {coverage.fundingError ?? ''} · {tr('不显示含资金费净额', 'Net including funding is unknown')}</p> : null}
      <div className="dhl-review-summary">
        {[[tr('已知毛盈亏', 'Known gross P&L'), money(ledger.gross)], [tr('扣手续费净额', 'Net after fees'), money(ledger.tradingNet)], [tr('资金费收入 / 支出', 'Funding credits / debits'), money(ledger.funding)], [tr('含资金费净额', 'Net including funding'), money(ledger.net)], [tr('成交 / 平仓成交笔数', 'Fills / closing fills'), `${ledger.records.length} / ${ledger.closeCount}`], [tr('缺少原因 / 未匹配 / 数量差异', 'Missing rationale / unmatched / size gaps'), `${ledger.missingReasons} / ${ledger.unmatched} / ${ledger.gaps}`]].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}
      </div>
      <p className="dhl-evidence-note">{tr('已知手续费', 'Known fees')}：{Object.entries(ledger.fees).map(([token, value]) => `${fmt(value, 6)} ${token}`).join(' · ') || '—'} · {tr('去重成交', 'Duplicate fills removed')} {ledger.duplicates} · {tr('未合并盈亏的成交', 'Fills excluded from combined P&L')} {ledger.unsupported}</p>
      {payload.paperCosts ? <p className="dhl-evidence-note">{tr('当前模拟假设', 'Current simulation assumptions')}：{payload.paperCosts.feeBps} bps {tr('手续费', 'fee')} / {payload.paperCosts.slippageBps} bps {tr('滑点', 'slippage')} · {tr('历史逐笔保留当时配置；旧记录费用未知。未模拟盘口深度、资金费、强平。', 'Each fill preserves its assumptions; legacy fees may be unknown. No depth, funding or liquidation simulation.')}</p> : null}
      {payload.localOrders?.some((row: any) => ['unknown', 'submitting', 'protection-unknown'].includes(row.status)) ? <details>
        <summary className="dhl-inline-error">{tr('本地下单状态待核实', 'Local order status unconfirmed')}</summary>
        {payload.localOrders.filter((row: any) => ['unknown', 'submitting', 'protection-unknown'].includes(row.status)).map((row: any) => <div className="dhl-evidence-detail" key={row.cloid}>
          <span>{row.coin} · {row.status} · {row.cloid}</span>
          <button type="button" className="dhl-ghost" onClick={() => queueToAgent(tr(`请用 hyper_account action=orderStatus oid=${row.cloid} 核实订单与保护单状态，不要重复下单。`, `Use hyper_account action=orderStatus oid=${row.cloid} to check the order and protection state. Do not submit another order.`))}>{tr('核实订单状态', 'Check order status')}</button>
        </div>)}
      </details> : null}
      <details><summary>{tr('委托数量核对', 'Order quantity reconciliation')} · {ledger.orders.length}</summary><p className="dhl-evidence-note">{tr('按标的 + oid 匹配；部分成交、窗口外成交或保留截断都会产生差异，无成交不等于未执行。', 'Matched by market and oid. Partial fills, window boundaries and retention can cause gaps. No fill is not proof of no execution.')}</p>{ledger.orders.slice(0, limit).map((row, i) => <div className="dhl-review-order" key={`${row.coin}:${row.oid}:${i}`}><span>{row.coin} · oid {row.oid ?? '—'}</span><span>{fmt(row.filled, 6)} / {row.expected == null ? '—' : fmt(row.expected, 6)}</span><span>{row.exchangeStatus} · {showFlag(row.status)}</span></div>)}</details>
      {!ledger.records.length ? <p className="dhl-empty">{tr('窗口内无成交记录', 'No fills in this window')}</p> : null}
      {[...ledger.records].sort((a, b) => (b.time ?? 0) - (a.time ?? 0)).slice(0, limit).map((row) => <details key={row.id} className="dhl-review-fill"><summary><time>{row.time ? new Date(row.time).toLocaleString() : '—'}</time> <b>{row.coin}</b> {row.isBuy == null ? tr('方向未知', 'Side unknown') : row.isBuy ? tr('买', 'Buy') : tr('卖', 'Sell')} {fmt(row.size, 6)} @ {fmtPrice(row.px)} <span>{tr('毛盈亏', 'Gross')} {row.gross == null ? '—' : fmt(row.gross)}</span></summary>
        <div className="dhl-evidence-detail"><span>oid {row.oid ?? '—'} · {row.id}</span><span>{tr('手续费', 'Fee')} {row.fee == null ? tr('未知', 'Unknown') : `${fmt(row.fee, 6)} ${row.feeToken}`} · {tr('USDC 净额', 'USDC net')} {money(row.net)}</span><span>{tr('相对决策中间价的滑点（正数为不利）', 'Slippage vs decision mid (positive is adverse)')} {row.slippageBps == null ? tr('未知', 'Unknown') : `${fmt(row.slippageBps, 2)} bps`}</span><span>{tr('当时原因', 'Rationale')}：{row.reason || tr('未记录，不能事后补写成原始依据', 'Not recorded; cannot reconstruct original rationale')}</span><span>{row.flags.map(showFlag).join(' · ')}</span>
          {row.coin === s.activeCoin && row.time ? <button type="button" className="dhl-ghost" onClick={() => { store.patch({ chartFocus: { coin: row.coin, interval: s.interval, t: row.time!, at: Date.now() } }); saveChartTab() }}>{tr('定位图表', 'Locate on chart')}</button> : null}
        </div>
      </details>)}
      {Math.max(ledger.records.length, ledger.orders.length) > limit ? <button type="button" className="dhl-ghost" onClick={() => setLimit((v) => v + 100)}>{tr('显示更多', 'Show more')}</button> : null}
    </>}
  </section>
}
const saveChartTab = () => saveSessionWorkspace({ chartTab: 'chart' })
