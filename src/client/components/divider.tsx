/** Draggable resize handle between visible workbench columns. */
import * as React from 'react'
import { tr } from '../remote'

interface DividerProps {
  side: 'left' | 'right'
  onResize: (deltaPx: number) => void
  onCommit: () => void
  onReset?: () => void
}

export function Divider({ side, onResize, onCommit, onReset }: DividerProps) {
  const [dragging, setDragging] = React.useState(false)
  const node = React.useRef<HTMLDivElement | null>(null)
  const drag = React.useRef<{ pointerId: number; startX: number; applied: number } | null>(null)

  const finish = React.useCallback(() => {
    const active = drag.current
    if (!active) return
    drag.current = null
    const element = node.current
    if (element?.hasPointerCapture(active.pointerId)) {
      try { element.releasePointerCapture(active.pointerId) } catch { /* capture already gone */ }
    }
    setDragging(false)
    onCommit()
  }, [onCommit])

  React.useEffect(() => {
    if (!dragging) return undefined
    const endPointer = (event: PointerEvent) => {
      if (event.pointerId === drag.current?.pointerId) finish()
    }
    const endVisibility = () => { if (document.hidden) finish() }
    window.addEventListener('pointerup', endPointer)
    window.addEventListener('pointercancel', endPointer)
    window.addEventListener('blur', finish)
    document.addEventListener('visibilitychange', endVisibility)
    return () => {
      window.removeEventListener('pointerup', endPointer)
      window.removeEventListener('pointercancel', endPointer)
      window.removeEventListener('blur', finish)
      document.removeEventListener('visibilitychange', endVisibility)
    }
  }, [dragging, finish])

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || drag.current) return
    event.preventDefault()
    drag.current = { pointerId: event.pointerId, startX: event.clientX, applied: 0 }
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* window listeners still finish the drag */ }
    setDragging(true)
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const active = drag.current
    if (!active || event.pointerId !== active.pointerId) return
    const total = side === 'left' ? event.clientX - active.startX : active.startX - event.clientX
    const delta = total - active.applied
    if (delta !== 0) {
      active.applied = total
      onResize(delta)
    }
  }

  return <div
    ref={node}
    className={'dhl-divider' + (dragging ? ' dragging' : '')}
    onPointerDown={onPointerDown}
    onPointerMove={onPointerMove}
    onPointerUp={(event) => { if (event.pointerId === drag.current?.pointerId) finish() }}
    onPointerCancel={(event) => { if (event.pointerId === drag.current?.pointerId) finish() }}
    onLostPointerCapture={(event) => { if (event.pointerId === drag.current?.pointerId) finish() }}
    onDoubleClick={onReset}
    role="separator"
    aria-label={side === 'left' ? tr('调整会话栏宽度', 'Resize sessions') : tr('调整对话栏宽度', 'Resize chat')}
    aria-orientation="vertical"
  />
}
