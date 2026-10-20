/** A typed order intent. Execution stays in the bound DSH conversation. */
import * as React from 'react'
import { Select } from './select'
import { tr } from '../remote'
import { fmt, fmtPrice } from '../format'
import { isMarketStale, queueToAgent } from '../data'
import { notify, useStore } from '../store'

export function TradeTicket({ onSubmitted }: { onSubmitted?: () => void }) {
  const s = useStore()
  const coin = s.activeCoin
  const catalogMarket = s.marketCatalog.find((row) => row.name === coin)
  // HIP-3 perps are not in the core `markets` list; their size precision and leverage come from the catalog.
  const market = s.markets.find((row) => row.name === coin) ?? (catalogMarket?.tradable ? catalogMarket : undefined)
  const liveMid = s.snapshot?.coin === coin && Date.now() - Number(s.snapshot?.observedAt?.mids) < 10_000
    ? Number(s.snapshot?.mids?.mids?.[coin] ?? s.snapshot?.mids?.[coin]) : 0
  const mark = liveMid || Number(s.selectedMarket?.name === coin ? s.selectedMarket.ctx?.markPx : 0) || Number(market?.ctx?.markPx)
  const position = s.account?.positions?.find((p: any) => p.coin === coin)
  const sharedBalance = s.account?.balanceSource === 'spot'
  const capacity = s.account?.tradeCapacity?.coin === coin ? s.account.tradeCapacity : null
  const available = Number(s.account?.mode === 'paper' ? s.account?.availableMargin : sharedBalance
    ? capacity?.availableToTrade?.length === 2 ? Math.min(...capacity.availableToTrade.map(Number)) : NaN
    : s.account?.withdrawable)
  const [isBuy, setIsBuy] = React.useState(true)
  const [kind, setKind] = React.useState<'market' | 'limit'>('market')
  const [margin, setMargin] = React.useState<'cross' | 'isolated'>('cross')
  const [leverage, setLeverage] = React.useState(2)
  const [size, setSize] = React.useState('')
  const [price, setPrice] = React.useState('')
  const [pct, setPct] = React.useState(0)
  const [reduceOnly, setReduceOnly] = React.useState(false)
  const [withTargets, setWithTargets] = React.useState(false)
  const [tp, setTp] = React.useState('')
  const [sl, setSl] = React.useState('')
  const [reason, setReason] = React.useState('')
  const [enabled, setEnabled] = React.useState(false)
  const decimals = Number(market?.szDecimals ?? 5)
  const maxLeverage = Math.max(1, Math.min(50, Number(market?.maxLeverage ?? 2), Number(s.status?.riskLimits?.maxLeverage ?? 2)))
  const priceNum = kind === 'limit' ? Number(price) : mark
  const sizeNum = Number(size)
  const orderValue = Number.isFinite(priceNum * sizeNum) ? priceNum * sizeNum : 0
  const maxUsd = reduceOnly ? Math.abs(Number(position?.size ?? 0)) * mark
    : Math.min(Number(s.status?.riskLimits?.maxOrderUsd ?? 100), Math.max(0, available) * (sharedBalance ? 1 : leverage))
  const exchangeMaxSize = sharedBalance && !reduceOnly && capacity?.maxTradeSzs?.length === 2 ? Math.min(...capacity.maxTradeSzs.map(Number)) : Infinity
  const maxSize = mark > 0 && Number.isFinite(maxUsd) && (Number.isFinite(exchangeMaxSize) || exchangeMaxSize === Infinity)
    ? Math.min(maxUsd / mark, exchangeMaxSize) : 0
  const bid = Number(s.snapshot?.book?.levels?.[0]?.[0]?.px)
  const ask = Number(s.snapshot?.book?.levels?.[1]?.[0]?.px)
  const spreadPct = bid > 0 && ask > bid ? (ask / bid - 1) * 100 : null

  React.useEffect(() => {
    setSize(''); setPrice(''); setPct(0); setEnabled(false)
  }, [coin])
  React.useEffect(() => {
    const draft = s.ticketDraft
    if (!draft || draft.coin !== coin) return
    setIsBuy(draft.isBuy); setKind('limit'); setPrice(draft.px)
  }, [s.ticketDraft?.at, coin])
  React.useEffect(() => {
    if (leverage > maxLeverage) setLeverage(maxLeverage)
  }, [maxLeverage, leverage])

  const setPercent = (next: number) => {
    setPct(next)
    if (maxSize <= 0) { setSize(''); return }
    const factor = 10 ** decimals
    setSize(String(Math.floor(maxSize * next / 100 * factor) / factor))
  }
  const errors: string[] = []
  if (!market || catalogMarket?.tradable === false) errors.push(tr('当前市场仅支持行情查看，尚未接入签名交易', 'This market is view only; signed trading is unavailable'))
  if (isMarketStale(s)) errors.push(tr('行情未及时更新，等待数据恢复', 'Market data is stale; waiting for recovery'))
  if (!s.accountAt || Date.now() - s.accountAt > 10_000 || s.accountError) errors.push(tr('账户状态未及时更新', 'Account state is stale'))
  if (s.account?.mode === 'paper' && s.account.marksConfirmed === false) errors.push(tr('模拟仓位价格未确认', 'Paper position prices are unconfirmed'))
  if (!s.activeSessionId) errors.push(tr('先选择交易会话', 'Choose a trading session first'))
  if (!reduceOnly && (!Number.isFinite(available) || available <= 0)) errors.push(sharedBalance ? tr('当前币对可交易额度未确认或不足', 'Trading capacity is unconfirmed or insufficient') : tr('账户没有可用资金', 'No available funds'))
  if (!Number.isFinite(sizeNum) || sizeNum <= 0) errors.push(tr('填写有效数量', 'Enter a valid size'))
  if (mark <= 0) errors.push(tr('等待实时价格', 'Waiting for live price'))
  if (kind === 'limit' && (!Number.isFinite(priceNum) || priceNum <= 0)) errors.push(tr('填写有效限价', 'Enter a valid limit price'))
  if (sizeNum > 0 && Number(sizeNum.toFixed(decimals)) !== sizeNum) errors.push(tr(`数量最多 ${decimals} 位小数`, `Size allows at most ${decimals} decimal places`))
  if (orderValue > 0 && orderValue < 10) errors.push(tr('订单价值低于交易所最低 10 USDC', 'Order value is below the 10 USDC exchange minimum'))
  if (reason.trim().length < 10 || reason.trim().length > 1000) errors.push(tr('填写 10–1000 字的下单原因', 'Enter an order reason of 10–1000 characters'))
  if (!reduceOnly && orderValue > Number(s.status?.riskLimits?.maxOrderUsd ?? 100)) errors.push(tr('超过单笔交易限额', 'Exceeds per order limit'))
  if (reduceOnly && (!position?.size || Math.sign(position.size) === (isBuy ? 1 : -1) || sizeNum > Math.abs(position.size))) errors.push(tr('只减仓数量与当前仓位不匹配', 'Reduce only size does not match the current position'))
  if (withTargets) {
    const t = Number(tp); const stop = Number(sl)
    if (tp && !(t > 0 && (isBuy ? t > Math.max(priceNum, mark) : t < Math.min(priceNum, mark)))) errors.push(tr('止盈价与入场价或当前价方向不匹配', 'Take profit conflicts with entry or current price'))
    if (sl && !(stop > 0 && (isBuy ? stop < Math.min(priceNum, mark) : stop > Math.max(priceNum, mark)))) errors.push(tr('止损价与入场价或当前价方向不匹配', 'Stop loss conflicts with entry or current price'))
    if (!tp && !sl) errors.push(tr('填写止盈或止损价', 'Enter take profit or stop loss'))
    if (reduceOnly) errors.push(tr('只减仓主单不能附加新的止盈止损保护单', 'Reduce only orders cannot add new protection orders'))
    if (s.status?.tradingMode !== 'live') errors.push(tr('paper 暂不模拟触发保护单；请移除止盈止损或切换 testnet live', 'Paper mode does not simulate triggers; remove targets or use testnet live'))
  }

  const submit = () => {
    if (!enabled) { notify(tr('先启用交易票据', 'Enable the trade ticket first')); return }
    if (errors.length) { notify(errors[0]); return }
    const parts = [
      tr(`请分析 ${coin} 的实时行情与账户，决定是否执行以下交易意图：`, `Analyze live ${coin} market and account data and decide whether to execute this trade intent:`),
      tr(`${isBuy ? '买入/开多' : '卖出/开空'} ${size} ${coin}，${kind === 'market' ? '市价' : `限价 ${price}`}${reduceOnly ? '，只减仓' : ''}。`,
        `${isBuy ? 'Buy / long' : 'Sell / short'} ${size} ${coin}, ${kind === 'market' ? 'market' : `limit ${price}`}${reduceOnly ? ', reduce only' : ''}.`),
      tr(`用户填写的下单原因：${reason.trim()}。请结合实时数据独立核对；执行时把此原因传入 hyper_decide.thesis（实盘）或 hyper_order.reason（模拟盘）。`,
        `User's order reason: ${reason.trim()}. Independently verify it against live data; pass it as hyper_decide.thesis (live) or hyper_order.reason (paper).`),
      tr(`杠杆 ${leverage}x，${margin === 'cross' ? '全仓' : '逐仓'}；若当前配置不同，请先用 hyper_order action=leverage 调整，再重新检查账户与风险。`,
        `${leverage}x leverage, ${margin === 'cross' ? 'cross' : 'isolated'} margin. If current settings differ, use hyper_order action=leverage first, then recheck account and risk.`),
      withTargets ? tr(`保护单参数：${tp ? `takeProfitPx=${tp}` : '不设止盈'}，${sl ? `stopLossPx=${sl}` : '不设止损'}。hyper_decide 和 hyper_order 必须传入相同参数，以 normalTpsl 分组提交。父单未完全成交时，子单尚未生效；部分成交后撤销父单会撤销子单。提交后核对实际仓位与保护挂单，若有未受保护仓位，先处理风险，不要假定回执即代表保护已生效。`,
        `Protection: ${tp ? `takeProfitPx=${tp}` : 'no take profit'}, ${sl ? `stopLossPx=${sl}` : 'no stop loss'}. Pass identical parameters to hyper_decide and hyper_order, grouped as normalTpsl. Child orders are inactive until the parent fully fills; cancelling a partially filled parent cancels children. Verify actual position and resting protection orders after submission. Handle any unprotected exposure; do not assume a receipt means protection is active.`) : '',
      s.status?.tradingMode === 'live'
        ? tr('请先核对实时行情、账户、风险与最小交易额。先用 hyper_decide 获取一次性 decisionId，再用 hyper_order 执行；若条件不满足，解释原因，不要下单。',
          'Verify live market data, account, risk and minimum order value. Get a one-use decisionId with hyper_decide, then execute with hyper_order. If conditions fail, explain and do not trade.')
        : tr('这是模拟盘。请先核对实时行情、账户、风险与最小交易额，再用 hyper_order 执行；若条件不满足，解释原因，不要下单。',
          'This is paper mode. Verify live market data, account, risk and minimum order value, then execute with hyper_order. If conditions fail, explain and do not trade.'),
    ]
    if (queueToAgent(parts.filter(Boolean).join('\n'))) onSubmitted?.()
  }

  return (
    <section className="dhl-ticket" aria-label={tr('交易票据', 'Trade ticket')}>
      <div className="dhl-ticket-mode">
        <label>{tr('保证金模式', 'Margin mode')}<Select value={margin} onChange={(e) => setMargin(e.target.value as 'cross' | 'isolated')}><option value="cross">{tr('全仓', 'Cross')}</option><option value="isolated">{tr('逐仓', 'Isolated')}</option></Select></label>
        <label>{tr('杠杆', 'Leverage')}<Select value={leverage} onChange={(e) => setLeverage(Number(e.target.value))}>{Array.from({ length: maxLeverage }, (_, i) => i + 1).map((v) => <option key={v} value={v}>{v}x</option>)}</Select></label>
      </div>
      <div className="dhl-ticket-tabs" role="tablist" aria-label={tr('订单类型', 'Order type')}>
        <button type="button" role="tab" aria-selected={kind === 'market'} className={kind === 'market' ? 'on' : ''} onClick={() => setKind('market')}>{tr('市价', 'Market')}</button>
        <button type="button" role="tab" aria-selected={kind === 'limit'} className={kind === 'limit' ? 'on' : ''} onClick={() => setKind('limit')}>{tr('限价', 'Limit')}</button>
      </div>
      <div className="dhl-ticket-sides" role="group" aria-label={tr('交易方向', 'Trade side')}>
        <button type="button" className={isBuy ? 'buy on' : 'buy'} aria-pressed={isBuy} onClick={() => setIsBuy(true)}>{tr('买入 / 做多', 'Buy / Long')}</button>
        <button type="button" className={!isBuy ? 'sell on' : 'sell'} aria-pressed={!isBuy} onClick={() => setIsBuy(false)}>{tr('卖出 / 做空', 'Sell / Short')}</button>
      </div>
      <div className="dhl-ticket-balance"><span>{tr('可用资金', 'Available')}</span><strong>{Number.isFinite(available) ? fmt(available) : '—'} USDC</strong></div>
      <div className="dhl-ticket-balance"><span>{tr('当前仓位', 'Current position')}</span><strong>{position ? fmt(position.size, decimals) : fmt(0, decimals)} {coin}</strong></div>
      {kind === 'limit' ? <label className="dhl-ticket-field"><span>{tr('限价', 'Limit price')}</span><div><input type="number" min="0" value={price} onChange={(e) => setPrice(e.target.value)} placeholder={fmtPrice(mark)} /><small>USDC</small></div></label> : null}
      <label className="dhl-ticket-field"><span>{tr('数量', 'Size')}</span><div><input type="number" min="0" step={10 ** -decimals} value={size} onChange={(e) => { setSize(e.target.value); setPct(0) }} placeholder="0" /><small>{coin}</small></div></label>
      <label className="dhl-ticket-reason"><span>{tr('下单原因', 'Order reason')}</span><textarea value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} placeholder={tr('写下交易依据、失效条件与风险', 'Record the thesis, invalidation and risk')} rows={3} /></label>
      <div className="dhl-ticket-range"><input type="range" min="0" max="100" step="25" value={pct} onChange={(e) => setPercent(Number(e.target.value))} aria-label={tr('使用可用额度百分比', 'Percent of available capacity')} /><output>{pct}%</output></div>
      <label className="dhl-ticket-check"><input type="checkbox" checked={reduceOnly} onChange={(e) => setReduceOnly(e.target.checked)} />{tr('只减仓', 'Reduce only')}</label>
      <label className="dhl-ticket-check"><input type="checkbox" checked={withTargets} onChange={(e) => setWithTargets(e.target.checked)} />{tr('止盈 / 止损', 'Take profit / Stop loss')}</label>
      {withTargets ? <div className="dhl-ticket-targets">
        <label>{tr('止盈价', 'Take profit')}<input type="number" min="0" value={tp} onChange={(e) => setTp(e.target.value)} placeholder={tr('可选', 'Optional')} /></label>
        <label>{tr('止损价', 'Stop loss')}<input type="number" min="0" value={sl} onChange={(e) => setSl(e.target.value)} placeholder={tr('可选', 'Optional')} /></label>
        <p className="dhl-ticket-validation">{tr('父单未完全成交时，止盈止损尚未生效；部分成交后撤销父单会撤销子单。提交后请核对仓位与实际保护挂单。模拟盘暂不支持触发单。', 'Targets are inactive until the parent fully fills. Cancelling a partially filled parent cancels its children. Verify the final position and protection orders. Paper mode does not simulate triggers.')}</p>
      </div> : null}
      {!enabled ? <button type="button" className="dhl-ticket-enable" onClick={() => setEnabled(true)}>{tr('启用交易票据', 'Enable trade ticket')}</button>
        : <button type="button" className="dhl-ticket-submit" onClick={submit} disabled={errors.length > 0}>{tr('提交到交易会话', 'Send to trading chat')}</button>}
      {enabled && errors.length > 0 ? <div className="dhl-ticket-validation" role="status">{errors[0]}</div> : null}
      {s.accountError ? <div className="dhl-ticket-validation" role="status">{tr('账户读取失败', 'Account read failed')}：{s.accountError}</div> : null}
      <div className="dhl-ticket-summary">
        <div><span>{tr('订单价值', 'Order value')}</span><strong>{orderValue > 0 ? `${fmt(orderValue)} USDC` : '—'}</strong></div>
        <div><span>{tr('预估保证金', 'Estimated margin')}</span><strong>{orderValue > 0 ? `${fmt(orderValue / leverage)} USDC` : '—'}</strong></div>
        <div><span>{tr('参考价差', 'Reference spread')}</span><strong>{spreadPct == null ? '—' : `${spreadPct.toFixed(3)}%`}</strong></div>
        <div><span>{tr('手续费', 'Fees')}</span><strong>{tr('交易所结算', 'Charged by exchange')}</strong></div>
      </div>
      <p className="dhl-ticket-note">{tr('票据只提交交易意图。实际价格、杠杆与账户风险由会话在执行前重新核对。', 'The ticket submits a trade intent. The chat rechecks price, leverage, and account risk before execution.')}</p>
      {s.account?.mode === 'paper' ? <p className="dhl-ticket-note">{tr(s.account.simulation, 'Configured slippage and fees; depth, funding and liquidation are not simulated.')}</p> : null}
    </section>
  )
}
