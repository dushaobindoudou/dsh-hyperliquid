import * as React from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { drawingGeometry } from '../../../lib/chart-drawings.js'
import { geometryPatch, isTextKind, markPoints, toolOf } from '../drawing-tools'
import { tr } from '../remote'
import type { ChartMark } from '../types'

function localDate(time: number): string {
  const date = new Date(time)
  return new Date(time - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 23)
}

/** Exact time/price entry uses the same geometry validator as the host. */
export function DrawingEditor({ mark, onApply, onClose }: { mark: ChartMark; onApply: (patch: Record<string, unknown>) => void; onClose: () => void }) {
  const [label, setLabel] = React.useState(mark.label)
  const [anchors, setAnchors] = React.useState(() => markPoints(mark).map((point) => ({ time: localDate(point.time), price: String(point.price) })))
  const [error, setError] = React.useState('')
  const update = (index: number, key: 'time' | 'price', value: string) => setAnchors((rows) => rows.map((row, at) => at === index ? { ...row, [key]: value } : row))
  const apply = () => {
    try {
      if (!label.trim()) throw new Error(tr('请输入名称或文本', 'Enter a name or text'))
      const points = anchors.map((row) => ({ time: new Date(row.time).getTime(), price: Number(row.price) }))
      const geometry = drawingGeometry(mark.kind, geometryPatch(mark.kind, points))
      onApply({ ...geometry, label: label.trim() })
      onClose()
    } catch (problem) { setError(String((problem as Error).message ?? problem)) }
  }
  return <Modal open onClose={onClose} title={`${tr(toolOf(mark.kind).zh, toolOf(mark.kind).en)} · ${tr('坐标与名称', 'Coordinates & name')}`} closeLabel={tr('关闭', 'Close')} className="dhl-coordinate-modal"
    footer={<><Button variant="outline" onClick={onClose}>{tr('取消', 'Cancel')}</Button><Button variant="primary" onClick={apply}>{tr('应用坐标', 'Apply coordinates')}</Button></>}>
    <form className="dhl-coordinate-editor" onSubmit={(event) => { event.preventDefault(); apply() }}>
      <label>{tr('名称 / 文本', 'Name / text')}<Input aria-label={tr('画线名称', 'Drawing name')} value={label} readOnly={mark.kind === 'icon'} maxLength={isTextKind(mark.kind) ? 200 : 60} onChange={(event) => setLabel(event.target.value)} /></label>
      <small>{tr('时间采用本地时区', 'Times use your local timezone')} · {Intl.DateTimeFormat().resolvedOptions().timeZone}</small>
      <div className="dhl-coordinate-anchors">
        {anchors.map((row, index) => <fieldset key={index}>
          <legend>{tr(`锚点 ${index + 1}`, `Anchor ${index + 1}`)}</legend>
          {mark.kind !== 'level' ? <label>{tr('时间', 'Time')}<Input type="datetime-local" step="0.001" value={row.time} aria-label={tr(`锚点 ${index + 1} 时间`, `Anchor ${index + 1} time`)} onChange={(event) => update(index, 'time', event.target.value)} required /></label> : null}
          <label>{tr('价格', 'Price')}<Input type="number" step="any" min="0" value={row.price} aria-label={tr(`锚点 ${index + 1} 价格`, `Anchor ${index + 1} price`)} onChange={(event) => update(index, 'price', event.target.value)} required /></label>
        </fieldset>)}
      </div>
      {error ? <p role="alert" className="dhl-inline-error">{error}</p> : null}
    </form>
  </Modal>
}
