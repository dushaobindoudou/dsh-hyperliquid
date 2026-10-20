import * as React from 'react'
import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { tr } from '../remote'
import type { ChartAction } from '../chart-basics'
import { UiIcon } from './panel-icons'

export function ChartNavigation({ onNavigate, onCsv, disabled }: { onNavigate: (action: ChartAction) => void; onCsv: () => void; disabled: boolean }) {
  const [date, setDate] = React.useState('')
  const dateMenu = React.useRef<HTMLDetailsElement>(null)
  const exportMenu = React.useRef<HTMLDetailsElement>(null)
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const go = (event: React.FormEvent) => {
    event.preventDefault()
    const time = new Date(date).getTime()
    if (!Number.isFinite(time)) return
    onNavigate({ kind: 'date', time }); dateMenu.current?.removeAttribute('open')
  }
  return <div className="dhl-chart-navigation" aria-label={tr('图表导航', 'Chart navigation')}>
    <div className="dhl-chart-ranges" role="group" aria-label={tr('显示时间范围', 'Visible time range')}>
      {([['1D', 1], ['5D', 5], ['1M', 30]] as const).map(([name, days]) => <button key={name} type="button" disabled={disabled} title={tr(`查看最近 ${days} 天`, `Show the last ${days} days`)} onClick={() => onNavigate({ kind: 'range', duration: days * 86_400_000 })}>{name}</button>)}
      <button type="button" disabled={disabled} title={tr('适应已加载的全部 K 线', 'Fit all loaded candles')} onClick={() => onNavigate({ kind: 'fit' })}>{tr('全部', 'All')}</button>
    </div>
    <details ref={dateMenu} className="dhl-chart-footer-menu">
      <summary aria-label={tr('跳转到日期', 'Go to date')} title={tr('跳转到日期', 'Go to date')}><UiIcon name="calendar" size={15} /></summary>
      <form className="dhl-chart-date-form" onSubmit={go}>
        <label htmlFor="dhl-chart-date">{tr('跳转到日期', 'Go to date')}</label>
        <small>{tr('本地时间', 'Local time')} · {zone}</small>
        <Input id="dhl-chart-date" type="datetime-local" step="60" value={date} onChange={(event) => setDate(event.target.value)} required />
        <button type="submit" disabled={disabled || !date}>{tr('定位 K 线', 'Find candle')}</button>
        <small>{tr('超出已加载范围时会补取历史数据，受交易所历史上限限制。', 'Earlier data is loaded as needed, up to the exchange history limit.')}</small>
      </form>
    </details>
    <button type="button" className="dhl-chart-live" disabled={disabled} onClick={() => onNavigate({ kind: 'live' })}><UiIcon name="live" size={14} />{tr('回到最新', 'Latest')}</button>
    <span className="dhl-chart-footer-spacer" />
    <details ref={exportMenu} className="dhl-chart-footer-menu">
      <summary aria-label={tr('导出图表', 'Export chart')} title={tr('导出图表', 'Export chart')}><UiIcon name="download" size={15} />{tr('导出', 'Export')}</summary>
      <div className="dhl-chart-export-menu">
        <button type="button" disabled={disabled} onClick={() => { onNavigate({ kind: 'snapshot' }); exportMenu.current?.removeAttribute('open') }}><UiIcon name="camera" size={15} />{tr('图片 PNG（含画线）', 'PNG image with drawings')}</button>
        <button type="button" disabled={disabled} onClick={() => { onCsv(); exportMenu.current?.removeAttribute('open') }}><UiIcon name="download" size={15} />{tr('已加载 K 线 CSV', 'Loaded candles as CSV')}</button>
      </div>
    </details>
    <details className="dhl-chart-footer-menu">
      <summary aria-label={tr('图表操作帮助', 'Chart shortcuts')} title={tr('图表操作帮助', 'Chart shortcuts')}><UiIcon name="help" size={15} /></summary>
      <div className="dhl-chart-shortcuts">
        <strong>{tr('图表操作', 'Chart controls')}</strong>
        {[[tr('移动 / 缩放', 'Pan / Zoom'), tr('拖动 / 滚轮', 'Drag / Wheel')], [tr('撤销 / 重做', 'Undo / Redo'), 'Ctrl/⌘ Z · Shift Ctrl/⌘ Z'], [tr('复制 / 粘贴画线', 'Copy / Paste drawing'), 'Ctrl/⌘ C · Ctrl/⌘ V'], [tr('删除选中画线', 'Delete drawing'), 'Delete / Backspace'], [tr('水平约束', 'Horizontal constraint'), 'Shift'], [tr('取消绘制 / 选择', 'Cancel drawing / selection'), 'Esc'], [tr('搜索标的', 'Search symbols'), '/']].map(([label, key]) => <div key={label}><span>{label}</span><kbd>{key}</kbd></div>)}
      </div>
    </details>
  </div>
}
