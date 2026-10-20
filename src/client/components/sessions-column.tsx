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
import { loadSessions, openSession, titleDeskSession } from '../data'
import type { SessionRow } from '../types'
import { FoldIcon, UiIcon } from './panel-icons'

export function SessionsColumn({ width, fill = false, onCollapse }: { width?: number; fill?: boolean; onCollapse: () => void }) {
  const s = useStore()
  const [editing, setEditing] = React.useState<{ id: string; title: string } | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [policy, setPolicy] = React.useState<{ id: string; mode: 'keep' | 'private' | 'copy' | 'shared'; sourceSessionId: string; tradingEnabled: boolean } | null>(null)
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
      await titleDeskSession(id)
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
      await hyperCall('configureSession', { sessionId: id, tradingEnabled: false })
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
      await hyperCall('configureSession', { sessionId: id, tradingEnabled: before.sessions.find((row) => row.sessionId === id)?.tradingEnabled !== false }).catch(() => {})
      store.patch((prev) => ({ archivedSessionIds: prev.archivedSessionIds.filter((entry) => entry !== id),
        ...(active ? { activeSessionId: id } : {}) }))
      if (active) void openSession(id, before.sessions.find((row) => row.sessionId === id)?.coin ?? before.activeCoin)
      notify(t('session.archiveFailed', '归档会话失败') + '：' + String((error as Error)?.message ?? error))
    }
  }, [])

  const savePolicy = async () => {
    if (!policy) return
    setSaving(true)
    try {
      await hyperCall('configureSession', { sessionId: policy.id, tradingEnabled: policy.tradingEnabled,
        ...(policy.mode === 'keep' ? {} : { mode: policy.mode, sourceSessionId: policy.sourceSessionId }) })
      await loadSessions()
      setPolicy(null)
    } catch (error) { notify(String((error as Error)?.message ?? error)) }
    finally { setSaving(false) }
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
              <span className="t" title={relTime(row.updatedAt ?? row.createdAt ?? 0)}>{row.tradingEnabled === false ? tr('暂停', 'Paused') : rows.some((other) => other.sessionId !== row.sessionId && (other.strategyScopeId ?? other.sessionId) === (row.strategyScopeId ?? row.sessionId)) ? tr('共享规则', 'Shared rules') : tr('独立', 'Independent')}</span>
              <span className="dhl-srow-actions">
                <button className="dhl-srow-action" type="button" title={tr('策略隔离与共享', 'Strategy isolation and sharing')} aria-label={tr('策略隔离与共享', 'Strategy isolation and sharing')} onClick={(event) => { event.stopPropagation(); setPolicy({ id: row.sessionId, mode: 'keep', sourceSessionId: rows.find((item) => item.sessionId !== row.sessionId)?.sessionId ?? '', tradingEnabled: row.tradingEnabled !== false }) }}><UiIcon name="settings" size={14} /></button>
                <button className="dhl-srow-action" type="button" title={t('session.rename', '重命名')} aria-label={t('session.rename', '重命名')} onClick={(event) => { event.stopPropagation(); setEditing({ id: row.sessionId, title: row.title ?? '' }) }}><UiIcon name="pencil" size={14} /></button>
                <button className="dhl-srow-action" type="button" title={t('session.archive', '归档')} aria-label={t('session.archive', '归档')} onClick={(event) => { event.stopPropagation(); void archive(row.sessionId) }}><UiIcon name="archive" size={14} /></button>
              </span>
            </div>
          ))}
      </div>
      <Modal open={Boolean(policy)} onClose={() => setPolicy(null)} title={tr('会话交易设置', 'Session trading settings')} closeLabel={t('modal.close', '关闭')} footer={<><Button variant="outline" onClick={() => setPolicy(null)}>{t('modal.cancel', '取消')}</Button><Button variant="primary" disabled={saving || !policy || ((policy.mode === 'copy' || policy.mode === 'shared') && !policy.sourceSessionId)} onClick={() => { void savePolicy() }}>{t('modal.save', '保存')}</Button></>}>
        <p>{tr('每个启用的交易会话都必须持有自己的仓位。订单、提醒和战绩分别管理。', 'Each enabled trading session must hold its own position. Orders, alerts and results are managed separately.')}</p>
        <label><input type="checkbox" checked={policy?.tradingEnabled ?? true} onChange={(event) => setPolicy((prev) => prev ? { ...prev, tradingEnabled: event.target.checked } : prev)} /> {tr('启用本会话交易与自动入场', 'Enable trading and automatic entry for this session')}</label>
        <p><label>{tr('策略设置', 'Strategy settings')} <select aria-label={tr('策略设置', 'Strategy settings')} value={policy?.mode ?? 'keep'} onChange={(event) => setPolicy((prev) => prev ? { ...prev, mode: event.target.value as NonNullable<typeof policy>['mode'] } : prev)}>
          <option value="keep">{tr('保持当前设置', 'Keep current settings')}</option>
          <option value="private">{tr('独立策略（清空策略，保留档案）', 'Independent strategy (reset rules, keep profile)')}</option>
          <option value="copy">{tr('复制另一会话的策略，独立运行', 'Copy another session’s rules and run independently')}</option>
          <option value="shared">{tr('与另一会话共享策略规则', 'Share strategy rules with another session')}</option>
        </select></label></p>
        {(policy?.mode === 'copy' || policy?.mode === 'shared') && <p><label>{tr('来源会话', 'Source session')} <select aria-label={tr('来源会话', 'Source session')} value={policy.sourceSessionId} onChange={(event) => setPolicy((prev) => prev ? { ...prev, sourceSessionId: event.target.value } : prev)}>{rows.filter((row) => row.sessionId !== policy.id).map((row) => <option key={row.sessionId} value={row.sessionId}>{row.coin} · {row.title}</option>)}</select></label></p>}
        <p>{tr('共享会同步档案和策略修订；订单与成交份额始终属于各自会话。同一账户同标的的反向策略会提示冲突。', 'Sharing synchronizes profiles and strategy revisions. Orders and filled allocations remain owned by each session. Opposing strategies on the same account and contract report a conflict.')}</p>
      </Modal>
      <Modal open={Boolean(editing)} onClose={() => setEditing(null)} title={t('session.rename', '重命名会话')} closeLabel={t('modal.close', '关闭')} className="dhl-rename-modal" footer={<><Button variant="outline" onClick={() => setEditing(null)}>{t('modal.cancel', '取消')}</Button><Button variant="primary" disabled={!editing?.title.trim() || saving} onClick={() => { void saveTitle() }}>{t('modal.save', '保存')}</Button></>}>
        <Input data-modal-autofocus className="dhl-rename-input" value={editing?.title ?? ''} onChange={(event) => setEditing((prev) => prev ? { ...prev, title: event.target.value } : null)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void saveTitle() } }} maxLength={120} aria-label={t('session.name', '会话名称')} />
      </Modal>
    </div>
  )
}
