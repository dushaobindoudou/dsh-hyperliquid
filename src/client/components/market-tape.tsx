import * as React from 'react'
import { tr } from '../remote'
import { saveSessionWorkspace } from '../data'
import { useStore } from '../store'
import { BookCard } from './book-card'
import { TradesCard } from './trades-card'

export function MarketTape({ snapshot }: { snapshot: any }) {
  const s = useStore()
  const tab = s.workspaceSessionId === s.activeSessionId ? s.workspace?.tapeTab ?? 'book' : 'book'
  return (
    <aside className="dhl-tape" aria-label={tr('盘口与成交', 'Order book and trades')}>
      <div className="dhl-tape-tabs" role="tablist" aria-label={tr('市场数据', 'Market data')}>
        <button type="button" role="tab" aria-selected={tab === 'book'} className={tab === 'book' ? 'on' : ''} onClick={() => saveSessionWorkspace({ tapeTab: 'book' })}>{tr('盘口', 'Order book')}</button>
        <button type="button" role="tab" aria-selected={tab === 'trades'} className={tab === 'trades' ? 'on' : ''} onClick={() => saveSessionWorkspace({ tapeTab: 'trades' })}>{tr('成交', 'Trades')}</button>
      </div>
      <div className="dhl-tape-content" role="tabpanel">
        {tab === 'book' ? <BookCard snapshot={snapshot} /> : <TradesCard snapshot={snapshot} />}
      </div>
    </aside>
  )
}
