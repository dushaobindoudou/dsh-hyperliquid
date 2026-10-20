/** Object tree for the chart's drawings: select / focus, show-hide, lock and delete each one. */
import * as React from 'react'
import { tr } from '../remote'
import type { ChartMark } from '../types'
import { ToolIcon, toolOf } from '../drawing-tools'
import { UiIcon } from './panel-icons'


export const DrawingList = React.memo(function DrawingList({ marks, locked, onSelect, onEdit, onRemove, language }: {
  language: string
  marks: ChartMark[]; locked: boolean; onSelect: (id: string) => void; onEdit: (id: string, patch: Record<string, unknown>) => void; onRemove: (id: string) => void
}) {
  // A popover over the content below (it used to open in the page flow and push the chart controls down).
  // Starts closed; closes on an outside press or Esc, and after picking a drawing (so it does not cover it);
  // show / lock / delete keep it open. Opens upward when there is no room below.
  const [open, setOpen] = React.useState(false)
  const [up, setUp] = React.useState(false)
  const root = React.useRef<HTMLElement>(null)
  const toggle = () => setOpen((value) => {
    if (!value && root.current) {
      const rect = root.current.getBoundingClientRect(), below = window.innerHeight - rect.bottom
      setUp(below < 240 && rect.top > below)
    }
    return !value
  })
  React.useEffect(() => {
    if (!open) return undefined
    const onPointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false) } }
    window.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('pointerdown', onPointer, true); window.removeEventListener('keydown', onKey, true) }
  }, [open])
  const hidden = marks.filter((mark) => mark.hidden).length
  return (
    <section ref={root} className={'dhl-drawing-list' + (open ? ' open' : '') + (open && up ? ' up' : '')} lang={language} aria-label={tr('画线列表', 'Drawings')}>
      <button type="button" className="dhl-drawing-list-head" aria-expanded={open} onClick={toggle}>
        <span>{tr('画线', 'Drawings')} {marks.length}{hidden ? tr(` · 隐藏 ${hidden}`, ` · ${hidden} hidden`) : ''}</span>
        <UiIcon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
      </button>
      {open ? <ul>
        {marks.map((mark) => {
          const tool = toolOf(mark.kind)
          return <li key={mark.id} data-mark-id={mark.id} className={mark.hidden ? 'is-hidden' : ''}>
            <button type="button" className="dhl-drawing-list-name" title={tr('在图上定位并选中', 'Find and select on the chart')} onClick={() => { onSelect(mark.id); setOpen(false) }} disabled={mark.hidden}>
              <span style={{ color: mark.color }}><ToolIcon kind={mark.kind} size={14} /></span>
              <b>{mark.label}</b>
              <small>{mark.alert ? <span className="dhl-list-flag" title={tr('价格提醒已开启', 'Price alert armed')}><UiIcon name="bell" size={12} /></span> : null}{mark.shared ? <span className="dhl-list-flag" title={tr('已同步到所有会话', 'Synced to all sessions')}><UiIcon name="sync" size={12} /></span> : null}{tr(tool.zh, tool.en)} · {mark.interval}{mark.visibleIntervals?.length ? tr(` · 仅 ${mark.visibleIntervals.join('/')} 显示`, ` · ${mark.visibleIntervals.join('/')} only`) : ''}{mark.source === 'agent' ? ' · agent' : ''}</small>
            </button>
            <button type="button" aria-pressed={!mark.hidden} title={mark.hidden ? tr('显示', 'Show') : tr('隐藏', 'Hide')} aria-label={`${mark.hidden ? tr('显示', 'Show') : tr('隐藏', 'Hide')} ${mark.label}`} onClick={() => onEdit(mark.id, { hidden: !mark.hidden })}>
              <UiIcon name={mark.hidden ? 'eyeOff' : 'eye'} size={14} />
            </button>
            <button type="button" className={mark.locked ? 'on' : ''} aria-pressed={Boolean(mark.locked)} disabled={locked} title={mark.locked ? tr('解锁', 'Unlock') : tr('锁定', 'Lock')} aria-label={`${mark.locked ? tr('解锁', 'Unlock') : tr('锁定', 'Lock')} ${mark.label}`} onClick={() => onEdit(mark.id, { locked: !mark.locked })}>
              <UiIcon name={mark.locked ? 'lock' : 'unlock'} size={14} />
            </button>
            <button type="button" disabled={locked || mark.locked} title={tr('删除', 'Delete')} aria-label={`${tr('删除画线', 'Remove line')} ${mark.label}`} onClick={() => onRemove(mark.id)}><UiIcon name="trash" size={14} /></button>
          </li>
        })}
      </ul> : null}
    </section>
  )
})
