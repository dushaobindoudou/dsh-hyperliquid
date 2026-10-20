/**
 * dsh-hyperliquid — recent trades tape (view-only).
 * Buys green / sells red, newest on top.
 * @module src/client/components/trades-card
 */

import * as React from 'react'
import { t, tr as localize } from '../remote'
import { fmt, fmtPrice } from '../format'

export function TradesCard({ snapshot }: { snapshot: any }) {
  const trades = (Array.isArray(snapshot?.trades) ? snapshot.trades : []).slice(0, 24)
  return (
    <div className="dhl-card">
      <h4>{t('trades.title', '最近成交')}</h4>
      <div className="dhl-lvl dhl-bookhead"><span>{t('book.price', '价格')}</span><span>{t('book.size', '数量')}</span><span>{localize('时间', 'Time')}</span></div>
      {trades.length === 0
        ? <div style={{ color: 'var(--dsw-alias-label-secondary)', fontSize: 11 }}>—</div>
        : trades.map((tr: any, i: number) => (
          <div className="dhl-lvl" key={i} style={{ position: 'relative' }}>
            <span style={{ color: tr.side === 'B' ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)' }}>
              {fmtPrice(tr.px)}
            </span>
            <span style={{ color: 'var(--dsw-alias-label-secondary)' }}>{fmt(tr.sz, 4)}</span>
            <span style={{ color: 'var(--dsw-alias-label-secondary)' }}>
              {Number.isFinite(Number(tr.time)) ? new Date(Number(tr.time)).toLocaleTimeString(localize('zh-CN', 'en-US'), { hour12: false }) : '—'}
            </span>
          </div>
        ))}
    </div>
  )
}
