import * as React from 'react'
import type { Candle, Interval } from '../types'
import { tr } from '../remote'
import { queueToAgent } from '../data'
import { evaluateStrategyStudies, type StrategyState } from '../strategy-theories'
import { UiIcon } from './panel-icons'

const STATE_LABELS: Record<StrategyState, [string, string]> = {
  candidate: ['条件出现', 'Conditions met'], watch: ['待观察', 'Watch'],
  stale: ['数据过期', 'Stale data'], insufficient: ['数据不足', 'Insufficient data'],
}

export function StrategyMenu({ candles, coin, interval }: { candles: Candle[]; coin: string; interval: Interval }) {
  const menu = React.useRef<HTMLDetailsElement>(null)
  const english = tr('zh', 'en') === 'en'
  const studies = React.useMemo(() => evaluateStrategyStudies(candles, coin, interval, Date.now(), english), [candles, coin, interval, english])
  return <details className="dhl-strategy-menu" ref={menu}>
    <summary>{tr('策略框架', 'Strategies')}<UiIcon name="chevronDown" size={12} /></summary>
    <div className="dhl-strategy-popover" role="group" aria-label={tr('交易策略研究', 'Trading strategy studies')}>
      <header>
        <strong>{tr('策略研究 · 已收盘 K 线', 'Strategy studies · closed candles')}</strong>
        <small>{coin} · {interval}</small>
      </header>
      <p className="dhl-strategy-caveat">{tr('这些条件用于组织分析，未在本市场和周期验证收益；需要核对更高周期、盘口、资金费和交易成本。',
        'These conditions structure analysis; returns are unverified for this market and interval. Check higher timeframe, book, funding and costs.')}</p>
      {studies.map((study) => <section className="dhl-strategy-card" key={study.id}>
        <div className="dhl-strategy-card-head"><b>{study.title}</b><span className={`state-${study.state}`}>{tr(...STATE_LABELS[study.state])}</span></div>
        <p>{study.summary}</p>
        {study.evidence.map((item) => <small key={item}>{item}</small>)}
        {study.evidence.length ? <small>{tr('失效：', 'Invalidation: ')}{study.invalidation}</small> : null}
        <div className="dhl-strategy-card-actions">
          <a href={study.source} target="_blank" rel="noopener noreferrer">{tr('理论来源', 'Source')}</a>
          <button type="button" disabled={study.state === 'stale' || study.state === 'insufficient'} onClick={() => {
            if (queueToAgent(study.prompt)) menu.current?.removeAttribute('open')
          }}>{tr('请 Agent 核对', 'Ask agent to verify')}</button>
        </div>
      </section>)}
    </div>
  </details>
}
