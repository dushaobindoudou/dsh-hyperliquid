/**
 * dsh-hyperliquid — left column: trading sessions.
 *
 * Each trading session is a REAL dsh session (created through the shell
 * `sessions` service, retained while the desk shows it). The registry row
 * only tracks which coin a session is bound to.
 * @module src/client/components/sessions-column
 */

import * as React from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { getContext, hyperCall, t, tr } from '../remote'
import { relTime } from '../format'
import { getActiveRef, notify, store, useStore } from '../store'
import { loadSessions, openSession } from '../data'
import type { SessionRow } from '../types'
import { FoldIcon, UiIcon } from './panel-icons'

type ShareMode = 'private' | 'shared'
const SHARE_MODES: ReadonlyArray<readonly [ShareMode, string, string]> = [['private', '独立', 'Independent'], ['shared', '全局共享', 'Global']]
/** Only the global rule set is shared; every other scope is private to its session. */
const shareModeOf = (row: SessionRow): ShareMode => row.strategyScopeId === 'global' ? 'shared' : 'private'

export function SessionsColumn({ width, fill = false, onCollapse }: { width?: number; fill?: boolean; onCollapse: () => void }) {
  const s = useStore()
  const [editing, setEditing] = React.useState<{ id: string; title: string } | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [sharing, setSharing] = React.useState<{ id: string; current: ShareMode; mode: ShareMode } | null>(null)
  const rows = React.useMemo(() => {
    const titleOf = (id: string) => s.sessionTitles?.[id] ?? null
    return s.sessions.filter((row) => !s.archivedSessionIds.includes(row.sessionId) &&
      (!s.nativeSessionsReady || s.nativeSessionIds.includes(row.sessionId)))
      .map((row) => ({ ...row, title: titleOf(row.sessionId) ?? row.title ?? t('session.defaultTitle', 'Hyperliquid 交易会话') }))
  }, [s.sessions, s.sessionTitles, s.archivedSessionIds, s.nativeSessionsReady, s.nativeSessionIds, s.localeRevision])

  const open = React.useCallback((id: string, coin: string | null) => {
    // Retaining the session in ChatColumn is enough for the embedded native
    // conversation. Opening it in uiWorkspace would navigate away from the
    // trading panel asynchronously after this click.
    void openSession(id, coin ?? store.get().activeCoin)
  }, [])

  const createSession = React.useCallback(async () => {
    try {
      const sessionsSvc = getContext()?.get('sessions')
      if (!sessionsSvc) throw new Error(tr('sessions 服务不可用', 'DSH sessions service unavailable'))
      const id = await sessionsSvc.create({})
      const row = await hyperCall('registerSession', { sessionId: id })
      await loadSessions()
      open(id, row.coin ?? 'BTC')
    } catch (e) {
      notify(t('session.createFailed', '创建交易会话失败') + '：' + String((e as Error)?.message ?? e))
    }
  }, [open])

  const saveTitle = React.useCallback(async () => {
    if (!editing || saving) return
    const title = editing.title.trim()
    if (!title) return
    setSaving(true)
    try {
      const sessionsSvc = getContext()?.get('sessions')
      if (!sessionsSvc?.using) throw new Error(tr('DSH 会话重命名不可用', 'DSH session rename unavailable'))
      await sessionsSvc.using(editing.id, { source: 'dsh-hyperliquid.rename' }, async (ref: any) => {
        await ref.ready
        if (!ref.binding?.session?.rename) throw new Error(tr('DSH 会话重命名不可用', 'DSH session rename unavailable'))
        const result = await ref.binding.session.rename(title)
        if (result?.ok === false) throw new Error(result.error?.message ?? tr('重命名失败', 'Rename failed'))
      })
      store.patch((prev) => ({ sessionTitles: { ...prev.sessionTitles, [editing.id]: title } }))
      setEditing(null)
    } catch (error) {
      notify(t('session.renameFailed', '重命名失败') + '：' + String((error as Error)?.message ?? error))
    } finally { setSaving(false) }
  }, [editing, saving])

  const archive = React.useCallback(async (id: string) => {
    const before = store.get()
    const active = before.activeSessionId === id
    const next = active ? before.sessions.find((row) => row.sessionId !== id && !before.archivedSessionIds.includes(row.sessionId) &&
      (!before.nativeSessionsReady || before.nativeSessionIds.includes(row.sessionId))) : null
    try {
      const ui = getContext()?.get('uiWorkspace')
      if (!ui?.archiveSession) throw new Error(tr('DSH 归档服务不可用', 'DSH archive service unavailable'))
      // Unmount the embedded native conversation before DSH archives its
      // session. Otherwise its provider can render a released reference.
      store.patch({ archivedSessionIds: [...new Set([...before.archivedSessionIds, id])],
        ...(active ? { activeSessionId: next?.sessionId ?? null } : {}) })
      if (active) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        if (getActiveRef()?.sessionId === id) throw new Error(tr('会话仍在释放中，请重试', 'Session is still releasing; retry'))
        if (next) void openSession(next.sessionId, next.coin ?? store.get().activeCoin)
      }
      await ui.archiveSession(id)
    } catch (error) {
      store.patch((prev) => ({ archivedSessionIds: prev.archivedSessionIds.filter((entry) => entry !== id),
        ...(active ? { activeSessionId: id } : {}) }))
      if (active) void openSession(id, before.sessions.find((row) => row.sessionId === id)?.coin ?? before.activeCoin)
      notify(t('session.archiveFailed', '归档会话失败') + '：' + String((error as Error)?.message ?? error))
    }
  }, [])

  const saveSharing = async () => {
    if (!sharing || saving) return
    if (sharing.mode === sharing.current) { setSharing(null); return }
    setSaving(true)
    try {
      await hyperCall('configureSession', { sessionId: sharing.id, mode: sharing.mode })
      await loadSessions()
      setSharing(null)
    } catch (error) { notify(String((error as Error)?.message ?? error)) }
    finally { setSaving(false) }
  }

  // 盯盘 is the session's consent to automatic wakes and autonomous trading.
  const toggleWatch = async (row: SessionRow) => {
    try {
      await hyperCall('configureSession', { sessionId: row.sessionId, watch: !row.watch })
      await loadSessions()
    } catch (error) { notify(String((error as Error)?.message ?? error)) }
  }

  return (
    <div id="dhl-panel-sessions" className="dhl-col-sessions" style={fill ? { flex: '1 1 0', width: 'auto' } : width ? { width } : undefined}>
      <div className="dhl-col-head">
        {t('sessions.title', '交易会话')}
        <div className="dhl-spacer" />
        {`${rows.length}`}
        <button className="dhl-panel-iconbtn" type="button" onClick={onCollapse} aria-label={tr('收起会话栏', 'Collapse sessions')} title={tr('收起会话栏', 'Collapse sessions')}><FoldIcon direction="left" /></button>
      </div>
      <button className="dhl-newbtn" onClick={createSession}>
        <UiIcon name="plus" size={16} />{t('sessions.new', '新建交易会话')}
      </button>
      <div style={{ flex: '1', overflowY: 'auto', minHeight: 0 }}>
        {rows.length === 0
          ? <div className="dhl-empty">{t('sessions.empty', '还没有交易会话。\n点击上方新建，开一个专属交易对话。')}</div>
          : rows.map((row: SessionRow & { title: string | null }) => (
            <div
              key={row.sessionId}
              data-session-id={row.sessionId}
              className={'dhl-srow' + (s.activeSessionId === row.sessionId ? ' active' : '')}
              onClick={() => open(row.sessionId, row.coin)}
              title={row.title ?? row.sessionId}
            >
              <span className="coin">{row.coin ?? '—'}</span>
              <span className="title">{row.title ?? row.sessionId}</span>
              <span className="t" title={relTime(row.updatedAt ?? row.createdAt ?? 0)}>{shareModeOf(row) === 'shared' ? tr('全局共享', 'Global') : tr('独立', 'Independent')}{row.watch ? <span className="dhl-srow-watch">{tr(' · 盯盘 ', ' · Watch ') + (row.watchInterval ?? '15m')}</span> : null}</span>
              <span className="dhl-srow-actions">
                <button className="dhl-srow-action" type="button" data-watch={row.watch ? 'on' : 'off'} title={row.watch ? tr('关闭盯盘', 'Stop watching') : tr('开启盯盘：按策略周期自动唤醒本会话并自主交易', 'Watch: wake this session on each strategy bar and trade on its own')} aria-label={row.watch ? tr('关闭盯盘', 'Stop watching') : tr('开启盯盘', 'Watch')} aria-pressed={row.watch === true} onClick={(event) => { event.stopPropagation(); void toggleWatch(row) }}><UiIcon name={row.watch ? 'eyeOff' : 'eye'} size={14} /></button>
                <button className="dhl-srow-action" type="button" title={tr('共享会话', 'Share session')} aria-label={tr('共享会话', 'Share session')} onClick={(event) => { event.stopPropagation(); const mode = shareModeOf(row); setSharing({ id: row.sessionId, current: mode, mode }) }}><UiIcon name="sync" size={14} /></button>
                <button className="dhl-srow-action" type="button" title={t('session.rename', '重命名')} aria-label={t('session.rename', '重命名')} onClick={(event) => { event.stopPropagation(); setEditing({ id: row.sessionId, title: row.title ?? '' }) }}><UiIcon name="pencil" size={14} /></button>
                <button className="dhl-srow-action" type="button" title={t('session.archive', '归档')} aria-label={t('session.archive', '归档')} onClick={(event) => { event.stopPropagation(); void archive(row.sessionId) }}><UiIcon name="archive" size={14} /></button>
              </span>
            </div>
          ))}
      </div>
      <Modal open={Boolean(sharing)} onClose={() => setSharing(null)} title={tr('共享会话', 'Share session')} closeLabel={t('modal.close', '关闭')} className="dhl-rename-modal dhl-share-modal" footer={<><Button variant="outline" onClick={() => setSharing(null)}>{t('modal.cancel', '取消')}</Button><Button variant="primary" disabled={saving || sharing?.mode === sharing?.current} onClick={() => { void saveSharing() }}>{t('modal.save', '保存')}</Button></>}>
        <div className="dhl-segment" role="radiogroup" aria-label={tr('共享方式', 'Sharing')}>
          {SHARE_MODES.map(([mode, zh, en]) => <button key={mode} type="button" role="radio" aria-checked={sharing?.mode === mode} className={sharing?.mode === mode ? 'on' : ''} disabled={saving}
            onClick={() => setSharing((prev) => prev ? { ...prev, mode } : prev)}>{tr(zh, en)}</button>)}
        </div>
        <p className="dhl-share-note">{sharing?.mode === 'shared'
          ? tr('与所有「全局共享」会话共用同一套策略规则和档案，任一会话修改后其他会话同步生效。', 'Uses the one strategy rule set and profile shared by every Global session; edits apply to all of them.')
          : tr('只使用本会话自己的策略规则和档案。从全局共享切回时，保留当前规则的一份副本。', 'Uses this session\'s own strategy rules and profile. Switching back from Global keeps a copy of the current rules.')}</p>
        <p className="dhl-share-note">{tr('无论哪种方式，成交、委托、K 线画线和战绩都只属于本会话。', 'Either way, fills, orders, chart drawings and results stay with this session.')}</p>
      </Modal>
      <Modal open={Boolean(editing)} onClose={() => setEditing(null)} title={t('session.rename', '重命名会话')} closeLabel={t('modal.close', '关闭')} className="dhl-rename-modal" footer={<><Button variant="outline" onClick={() => setEditing(null)}>{t('modal.cancel', '取消')}</Button><Button variant="primary" disabled={!editing?.title.trim() || saving} onClick={() => { void saveTitle() }}>{t('modal.save', '保存')}</Button></>}>
        <Input data-modal-autofocus className="dhl-rename-input" value={editing?.title ?? ''} onChange={(event) => setEditing((prev) => prev ? { ...prev, title: event.target.value } : null)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void saveTitle() } }} maxLength={120} aria-label={t('session.name', '会话名称')} />
      </Modal>
    </div>
  )
}
