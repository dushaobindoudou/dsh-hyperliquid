/**
 * dsh-hyperliquid — the peer-level main panel: three-column workbench.
 *
 *   left   trading sessions   (real dsh sessions, retained while shown)
 *   center market desk        (chart / funding / book / trades / account)
 *   right  native conversation (order ticket is a secondary intent editor)
 * @module src/client/app
 */

import * as React from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { getContext, t, tr } from './remote'
import { notify, setTapePlacement, store, useStore } from './store'
import { isMarketStale, openSession, saveSessionWorkspace, setCustody, startPolling, switchNetwork, switchTradingMode } from './data'
import { DEFAULTS, LIMITS, clampWidth, useLayout } from './layout'
import { BrandMark } from './components/brand-mark'
import { Divider } from './components/divider'
import { SessionsColumn } from './components/sessions-column'
import { DeskColumn } from './components/desk-column'
import { ChatColumn } from './components/chat-column'
import { PanelIcon, UiIcon } from './components/panel-icons'
import { WalletDetails } from './components/wallet-details'
import { TradingLimits } from './components/trading-limits'
import { readNativeSessionList } from './native-session-list'

interface AppProps {
  SessionProvider?: React.ComponentType<any>
  sessionProvider?: React.ComponentType<any>
  renderFactorySlot?: (name: string, props?: any, options?: any) => React.ReactNode
}

export function App(props: AppProps) {
  const s = useStore()
  const st = s.status
  const marketStale = isMarketStale(s)
  const [confirmLive, setConfirmLive] = React.useState<{ network: 'mainnet' | 'testnet'; mode: 'live' | 'paper' } | null>(null)
  const [networkBusy, setNetworkBusy] = React.useState(false)
  const [walletOpen, setWalletOpen] = React.useState(false)
  const [moreOpen, setMoreOpen] = React.useState(false)
  const [limitsOpen, setLimitsOpen] = React.useState(false)
  const [confirmManaged, setConfirmManaged] = React.useState(false)
  const custody: 'managed' | 'assisted' = st?.custody === 'managed' ? 'managed' : 'assisted'
  const chooseCustody = React.useCallback(async (next: 'managed' | 'assisted', acknowledge = false) => {
    setMoreOpen(false)
    if (next === 'managed' && store.get().status?.tradingMode === 'live' && !acknowledge) { setConfirmManaged(true); return }
    try { await setCustody(next, acknowledge) } catch (error) { notify(tr('切换托管模式失败', 'Could not switch custody') + '：' + String((error as Error)?.message ?? error)) }
    finally { setConfirmManaged(false) }
  }, [])
  const moreRef = React.useRef<HTMLDivElement>(null)
  const network: 'mainnet' | 'testnet' = st?.network === 'testnet' ? 'testnet' : 'mainnet'
  const mode: 'live' | 'paper' = st?.tradingMode === 'paper' ? 'paper' : 'live'

  // Mainnet live trades real funds: confirm whenever a switch lands there.
  const applyEnv = React.useCallback(async (next: { network: 'mainnet' | 'testnet'; mode: 'live' | 'paper' }) => {
    setNetworkBusy(true)
    try {
      const current = store.get().status
      if (next.network !== current?.network) await switchNetwork(next.network)
      if (next.mode !== current?.tradingMode) await switchTradingMode(next.mode)
    } catch (error) { notify(t('network.switchFailed', '切换失败') + '：' + String((error as Error)?.message ?? error)) }
    finally { setNetworkBusy(false); setConfirmLive(null) }
  }, [])
  const requestEnv = React.useCallback((next: { network: 'mainnet' | 'testnet'; mode: 'live' | 'paper' }) => {
    setMoreOpen(false)
    if (next.network === 'mainnet' && next.mode === 'live') setConfirmLive(next)
    else void applyEnv(next)
  }, [applyEnv])

  React.useEffect(() => {
    if (!moreOpen) return undefined
    const onDown = (event: PointerEvent) => { if (!moreRef.current?.contains(event.target as Node)) setMoreOpen(false) }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setMoreOpen(false) }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('pointerdown', onDown); window.removeEventListener('keydown', onKey) }
  }, [moreOpen])

  React.useEffect(() => startPolling(), [])

  // Keep the native session catalog and workspace archive set authoritative.
  // A hidden or archived native session remains in the plugin registry so
  // unarchiving it in DSH restores its market binding.
  React.useEffect(() => {
    const list = getContext()?.get('sessions')?.list
    if (!list?.subscribe) return undefined
    const read = () => {
      const snapshot = readNativeSessionList(list) ?? {}
      const byId = snapshot.byId ?? {}
      const titles: Record<string, string | null> = {}
      for (const [id, row] of Object.entries(byId)) titles[id] = (row as any)?.displayTitle ?? null
      store.patch({ sessionTitles: titles, nativeSessionIds: Object.keys(byId), nativeSessionsReady: snapshot.phase === 'ready' })
    }
    read()
    return list.subscribe(read)
  }, [])

  React.useEffect(() => {
    const list = getContext()?.get('workspaces')?.list
    if (!list?.subscribe) return undefined
    const read = () => store.patch({ archivedSessionIds: [...(list.getSnapshot()?.archivedSessionIds ?? [])] })
    read()
    return list.subscribe(read)
  }, [])

  React.useEffect(() => {
    const locale = getContext()?.get('locale')
    if (!locale?.subscribe) return undefined
    return locale.subscribe(() => store.patch((prev) => ({ localeRevision: prev.localeRevision + 1 })))
  }, [])

  React.useEffect(() => {
    if (!s.sessionsLoaded) return
    const visible = s.sessions.filter((row) => !s.archivedSessionIds.includes(row.sessionId) &&
      (!s.nativeSessionsReady || s.nativeSessionIds.includes(row.sessionId)))
    if (visible.some((row) => row.sessionId === s.activeSessionId)) return
    const first = visible[0]
    if (first) void openSession(first.sessionId, first.coin ?? store.get().activeCoin)
    else store.patch({ activeSessionId: null, workspace: null, workspaceSessionId: null })
  }, [s.sessions, s.sessionsLoaded, s.archivedSessionIds, s.nativeSessionIds, s.nativeSessionsReady, s.activeSessionId])

  // Returning from the background (or first load) briefly reads as stale
  // while the host resubscribes; show that as syncing, not as an outage.
  // Ticket submission still follows marketStale.
  const wsState = s.snapshot?.ws?.state ?? st?.ws?.state
  const resyncing = marketStale && !s.statusError && Date.now() - s.resumedAt < 10_000
  const wsBadge = wsState === 'open' && !marketStale
    ? <span className="dhl-badge ok" title={`WebSocket: ${wsState}`}>{t('status.online', '在线')}</span>
    : resyncing
      ? <span className="dhl-badge" title={`WebSocket: ${wsState ?? 'off'}`}>{tr('同步中', 'Syncing')}</span>
      : <span className="dhl-badge err" title={`WebSocket: ${wsState ?? 'off'}`}>{t('status.offline', '离线')}</span>

  // Workbench layout: draggable dividers + persisted widths and visibility.
  const [layout, setLayout, commitLayout] = useLayout(s.activeSessionId, s.activeSessionId && s.workspaceSessionId === s.activeSessionId ? s.workspace?.layout : null,
    (next) => saveSessionWorkspace({ layout: next }))
  const resizeSessions = React.useCallback((delta: number) => {
    setLayout((prev) => ({ sessionsWidth: clampWidth(prev.sessionsWidth + delta, LIMITS.sessions) }))
  }, [setLayout])
  const resizeChat = React.useCallback((delta: number) => {
    setLayout((prev) => ({ chatWidth: clampWidth(prev.chatWidth + delta, LIMITS.chat) }))
  }, [setLayout])
  const resetSessions = React.useCallback(() => {
    setLayout({ sessionsWidth: DEFAULTS.sessionsWidth }); commitLayout()
  }, [setLayout, commitLayout])
  const resetChat = React.useCallback(() => {
    setLayout({ chatWidth: DEFAULTS.chatWidth }); commitLayout()
  }, [setLayout, commitLayout])
  const toggleSessions = React.useCallback(() => {
    setLayout((prev) => ({ sessionsCollapsed: !prev.sessionsCollapsed })); commitLayout()
  }, [setLayout, commitLayout])
  const toggleDesk = React.useCallback(() => {
    setLayout((prev) => ({ deskCollapsed: !prev.deskCollapsed })); commitLayout()
  }, [setLayout, commitLayout])
  const toggleChat = React.useCallback(() => {
    setLayout((prev) => ({ chatCollapsed: !prev.chatCollapsed })); commitLayout()
  }, [setLayout, commitLayout])
  const showSessions = !layout.sessionsCollapsed
  const showDesk = !layout.deskCollapsed
  const showChat = !layout.chatCollapsed

  return (
    <div className="dhl-root">
      <div className="dhl-topbar">
        <span className="dhl-brand">
          <BrandMark />
          {'Hyperliquid '}
          <span style={{ fontWeight: 400, color: 'var(--dsw-alias-label-secondary)' }}>
            {t('app.suffix', '交易台')}
          </span>
        </span>
        <div className="dhl-spacer" />
        {s.statusError ? <span className="dhl-badge err">{t('status.unavailable', '远端不可用')}</span> : null}
        {st && network === 'testnet' ? <span className="dhl-badge paper">{t('network.testnet', '测试网')}</span> : null}
        {st && mode === 'paper' ? <span className="dhl-badge paper">{t('mode.paper', '模拟盘')}</span> : null}
        {st && custody === 'managed' ? <span className="dhl-badge managed" title={tr('全托管：agent 可自主执行实盘、调整限额与划转保证金', 'Managed: the agent trades, adjusts limits and moves margin on its own')}>{tr('全托管', 'Managed')}</span> : null}
        {wsBadge}
        <button type="button" className="dhl-badge dhl-wallet-trigger" onClick={() => setWalletOpen(true)} aria-haspopup="dialog" aria-label={tr('查看钱包详情和收益', 'View wallet and P&L')}>
          {mode === 'paper' ? tr('模拟账户', 'Paper account') : st?.address ? st.address.slice(0, 6) + '…' + st.address.slice(-4) : t('account.none', '未连接钱包')}
          <UiIcon name="chevronDown" size={14} />
        </button>
        <div className="dhl-more" ref={moreRef}>
          <button type="button" className="dhl-top-control dhl-more-trigger" aria-haspopup="menu" aria-expanded={moreOpen} aria-label={tr('交易设置', 'Trading settings')} title={tr('交易设置', 'Trading settings')} onClick={() => setMoreOpen((value) => !value)}><UiIcon name="settings" size={17} /></button>
          {moreOpen ? <div className="dhl-more-popover" role="menu">
            <div className="dhl-more-group">
              <span>{t('network.label', '网络')}</span>
              <div className="dhl-segment">
                <button type="button" className={network === 'mainnet' ? 'on' : ''} disabled={networkBusy || !st} onClick={() => network !== 'mainnet' && requestEnv({ network: 'mainnet', mode })}>{t('network.mainnet', '主网')}</button>
                <button type="button" className={network === 'testnet' ? 'on' : ''} disabled={networkBusy || !st} onClick={() => network !== 'testnet' && requestEnv({ network: 'testnet', mode })}>{t('network.testnet', '测试网')}</button>
              </div>
            </div>
            <div className="dhl-more-group">
              <span>{tr('账户', 'Account')}</span>
              <div className="dhl-segment">
                <button type="button" className={mode === 'live' ? 'on' : ''} disabled={networkBusy || !st} onClick={() => mode !== 'live' && requestEnv({ network, mode: 'live' })}>{t('mode.live', '实盘')}</button>
                <button type="button" className={mode === 'paper' ? 'on' : ''} disabled={networkBusy || !st} onClick={() => mode !== 'paper' && requestEnv({ network, mode: 'paper' })}>{t('mode.paper', '模拟盘')}</button>
              </div>
            </div>
            <div className="dhl-more-group">
              <span>{tr('托管模式', 'Custody')}</span>
              <div className="dhl-segment" role="group" aria-label={tr('托管模式', 'Custody')}>
                <button type="button" className={custody === 'assisted' ? 'on' : ''} aria-pressed={custody === 'assisted'} disabled={!st} title={tr('实盘下单、划转需你批准；限额只由你修改', 'You approve live orders and transfers; only you change limits')} onClick={() => custody !== 'assisted' && void chooseCustody('assisted')}>{tr('半托管', 'Assisted')}</button>
                <button type="button" className={custody === 'managed' ? 'on' : ''} aria-pressed={custody === 'managed'} disabled={!st} title={tr('agent 自主执行实盘、调整限额与划转保证金', 'The agent trades, adjusts limits and moves margin on its own')} onClick={() => custody !== 'managed' && void chooseCustody('managed')}>{tr('全托管', 'Managed')}</button>
              </div>
            </div>
            <div className="dhl-more-group">
              <span>{tr('盘口 / 成交位置', 'Book / trades position')}</span>
              <div className="dhl-segment">
                <button type="button" className={s.tapePlacement === 'auto' ? 'on' : ''} onClick={() => setTapePlacement('auto')}>{tr('自适应', 'Auto')}</button>
                <button type="button" className={s.tapePlacement === 'below' ? 'on' : ''} onClick={() => setTapePlacement('below')}>{tr('图表下方', 'Below chart')}</button>
              </div>
            </div>
            <div className="dhl-more-group">
              <span>{tr('交易设置', 'Trading settings')}</span>
              <div className="dhl-segment">
                <button type="button" onClick={() => { setMoreOpen(false); setLimitsOpen(true) }}>{tr('交易限额与签名规则', 'Limits & signing rules')}</button>
              </div>
            </div>
          </div> : null}
        </div>
      </div>
      <Modal open={Boolean(confirmLive)} onClose={() => setConfirmLive(null)} title={tr('切换到主网实盘', 'Switch to mainnet live')} closeLabel={t('modal.close', '关闭')} className="dhl-network-modal" footer={<><Button variant="outline" onClick={() => setConfirmLive(null)}>{t('modal.cancel', '取消')}</Button><Button variant="primary" disabled={networkBusy} onClick={() => { if (confirmLive) void applyEnv(confirmLive) }}>{tr('确认切换', 'Switch')}</Button></>}>
        <p>{tr('主网实盘会显示真实行情和真实账户，后续交易将使用真实资金。', 'Mainnet live shows real markets and your real account; trades use real funds.')}</p>
      </Modal>
      <Modal open={confirmManaged} onClose={() => setConfirmManaged(false)} title={tr('开启全托管', 'Turn on managed mode')} closeLabel={t('modal.close', '关闭')} className="dhl-network-modal" footer={<><Button variant="outline" onClick={() => setConfirmManaged(false)}>{t('modal.cancel', '取消')}</Button><Button variant="primary" onClick={() => void chooseCustody('managed', true)}>{tr('开启全托管', 'Turn on')}</Button></>}>
        <p>{tr('全托管后，agent 在当前实盘账户中可以：', 'In managed mode the agent can, on this live account:')}</p>
        <ul className="dhl-managed-list">
          <li>{tr('不经逐笔批准直接下单、撤单和调整杠杆；', 'place, cancel and re-lever orders without per-trade approval;')}</li>
          <li>{tr('自行修改允许交易的币对与单笔、每日、仓位、杠杆上限；', 'change the allowed coins and the order, daily, position and leverage limits;')}</li>
          <li>{tr('在主永续账户与 HIP-3 交易所之间划转 USDC 保证金。', 'move USDC margin between the core perp account and HIP-3 dexes.')}</li>
        </ul>
        <p>{tr('dsh-web3 钱包自身的签名策略仍然生效。你可以随时切回半托管。', 'The dsh-web3 wallet signing policy still applies. You can switch back to assisted at any time.')}</p>
      </Modal>
      <WalletDetails open={walletOpen} onClose={() => setWalletOpen(false)} />
      <TradingLimits open={limitsOpen} onClose={() => setLimitsOpen(false)} />
      {/* Floating status: overlays the workbench instead of pushing it down. */}
      <div className="dhl-toasts">
        {marketStale && !resyncing ? <div className="dhl-data-warning" role="status">{tr('行情或宿主状态未及时更新；当前价格可能过期。交易票据已暂停提交，等待数据恢复。', 'Market or host data is stale. Ticket submission is paused until data recovers.')}</div> : null}
        {s.notice
          ? (
            <div className="dhl-notice" onClick={() => notify(null)}>
              <UiIcon name="info" size={16} />
              <span style={{ flex: 1 }}>{s.notice.text}</span>
              <UiIcon name="close" size={14} />
            </div>
          )
          : null}
      </div>
      <div className="dhl-body">
        {showSessions ? <SessionsColumn width={layout.sessionsWidth} fill={!showDesk && !showChat} onCollapse={toggleSessions} />
          : <button className="dhl-panel-rail" type="button" onClick={toggleSessions} aria-label={tr('展开会话栏', 'Expand sessions')} title={tr('展开会话栏', 'Expand sessions')}><PanelIcon kind="sessions" /></button>}
        {showSessions && (showDesk || showChat) ? <Divider side="left" onResize={resizeSessions} onCommit={commitLayout} onReset={resetSessions} /> : null}
        {showDesk ? <DeskColumn onCollapse={toggleDesk} />
          : <button className="dhl-panel-rail" type="button" onClick={toggleDesk} aria-label={tr('展开行情区', 'Expand market panel')} title={tr('展开行情区', 'Expand market panel')}><PanelIcon kind="desk" /></button>}
        {showDesk && showChat ? <Divider side="right" onResize={resizeChat} onCommit={commitLayout} onReset={resetChat} /> : null}
        {showChat ? <ChatColumn width={layout.chatWidth} fill={!showDesk} onCollapse={toggleChat} SessionProvider={props.SessionProvider ?? props.sessionProvider} renderFactorySlot={props.renderFactorySlot} />
          : <button className="dhl-panel-rail" type="button" onClick={toggleChat} aria-label={tr('展开对话栏', 'Expand chat')} title={tr('展开对话栏', 'Expand chat')}><PanelIcon kind="chat" /></button>}
      </div>
    </div>
  )
}
