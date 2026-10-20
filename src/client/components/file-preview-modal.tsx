/** Desk-owned file preview: the fallback for file links the shipped sidebar cannot open. */

import * as React from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { tr } from '../remote'
import { closeFilePreview, useFilePreview } from '../file-preview'

/**
 * Render the desk file preview modal when a file link was routed here.
 * @returns the modal, or null while no file is being shown.
 */
export function FilePreviewModal(): React.ReactElement | null {
  const s = useFilePreview()
  const targetLineRef = React.useRef<HTMLElement | null>(null)
  const targetLine = s.target?.line

  React.useEffect(() => {
    if (s.status !== 'ready' || targetLineRef.current === null) return
    targetLineRef.current.scrollIntoView({ block: 'center' })
  }, [s.status, targetLine])

  if (!s.open) return null
  const path = s.target?.path ?? ''
  return (
    <Modal
      open
      onClose={closeFilePreview}
      title={path}
      closeLabel={tr('关闭', 'Close')}
      className="dhl-file-modal"
      contentClassName="dhl-file-content"
    >
      {s.status === 'loading' ? <p className="dhl-file-note">{tr('正在读取文件…', 'Reading file…')}</p> : null}
      {s.status === 'error' ? <p className="dhl-file-note dhl-file-error">{s.error}</p> : null}
      {s.status === 'ready'
        ? (
          <pre className="dhl-file-text">
            {s.text.split('\n').map((line, index) => {
              const number = index + 1
              const active = number === targetLine
              return (
                <span
                  key={number}
                  ref={active ? (node) => { targetLineRef.current = node } : undefined}
                  className={active ? 'dhl-file-line dhl-file-line-active' : 'dhl-file-line'}
                >
                  <span className="dhl-file-gutter">{number}</span>
                  <span className="dhl-file-code">{line}</span>
                </span>
              )
            })}
          </pre>
        )
        : null}
      {s.status === 'ready' ? (
        <p className="dhl-file-meta">
          {tr(`共 ${s.lines} 行`, `${s.lines} lines`)}
          {s.eof ? '' : tr('（已截断）', ' (truncated)')}
        </p>
      ) : null}
    </Modal>
  )
}
