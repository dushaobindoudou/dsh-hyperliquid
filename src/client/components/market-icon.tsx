import * as React from 'react'

type IconMarket = { name: string; label: string; kind?: 'perp' | 'hip3' | 'spot' | 'outcome' }

const ICON_ROOT = 'https://app.hyperliquid.xyz/coins/'

function iconNames(market: IconMarket): string[] {
  if (market.kind === 'outcome') return []
  const base = market.kind === 'spot' ? market.label.split('/')[0] : market.name
  // The Hyperliquid UI strips the k prefix on scaled perp symbols.
  const symbol = /^k[A-Z]/.test(base) ? base.slice(1) : base
  if (!/^[A-Za-z0-9:_-]+$/.test(symbol)) return []
  return market.kind === 'spot' ? [`${symbol}_spot`, symbol] : [symbol]
}

export function MarketIcon({ market, small = false }: { market: IconMarket; small?: boolean }) {
  const names = iconNames(market)
  const identity = `${market.kind}:${market.name}:${names.join(',')}`
  const [state, setState] = React.useState({ identity, index: 0, loaded: false })
  const current = state.identity === identity ? state : { identity, index: 0, loaded: false }
  const name = names[current.index]
  return <span className={'dhl-market-icon' + (small ? ' dhl-market-icon-small' : '')} aria-hidden="true">
    {name ? <img
      key={`${identity}:${current.index}`}
      src={`${ICON_ROOT}${encodeURIComponent(name)}.svg`}
      alt=""
      loading={small ? 'lazy' : 'eager'}
      className={current.loaded ? 'loaded' : ''}
      onLoad={() => setState({ identity, index: current.index, loaded: true })}
      onError={() => setState({ identity, index: current.index + 1, loaded: false })}
    /> : null}
  </span>
}
