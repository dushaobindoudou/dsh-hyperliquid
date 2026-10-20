/** Exchange-aggregated L2 depth. Full precision stays available to risk checks. */
import * as React from 'react'
import { Select } from './select'
import { t, tr } from '../remote'
import { fmt, fmtPrice } from '../format'
import { loadSnapshot, saveSessionWorkspace } from '../data'
import { store, useStore } from '../store'
import type { BookGrouping } from '../types'

interface Level { px: string; sz: number; total: number }

const GROUPINGS: Array<[BookGrouping, number | null]> = [
  ['full', null], ['5', 1], ['5x2', 2], ['5x5', 5], ['4', 10], ['3', 100], ['2', 1000],
]

function exchangePrice(value: string): string {
  const match = value.match(/^(\d+)(?:\.(\d+))?$/)
  if (!match) return fmtPrice(value)
  return Number(match[1]).toLocaleString('en-US') + (match[2] ? `.${match[2]}` : '')
}

function stepLabel(value: number): string {
  if (value < 1e-12) return value.toExponential(0)
  return Number(value.toPrecision(2)).toLocaleString('en-US', { maximumFractionDigits: 12 })
}

export function BookCard({ snapshot }: { snapshot: any }) {
  const s = useStore()
  const coin = s.activeCoin
  const grouping = s.bookGrouping
  const rawBook = snapshot?.coin === coin ? snapshot.book : null
  const rawBid = Number(rawBook?.levels?.[0]?.[0]?.px)
  const rawAsk = Number(rawBook?.levels?.[1]?.[0]?.px)
  const reference = rawBid > 0 && rawAsk > 0 ? (rawBid + rawAsk) / 2 : rawBid || rawAsk || 1
  const baseStep = 10 ** (Math.floor(Math.log10(reference)) - 4)
  const selectedBook = grouping === 'full' ? rawBook
    : snapshot?.coin === coin && snapshot?.bookGrouping === grouping && Date.now() - Number(snapshot?.observedAt?.groupedBook) < 10_000
      ? snapshot.groupedBook : null

  const levels = (side: 0 | 1): Level[] => {
    const entries = (selectedBook?.levels?.[side] ?? []) as Array<{ px: string; sz: string }>
    let total = 0
    return entries.slice(0, 10).flatMap((entry) => {
      const px = Number(entry.px); const sz = Number(entry.sz)
      if (!(px > 0 && sz > 0 && Number.isFinite(px) && Number.isFinite(sz))) return []
      total += sz
      return [{ px: String(entry.px), sz, total }]
    })
  }
  const bids = levels(0)
  const asks = levels(1)
  const maxTotal = Math.max(1, ...bids.map((l) => l.total), ...asks.map((l) => l.total))
  const mid = Number(snapshot?.mids?.mids?.[coin] ?? snapshot?.mids?.[coin]) || reference
  const spread = rawAsk > 0 && rawBid > 0 ? rawAsk - rawBid : null

  const chooseGrouping = (next: BookGrouping) => {
    if (next === grouping) return
    store.patch({ bookGrouping: next })
    saveSessionWorkspace({ bookGrouping: next })
    void loadSnapshot()
  }
  const row = (level: Level, side: 'bid' | 'ask') => (
    <div className="dhl-lvl" key={`${side}:${level.px}`}>
      <div className={'bar ' + side} style={{ width: `${(level.total / maxTotal) * 100}%` }} />
      <button type="button" className="px"
        style={{ color: side === 'bid' ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)' }}
        title={t('book.clickHint', '填入右侧限价单票据')}
        onClick={() => store.patch({ ticketDraft: { coin, isBuy: side === 'bid', px: level.px, at: Date.now() } })}>
        {exchangePrice(level.px)}
      </button>
      <span>{fmt(level.sz, 4)}</span>
      <span style={{ color: 'var(--dsw-alias-label-secondary)' }}>{fmt(level.total, 3)}</span>
    </div>
  )

  return <div className="dhl-card">
    <h4>{t('book.title', '盘口')}</h4>
    <div className="dhl-book-options">
      <label>{tr('价格档位', 'Price grouping')} <Select aria-label={tr('盘口价格档位', 'Order book price grouping')} value={grouping} onChange={(event) => chooseGrouping(event.target.value as BookGrouping)}>
        {GROUPINGS.map(([key, factor]) => <option key={key} value={key}>{factor == null ? tr('原始', 'Full') : stepLabel(baseStep * factor)}</option>)}
      </Select></label>
      <span>{coin}</span>
    </div>
    {asks.length === 0 && bids.length === 0
      ? <div className="dhl-book-wait">{grouping === 'full' ? t('book.waiting', '等待上游行情…') : tr('正在读取交易所聚合盘口…', 'Loading grouped order book…')}</div>
      : <>
        <div className="dhl-lvl dhl-bookhead"><span>{t('book.price', '价格')}</span><span>{t('book.size', '数量')}</span><span>{t('book.total', '累计')}</span></div>
        {asks.slice().reverse().map((level) => row(level, 'ask'))}
        <div className="dhl-spread-row"><span>{t('book.spread', '价差')}</span><strong>{spread != null ? fmtPrice(spread) : '—'}</strong><span>{spread != null && mid ? `${((spread / mid) * 100).toFixed(3)}%` : '—'}</span></div>
        {bids.map((level) => row(level, 'bid'))}
      </>}
  </div>
}
