import * as React from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { normalizeIndicatorSettings, type IndicatorSettings } from '../../../lib/studies.js'
import { hyperCall, tr } from '../remote'
import type { SessionWorkspace, MaLine } from '../types'
import type { IndicatorId } from '../chart-indicators'
import { Select } from './select'
import { UiIcon } from './panel-icons'

type Template = { id: string; name: string; indicators: IndicatorId[]; indicatorSettings: IndicatorSettings; maLines: MaLine[] }
const SECTIONS = [
  ['rsi', 'RSI', [['period', '周期', 'Length'], ['lower', '下阈值', 'Lower'], ['upper', '上阈值', 'Upper']]],
  ['macd', 'MACD', [['fast', '快线', 'Fast'], ['slow', '慢线', 'Slow'], ['signal', '信号线', 'Signal']]],
  ['bollinger', 'BOLL', [['period', '周期', 'Length'], ['multiplier', '标准差倍数', 'Std. deviations']]],
  ['stochastic', 'Stochastic', [['period', '%K 周期', '%K length'], ['smoothK', '%K 平滑', '%K smoothing'], ['smoothD', '%D 周期', '%D length'], ['lower', '下阈值', 'Lower'], ['upper', '上阈值', 'Upper']]],
  ['adx', 'ADX / DMI', [['period', 'DI 周期', 'DI length'], ['smoothing', 'ADX 平滑', 'ADX smoothing']]],
] as const

export function IndicatorEditor({ settings, indicators, maLines, onApply }: { settings?: IndicatorSettings; indicators: IndicatorId[]; maLines: MaLine[]; onApply: (patch: Partial<SessionWorkspace>) => void }) {
  const [open, setOpen] = React.useState(false)
  const [draft, setDraft] = React.useState<Record<string, Record<string, string>>>({})
  const [active, setActive] = React.useState(indicators)
  const [lines, setLines] = React.useState(maLines)
  const [templates, setTemplates] = React.useState<Template[]>([])
  const [selected, setSelected] = React.useState('')
  const [name, setName] = React.useState('')
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const populate = (value?: IndicatorSettings) => setDraft(Object.fromEntries(Object.entries(normalizeIndicatorSettings(value)).map(([section, fields]) => [section, Object.fromEntries(Object.entries(fields).map(([key, n]) => [key, String(n)]))])))
  React.useEffect(() => {
    if (!open) return
    populate(settings); setActive(indicators); setLines(maLines); setSelected(''); setName(''); setError('')
    let cancelled = false
    void hyperCall('indicatorTemplates', { action: 'list' }).then((result) => { if (!cancelled) setTemplates(result.templates) }).catch((cause) => { if (!cancelled) setError(String(cause.message ?? cause)) })
    return () => { cancelled = true }
  }, [open])
  const values = () => normalizeIndicatorSettings(Object.fromEntries(Object.entries(draft).map(([section, fields]) => [section, Object.fromEntries(Object.entries(fields).map(([key, n]) => [key, n.trim() ? Number(n) : NaN]))])))
  const apply = () => {
    try { onApply({ indicatorSettings: values(), indicators: active, maLines: lines }); setOpen(false) } catch (cause) { setError(String((cause as Error).message)) }
  }
  const save = async (overwrite = false) => {
    setError(''); setBusy(true)
    try {
      const result = await hyperCall('indicatorTemplates', { action: 'save', name, ...(overwrite ? { id: selected } : {}), indicators: active, maLines: lines, indicatorSettings: values() })
      setTemplates(result.templates); setSelected(result.template.id)
    } catch (cause) { setError(String((cause as Error).message)) } finally { setBusy(false) }
  }
  return <>
    <button className="dhl-indicator-settings-trigger" type="button" onClick={() => setOpen(true)}><UiIcon name="settings" size={14} />{tr('参数与模板', 'Settings & templates')}</button>
    <Modal open={open} onClose={() => setOpen(false)} title={tr('指标参数与模板', 'Indicator settings & templates')} closeLabel={tr('关闭', 'Close')} className="dhl-indicator-settings-modal"
      footer={<><Button variant="outline" onClick={() => populate()}>{tr('默认参数', 'Default parameters')}</Button><Button variant="primary" onClick={apply}>{tr('应用指标设置', 'Apply indicator settings')}</Button></>}>
      <div className="dhl-study-settings">
        <section className="dhl-study-template">
          <strong>{tr('指标模板', 'Indicator templates')}</strong>
          <small>{tr('模板包含已启用指标、全部参数与自定义均线；保存到宿主，可跨会话使用。', 'Templates include enabled studies, parameters and custom MAs, saved on the host for reuse across sessions.')}</small>
          <Select aria-label={tr('已保存指标模板', 'Saved indicator templates')} value={selected} onChange={(event) => {
            const id = event.target.value; setSelected(id); setError('')
            const template = templates.find((row) => row.id === id)
            if (template) { populate(template.indicatorSettings); setActive(template.indicators); setLines(template.maLines); setName(template.name) }
          }}><option value="">{tr('选择模板', 'Select template')}</option>{templates.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</Select>
          <Input aria-label={tr('指标模板名称', 'Indicator template name')} value={name} maxLength={60} placeholder={tr('模板名称', 'Template name')} onChange={(event) => setName(event.target.value)} />
          <div className="dhl-study-template-actions">
            <Button variant="outline" disabled={busy || !name.trim()} onClick={() => void save()}>{tr('另存模板', 'Save new')}</Button>
            <Button variant="outline" disabled={busy || !selected || !name.trim()} onClick={() => void save(true)}>{tr('更新模板', 'Update')}</Button>
            <Button variant="outline" disabled={busy || !selected} onClick={() => { setBusy(true); void hyperCall('indicatorTemplates', { action: 'remove', id: selected }).then((result) => { setTemplates(result.templates); setSelected('') }).catch((cause) => setError(String(cause.message))).finally(() => setBusy(false)) }}>{tr('删除模板', 'Delete')}</Button>
          </div>
        </section>
        <div className="dhl-study-parameter-grid">
          {SECTIONS.map(([section, title, fields]) => <fieldset key={section}><legend>{title}</legend>{fields.map(([key, zh, en]) => <label key={key}>{tr(zh, en)}<Input type="number" step={key === 'multiplier' ? 'any' : 1} aria-label={`${title} ${tr(zh, en)}`} value={draft[section]?.[key] ?? ''} onChange={(event) => setDraft((current) => ({ ...current, [section]: { ...current[section], [key]: event.target.value } }))} /></label>)}</fieldset>)}
        </div>
        {error ? <p className="dhl-inline-error" role="alert">{error}</p> : null}
      </div>
    </Modal>
  </>
}
