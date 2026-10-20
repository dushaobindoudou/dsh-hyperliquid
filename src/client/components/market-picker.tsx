/** Hyperliquid-style market discovery over the plugin's own catalog RPC. */
import * as React from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { t, tr } from '../remote'
import { fmt, fmtPrice } from '../format'
import { loadMarketCatalog, setDeskCoin } from '../data'
import { notify, useStore } from '../store'
import type { MarketEntry } from '../types'
import { SearchIcon, UiIcon } from './panel-icons'
import { MarketIcon } from './market-icon'

type Category = 'all' | 'perp' | 'spot' | 'hip3' | 'outcome' | 'crypto' | 'tradfi' | 'preipo' | 'trending' | 'favorites'
type SortKey = 'name' | 'price' | 'change' | 'funding' | 'volume' | 'openInterest'
const CATEGORIES: Array<[Category, string]> = [
  ['all', '全部'], ['perp', '永续'], ['spot', '现货'], ['hip3', 'HIP-3'], ['outcome', 'Outcome'],
  ['crypto', 'Crypto'], ['tradfi', 'TradFi'], ['preipo', 'Pre-IPO'],
  ['trending', '热门'], ['favorites', '自选'],
]
const FAV_KEY = 'dsh-hyperliquid.favorites.v1'
const TRADFI_TAGS = new Set(['stocks', 'stock', 'equities', 'equity', 'commodities', 'indices', 'fx', 'rates', 'preipo'])

const STRICT_KEY = 'dhl.marketPicker.tradableOnly'
function readStrict(): boolean { try { return localStorage.getItem(STRICT_KEY) !== '0' } catch { return true } }
function readFavorites(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(FAV_KEY) || '[]')
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch { return [] }
}
function n(value: unknown): number { const number = Number(value); return Number.isFinite(number) ? number : 0 }
function changeOf(row: MarketEntry): number {
  const px = n(row.ctx?.markPx)
  const prev = n(row.ctx?.prevDayPx)
  return px > 0 && prev > 0 ? (px / prev - 1) * 100 : 0
}
function interestOf(row: MarketEntry): number { return n(row.ctx?.openInterest) * n(row.ctx?.markPx) }

export function MarketPicker({ activeCoin, onClose }: { activeCoin: string; onClose: () => void }) {
  const s = useStore()
  const [query, setQuery] = React.useState('')
  const [category, setCategory] = React.useState<Category>('all')
  // 可交易 / 全部 is the trader's choice: kept across categories and remembered between openings.
  const [strict, setStrictState] = React.useState(readStrict)
  const setStrict = (value: boolean) => { setStrictState(value); try { localStorage.setItem(STRICT_KEY, value ? '1' : '0') } catch { /* convenience only */ } }
  const [sort, setSort] = React.useState<SortKey>('volume')
  const [descending, setDescending] = React.useState(true)
  const [favorites, setFavorites] = React.useState<string[]>(readFavorites)
  const [cursor, setCursor] = React.useState(0)
  const [loading, setLoading] = React.useState(false)
  const [renderCount, setRenderCount] = React.useState(150)
  const searchRef = React.useRef<HTMLInputElement>(null)
  const listRef = React.useRef<HTMLDivElement>(null)
  const keyboardScroll = React.useRef(false)

  React.useEffect(() => {
    searchRef.current?.focus()
    setLoading(true)
    void loadMarketCatalog().catch((error) => notify(tr('市场目录加载失败', 'Market catalog load failed') + '：' + String(error))).finally(() => setLoading(false))
    const timer = window.setInterval(() => { void loadMarketCatalog(true).catch(() => {}) }, 5_000)
    return () => window.clearInterval(timer)
  }, [])

  const marketRows = React.useMemo<MarketEntry[]>(() => {
    const livePerps = new Map(s.markets.map((market) => [market.name, market]))
    const catalog: MarketEntry[] = s.marketCatalog.length ? s.marketCatalog.map((row) => {
      const latest = row.kind === 'perp' ? livePerps.get(row.name) : null
      return latest ? { ...row, ctx: latest.ctx } : row
    }) : s.markets.map((row): MarketEntry => ({
      name: row.name, label: `${row.name}-USDC`, kind: 'perp', venue: 'Hyperliquid',
      tradable: true, ctx: row.ctx, maxLeverage: row.maxLeverage,
    }))
    const needle = query.trim().toLocaleLowerCase()
    const rows = catalog.filter((row) => {
      if (strict && !row.tradable) return false
      if (category === 'favorites' && !favorites.includes(row.name)) return false
      if (category === 'perp' && row.kind !== 'perp') return false
      if (category === 'spot' && row.kind !== 'spot') return false
      if (category === 'hip3' && row.kind !== 'hip3') return false
      if (category === 'outcome' && row.kind !== 'outcome') return false
      const officialCategory = row.category?.toLocaleLowerCase() ?? ''
      if (category === 'crypto' && officialCategory !== 'crypto') return false
      if (category === 'tradfi' && !TRADFI_TAGS.has(officialCategory)) return false
      if (category === 'preipo' && officialCategory !== 'preipo') return false
      if (needle && !`${row.name} ${row.label} ${row.venue}`.toLocaleLowerCase().includes(needle)) return false
      return true
    })
    const value = (row: MarketEntry): number | string => {
      if (sort === 'name') return row.label
      if (sort === 'price') return n(row.ctx?.markPx)
      if (sort === 'change') return changeOf(row)
      if (sort === 'funding') return n(row.ctx?.funding)
      if (sort === 'openInterest') return interestOf(row)
      return n(row.ctx?.dayNtlVlm)
    }
    rows.sort((a, b) => {
      if (needle) {
        const rank = (row: MarketEntry) => {
          const name = row.name.toLocaleLowerCase()
          const label = row.label.toLocaleLowerCase()
          return name === needle || label === needle ? 0 : name.startsWith(needle) || label.startsWith(needle) ? 1 : 2
        }
        const relevance = rank(a) - rank(b)
        if (relevance) return relevance
      }
      const x = value(a); const y = value(b)
      const comparison = typeof x === 'string' && typeof y === 'string' ? x.localeCompare(y) : Number(x) - Number(y)
      return descending ? -comparison : comparison
    })
    if (category === 'trending' && !needle) rows.sort((a, b) => n(b.ctx?.dayNtlVlm) - n(a.ctx?.dayNtlVlm))
    return rows
  }, [s.marketCatalog, s.markets, query, category, strict, sort, descending, favorites])

  React.useEffect(() => { setCursor(0); setRenderCount(150); listRef.current?.scrollTo({ top: 0 }) }, [query, category, strict, sort, descending])
  React.useEffect(() => {
    if (cursor >= renderCount) setRenderCount(Math.ceil((cursor + 1) / 150) * 150)
  }, [cursor, renderCount])
  React.useLayoutEffect(() => {
    if (!keyboardScroll.current || cursor >= renderCount) return
    listRef.current?.querySelector<HTMLElement>(`[data-market-index="${cursor}"]`)?.scrollIntoView({ block: 'nearest' })
    keyboardScroll.current = false
  }, [cursor, renderCount])

  const choose = React.useCallback((row: MarketEntry) => {
    onClose()
    void setDeskCoin(row.name).catch(() => {})
  }, [onClose])
  const toggleFavorite = (name: string) => {
    setFavorites((prev) => {
      const next = prev.includes(name) ? prev.filter((item) => item !== name) : [...prev, name]
      try { localStorage.setItem(FAV_KEY, JSON.stringify(next)) } catch { /* private mode */ }
      return next
    })
  }
  const sortBy = (key: SortKey) => {
    if (key === sort) setDescending((value) => !value)
    else { setSort(key); setDescending(key !== 'name') }
  }
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); onClose() }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && marketRows[cursor]) {
      event.preventDefault()
      toggleFavorite(marketRows[cursor].name)
      return
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      searchRef.current?.focus()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const next = Math.max(0, Math.min(marketRows.length - 1, cursor + (event.key === 'ArrowDown' ? 1 : -1)))
      keyboardScroll.current = true
      setCursor(next)
    }
    if (event.key === 'Enter' && marketRows[cursor]) { event.preventDefault(); choose(marketRows[cursor]) }
  }
  const header = (label: string, key: SortKey) => <button type="button" onClick={() => sortBy(key)} aria-label={tr(`按${label}排序`, `Sort by ${label}`)}>
    {label}{sort === key ? <UiIcon name={descending ? 'arrowDown' : 'arrowUp'} size={12} /> : null}
  </button>

  return <Modal open onClose={onClose} title={t('market.choose', '选择市场')} headless className="dhl-picker-modal" backdropBlur onKeyDownCapture={onKeyDown}>
    <section className="dhl-picker">
      <div className="dhl-picker-top">
        <div className="dhl-picker-search"><SearchIcon /><input ref={searchRef} data-modal-autofocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('market.search', '搜索市场')} aria-label={t('market.search', '搜索市场')} /><kbd>/</kbd></div>
        <div className="dhl-picker-mode" role="group" aria-label={tr('市场范围', 'Market scope')}>
          <button type="button" className={strict ? 'on' : ''} aria-pressed={strict} onClick={() => setStrict(true)}>{t('market.tradable', '可交易')}</button>
          <button type="button" className={!strict ? 'on' : ''} aria-pressed={!strict} onClick={() => setStrict(false)}>{t('market.all', '全部')}</button>
        </div>
        <button type="button" className="dhl-picker-close" onClick={onClose} aria-label={t('modal.close', '关闭')}><UiIcon name="close" size={18} /></button>
      </div>
      {!strict ? <p className="dhl-picker-readonly-note">{tr('“只读”表示本插件仅提供行情，尚未接入该市场的下单与风控；现货与 Outcome 在 Hyperliquid 本身可交易；以 USDC 为保证金的 HIP-3 永续已可在这里交易。', '“View only” means this plugin has market data but no order and risk support for that market. Hyperliquid itself supports spot and outcome trading; USDC-collateral HIP-3 perps are tradable here.')}</p> : null}
      <nav className="dhl-picker-tabs" aria-label={tr('市场分类', 'Market categories')}>
        {CATEGORIES.map(([key, label]) => <button type="button" key={key} className={category === key ? 'on' : ''} aria-current={category === key ? 'page' : undefined} onClick={() => setCategory(key)}>{t(`market.category.${key}`, label)}</button>)}
      </nav>
      <div className="dhl-picker-tablehead">
        <UiIcon name="star" size={15} />{header(t('market.name', '市场'), 'name')}{header(t('market.price', '最新价'), 'price')}{header(t('market.change', '24h 涨跌'), 'change')}{header(t('market.funding', '资金费'), 'funding')}{header(t('market.volume', '24h 成交额'), 'volume')}{header(t('market.openInterest', '未平仓量'), 'openInterest')}
      </div>
      <div className="dhl-picker-list" role="listbox" aria-label={tr('市场列表', 'Market list')} ref={listRef} onScroll={(event) => {
        const element = event.currentTarget
        if (element.scrollTop + element.clientHeight >= element.scrollHeight - 200) setRenderCount((count) => Math.min(marketRows.length, count + 150))
      }}>
        {marketRows.slice(0, renderCount).map((row, index) => {
          const change = changeOf(row)
          return <div className={'dhl-picker-row' + (row.name === activeCoin ? ' active' : '') + (cursor === index ? ' cursor' : '')} role="option" aria-selected={row.name === activeCoin} key={`${row.kind}:${row.name}`} data-market-index={index} onMouseEnter={() => setCursor(index)}>
            <button type="button" className={'dhl-picker-star' + (favorites.includes(row.name) ? ' on' : '')} aria-label={`${favorites.includes(row.name) ? tr('取消自选', 'Remove favorite') : tr('加入自选', 'Add favorite')} ${row.label}`} onClick={() => toggleFavorite(row.name)}><UiIcon name="star" size={17} filled={favorites.includes(row.name)} /></button>
            <button type="button" className="dhl-picker-market" onClick={() => choose(row)} title={`${row.label} · ${row.name} · ${row.venue}${row.category ? ` · ${row.category}` : ''}`}><MarketIcon market={row} small /><strong>{row.label}</strong><small>{row.kind === 'perp' ? 'PERP' : row.kind === 'hip3' ? 'HIP-3' : row.kind === 'outcome' ? 'OUTCOME' : 'SPOT'}{row.name.startsWith('@') ? ` ${row.name}` : ''}{row.category ? ` · ${row.category}` : ''}{row.tradable ? '' : ` · ${tr('只读', 'View only')}`}</small></button>
            <span>{n(row.ctx?.markPx) > 0 ? fmtPrice(row.ctx.markPx) : '—'}</span>
            <span className={change > 0 ? 'dhl-up' : change < 0 ? 'dhl-down' : ''}>{n(row.ctx?.prevDayPx) > 0 ? `${change >= 0 ? '+' : ''}${change.toFixed(2)}%` : '—'}</span>
            <span>{row.ctx?.funding != null ? `${(n(row.ctx.funding) * 100).toFixed(4)}%` : '—'}</span>
            <span>{row.ctx?.dayNtlVlm != null ? '$' + fmt(row.ctx.dayNtlVlm, 0) : '—'}</span>
            <span>{row.ctx?.openInterest != null ? '$' + fmt(interestOf(row), 0) : '—'}</span>
          </div>
        })}
        {/* Empty result: also while a known catalog refreshes (otherwise the list was blank with no message). */}
        {marketRows.length === 0 && (!loading || s.marketCatalog.length > 0) ? <div className="dhl-picker-empty">{category === 'outcome' && s.status?.network === 'mainnet' ? t('market.outcomeTestnet', 'Outcome 目录目前仅在 testnet 提供。')
          : strict ? <>{tr('这个分类里没有可交易的市场（现货、Outcome 等目前只读）。', 'No tradable markets in this category (spot, outcome and some others are view only).')}
            <button type="button" className="dhl-picker-empty-action" onClick={() => setStrict(false)}>{tr('查看全部', 'Show all')}</button></>
          : t('market.empty', '没有匹配的市场')}</div> : null}
        {loading && !s.marketCatalog.length ? <div className="dhl-picker-empty">{t('market.loading', '正在读取市场目录…')}</div> : null}
      </div>
      <footer className="dhl-picker-foot"><span>{t('market.shortcuts', '↑↓ 选择　Enter 打开　⌘/Ctrl+S 自选　Esc 关闭')}</span><span>{marketRows.length} {t('market.count', '个市场')} · Hyperliquid · {s.status?.network ?? 'Hyperliquid'}</span></footer>
    </section>
  </Modal>
}
