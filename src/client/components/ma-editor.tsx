/** Moving-average lines for the session chart: presets, a custom line form, and removal. */
import * as React from 'react'
import { Select } from './select'
import { tr } from '../remote'
import { notify } from '../store'
import { MA_KINDS, MA_MAX_LINES, MA_SOURCES, maLabel, normalizeMaLine, type MaKind, type MaLine, type MaSource } from '../../../lib/moving-average.js'
import { maColor } from './candle-chart'
import { UiIcon } from './panel-icons'

const KIND_NAMES: Record<MaKind, [string, string]> = {
  sma: ['SMA', 'SMA'], ema: ['EMA', 'EMA'], smma: ['SMMA 平滑', 'SMMA (RMA)'], wma: ['WMA', 'WMA'],
}
const PRESETS: Array<Pick<MaLine, 'kind' | 'period'>> = [
  { kind: 'smma', period: 7 }, { kind: 'smma', period: 21 }, { kind: 'smma', period: 50 }, { kind: 'ema', period: 200 },
]

export function MaEditor({ lines, onChange }: { lines: MaLine[]; onChange: (next: MaLine[]) => void }) {
  const [kind, setKind] = React.useState<MaKind>('smma')
  const [period, setPeriod] = React.useState('21')
  const [source, setSource] = React.useState<MaSource>('close')
  const [smoothKind, setSmoothKind] = React.useState<MaKind | ''>('')
  const [smoothPeriod, setSmoothPeriod] = React.useState('9')

  const add = (input: unknown) => {
    let line: MaLine
    try { line = normalizeMaLine(input) } catch (error) { notify(String((error as Error)?.message ?? error)); return }
    const rest = lines.filter((item) => item.id !== line.id)
    if (rest.length >= MA_MAX_LINES) { notify(tr(`最多同时显示 ${MA_MAX_LINES} 条均线`, `At most ${MA_MAX_LINES} moving averages`)); return }
    onChange([...rest, line])
  }

  return (
    <div className="dhl-ma-editor">
      <strong>{tr('均线', 'Moving averages')}</strong>
      {lines.length ? <ul className="dhl-ma-list">
        {lines.map((line, index) => <li key={line.id}>
          <i style={{ background: maColor(line, index) }} aria-hidden="true" />
          <span>{maLabel(line)}</span>
          <button type="button" aria-label={`${tr('移除', 'Remove')} ${maLabel(line)}`} onClick={() => onChange(lines.filter((item) => item.id !== line.id))}><UiIcon name="close" size={12} /></button>
        </li>)}
      </ul> : null}
      <div className="dhl-ma-presets">
        {PRESETS.map((preset) => {
          const id = `${preset.kind}${preset.period}`
          return <button type="button" key={id} disabled={lines.some((line) => line.id === id)} onClick={() => add(preset)}>{`${preset.kind.toUpperCase()} ${preset.period}`}</button>
        })}
      </div>
      <div className="dhl-ma-form">
        <Select aria-label={tr('均线类型', 'MA type')} value={kind} onChange={(event) => setKind(event.target.value as MaKind)}>
          {MA_KINDS.map((item) => <option key={item} value={item}>{tr(KIND_NAMES[item][0], KIND_NAMES[item][1])}</option>)}
        </Select>
        <input aria-label={tr('周期', 'Length')} type="number" min={1} max={500} value={period} onChange={(event) => setPeriod(event.target.value)} />
        <Select aria-label={tr('价格源', 'Source')} value={source} onChange={(event) => setSource(event.target.value as MaSource)}>
          {MA_SOURCES.map((item) => <option key={item} value={item}>{item}</option>)}
        </Select>
      </div>
      <div className="dhl-ma-form">
        <Select aria-label={tr('平滑', 'Smoothing')} value={smoothKind} onChange={(event) => setSmoothKind(event.target.value as MaKind | '')}>
          <option value="">{tr('不平滑', 'No smoothing')}</option>
          {MA_KINDS.map((item) => <option key={item} value={item}>{tr('平滑：', 'Smooth: ') + item.toUpperCase()}</option>)}
        </Select>
        <input aria-label={tr('平滑周期', 'Smoothing length')} type="number" min={1} max={500} value={smoothPeriod} disabled={!smoothKind} onChange={(event) => setSmoothPeriod(event.target.value)} />
        <button type="button" className="dhl-ma-add" onClick={() => add({ kind, period: Number(period), source, smoothing: smoothKind ? { kind: smoothKind, period: Number(smoothPeriod) } : null })}>{tr('添加', 'Add')}</button>
      </div>
    </div>
  )
}
