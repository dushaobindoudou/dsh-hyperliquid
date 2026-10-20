/** Trading limits are a durable desk override shared by paper and live guards. */
import * as React from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { hyperCall, tr } from '../remote'
import { fmt } from '../format'
import { notify, useStore } from '../store'
import { loadStatus, resetWalletView } from '../data'
import { Select } from './select'

/** coinsMode: 'all' allows every tradable market ('*' on the host); 'manual' uses the listed coins. */
type Draft = { coinsMode: 'all' | 'manual'; allowedCoins: string; maxOrderUsd: string; maxDailyUsd: string; maxPositionUsd: string; maxLeverage: string }
const EMPTY: Draft = { coinsMode: 'manual', allowedCoins: '', maxOrderUsd: '', maxDailyUsd: '', maxPositionUsd: '', maxLeverage: '' }

const MANUAL_KEY = 'dhl.allowedCoins.manual'
function readManualCoins(): string { try { return localStorage.getItem(MANUAL_KEY) ?? '' } catch { return '' } }
function rememberManualCoins(value: string) { try { localStorage.setItem(MANUAL_KEY, value) } catch { /* convenience only */ } }

function fromLimits(limits: any): Draft {
  const coins: string[] = limits?.allowedCoins ?? []
  const all = coins.includes('*')
  return {
    coinsMode: all ? 'all' : 'manual',
    // Switching from 全部 back to 手动设置 starts from the last manual list this desk saw (or an empty field).
    allowedCoins: all ? readManualCoins() : coins.join(', '),
    maxOrderUsd: String(limits?.maxOrderUsd ?? ''),
    maxDailyUsd: String(limits?.maxDailyUsd ?? ''),
    maxPositionUsd: String(limits?.maxPositionUsd ?? ''),
    maxLeverage: String(limits?.maxLeverage ?? ''),
  }
}

export function TradingLimits({ open, onClose }: { open: boolean; onClose: () => void }) {
  const st = useStore().status
  const limits = st?.riskLimits
  const paper = st?.tradingMode === 'paper'
  const [draft, setDraft] = React.useState<Draft>(EMPTY)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [costs, setCosts] = React.useState({ feeBps: '4.5', slippageBps: '5' })
  React.useEffect(() => { if (open) setCosts({ feeBps: String(st?.paperCosts?.feeBps ?? 4.5), slippageBps: String(st?.paperCosts?.slippageBps ?? 5) }) }, [open])
  React.useEffect(() => {
    if (open && limits) { setDraft(fromLimits(limits)); setError('') }
  }, [open, Boolean(limits)])

  const change = (key: Exclude<keyof Draft, 'coinsMode'>, value: string) => setDraft((current) => ({ ...current, [key]: value }))
  const save = async (event?: React.FormEvent) => {
    event?.preventDefault()
    setBusy(true)
    setError('')
    try {
      // Keep the manual list even when saving 全部, so 手动设置 can bring it back after a reopen.
      if (draft.allowedCoins.trim()) rememberManualCoins(draft.allowedCoins)
      await hyperCall('updateRiskSettings', { limits: {
        allowedCoins: draft.coinsMode === 'all' ? '*' : draft.allowedCoins,
        maxOrderUsd: Number(draft.maxOrderUsd),
        maxDailyUsd: Number(draft.maxDailyUsd),
        maxPositionUsd: Number(draft.maxPositionUsd),
        maxLeverage: Number(draft.maxLeverage),
      } })
      await loadStatus()
      notify(tr('交易限额已保存并立即生效', 'Trading limits saved and applied immediately'))
    } catch (cause) { setError(String((cause as Error)?.message ?? cause)) }
    finally { setBusy(false) }
  }
  const reset = async () => {
    setBusy(true)
    setError('')
    try {
      const result = await hyperCall('resetRiskSettings')
      setDraft(fromLimits(result.riskLimits))
      await loadStatus()
      notify(tr('已恢复插件配置中的交易限额', 'Restored trading limits from plugin configuration'))
    } catch (cause) { setError(String((cause as Error)?.message ?? cause)) }
    finally { setBusy(false) }
  }

  const [tab, setTab] = React.useState<'limits' | 'costs' | 'signing'>('limits')
  // Wallet connection: applied by the host at once (no restart) and kept across restarts.
  const [wallet, setWallet] = React.useState({ signer: 'local', web3Account: 'main', tradingAddress: '' })
  const [web3Accounts, setWeb3Accounts] = React.useState<{ available: boolean; accounts: Array<{ id: string; label: string; address: string }> }>({ available: false, accounts: [] })
  React.useEffect(() => {
    if (!open) return
    setWallet({ signer: st?.signer ?? 'local', web3Account: st?.web3Account ?? 'main', tradingAddress: st?.tradingAddress ?? '' })
    void hyperCall('walletAccounts').then(setWeb3Accounts).catch(() => setWeb3Accounts({ available: false, accounts: [] }))
  }, [open])
  const saveWallet = () => {
    setBusy(true); setError('')
    void hyperCall('updateWalletSettings', wallet).then(() => resetWalletView())
      .then(() => notify(tr('钱包设置已生效', 'Wallet settings applied'))).catch((cause) => setError(String(cause.message))).finally(() => setBusy(false))
  }
  React.useEffect(() => { if (open) setTab('limits') }, [open])
  const saveCosts = () => {
    setBusy(true); setError('')
    void hyperCall('updatePaperCosts', { costs: { feeBps: costs.feeBps.trim() ? Number(costs.feeBps) : NaN, slippageBps: costs.slippageBps.trim() ? Number(costs.slippageBps) : NaN } })
      .then(() => loadStatus()).then(() => notify(tr('模拟成本已保存', 'Paper costs saved'))).catch((cause) => setError(String(cause.message))).finally(() => setBusy(false))
  }

  const field = (key: Exclude<keyof Draft, 'coinsMode'>, label: string, props: React.InputHTMLAttributes<HTMLInputElement>, wide = false) =>
    <label className={wide ? 'dhl-risk-wide' : undefined}><span>{label}</span>
      <Input className="dhl-risk-input" value={draft[key]} onChange={(event) => change(key, event.target.value)} required {...props} /></label>
  // The footer acts on the visible tab only, so “保存” always means what is on screen.
  const footer = tab === 'limits' ? (limits ? <>
    {st?.riskSettingsSource === 'desk' ? <Button variant="outline" disabled={busy} onClick={() => void reset()}>{tr('恢复插件配置', 'Restore plugin config')}</Button> : null}
    <Button variant="primary" type="submit" form="dhl-risk-form" disabled={busy}>{busy ? tr('保存中…', 'Saving…') : tr('保存限额', 'Save limits')}</Button>
  </> : null) : tab === 'costs' ? <Button variant="primary" disabled={busy} onClick={saveCosts}>{busy ? tr('保存中…', 'Saving…') : tr('保存模拟成本', 'Save paper costs')}</Button>
    : <Button variant="primary" disabled={busy} onClick={saveWallet}>{busy ? tr('连接中…', 'Connecting…') : tr('保存并连接', 'Save & connect')}</Button>
  const tabs: Array<[typeof tab, string, string]> = [['limits', '交易限额', 'Limits'], ['costs', '模拟成本', 'Paper costs'], ['signing', '签名与托管', 'Signing & custody']]

  return <Modal open={open} onClose={onClose} title={tr('交易限额与签名规则', 'Trading limits & signing rules')} closeLabel={tr('关闭', 'Close')} className="dhl-limits-modal" contentClassName="dhl-limits-content" footer={footer}>
    <div className="dhl-limits-tabs" role="tablist" aria-label={tr('设置分组', 'Settings sections')}>
      {tabs.map(([key, zh, en]) => <button key={key} type="button" role="tab" id={`dhl-limits-tab-${key}`} aria-controls={`dhl-limits-panel-${key}`} aria-selected={tab === key} className={tab === key ? 'on' : ''}
        onClick={() => { setTab(key); setError('') }}>{tr(zh, en)}</button>)}
    </div>
    <div className="dhl-limits-scroll">
      {tab === 'limits' ? <section className="dhl-limits-section" role="tabpanel" id="dhl-limits-panel-limits" aria-labelledby="dhl-limits-tab-limits">
        <p className="dhl-limits-ledger-row"><span className="dhl-limits-ledger">{paper ? tr('模拟盘账本', 'Paper ledger') : tr('实盘账本', 'Live ledger')}</span>
          {limits ? <span>{tr('今日已用（UTC）', 'Used today (UTC)')} {fmt(limits.usedTodayUsd ?? 0)} / {fmt(limits.maxDailyUsd)} USD</span> : null}</p>
        {limits ? <form id="dhl-risk-form" className="dhl-risk-form" onSubmit={(event) => void save(event)}>
          <div className="dhl-risk-wide dhl-coins-mode"><span id="dhl-coins-mode-label">{tr('允许开仓币对', 'Coins allowed to open')}</span>
            <span className="dhl-coins-seg" role="radiogroup" aria-labelledby="dhl-coins-mode-label">
              {([['all', '全部', 'All markets'], ['manual', '手动设置', 'Choose coins']] as const).map(([mode, zh, en]) =>
                <button key={mode} type="button" role="radio" aria-checked={draft.coinsMode === mode} className={draft.coinsMode === mode ? 'on' : ''}
                  onClick={() => setDraft((current) => { if (mode === 'all' && current.allowedCoins.trim()) rememberManualCoins(current.allowedCoins); return { ...current, coinsMode: mode } })}>{tr(zh, en)}</button>)}
            </span>
            <small>{draft.coinsMode === 'all'
              ? tr('可以在所有可交易市场开仓（核心永续与以 USDC 为保证金的 HIP-3）；单笔、每日、仓位和杠杆上限照常生效。', 'Opening is allowed on every tradable market; the order, daily, position and leverage limits still apply.')
              : tr('只能在下面列出的币对开仓；减仓和平仓不受限。', 'Only the listed coins can be opened; reducing and closing are never blocked.')}</small>
          </div>
          {draft.coinsMode === 'manual' ? field('allowedCoins', tr('币对（逗号分隔，如 BTC, xyz:XYZ100）', 'Coins (comma separated, e.g. BTC, xyz:XYZ100)'), { placeholder: 'BTC, ETH, xyz:XYZ100', maxLength: 1000 }, true) : null}
          {field('maxOrderUsd', tr('单笔上限 · USD', 'Per order · USD'), { type: 'number', min: '0.01', step: 'any' })}
          {field('maxDailyUsd', tr('每日开仓额度 · USD', 'Daily budget · USD'), { type: 'number', min: '0.01', step: 'any' })}
          {field('maxPositionUsd', tr('单币仓位上限 · USD', 'Per coin position · USD'), { type: 'number', min: '0.01', step: 'any' })}
          {field('maxLeverage', tr('最大杠杆 · 倍', 'Max leverage · x'), { type: 'number', min: '1', max: '50', step: '1' })}
        </form> : <div className="dhl-empty">{tr('正在读取…', 'Loading…')}</div>}
        <p className="dhl-limits-note">{tr('立即作用于模拟盘和实盘，重启后保留；两种模式的每日额度分开记账，减仓和平仓不受限。',
          'Applies to paper and live at once and survives restart; each mode has its own daily budget; reducing and closing are never blocked.')}</p>
      </section> : null}
      {tab === 'costs' ? <section className="dhl-limits-section" role="tabpanel" id="dhl-limits-panel-costs" aria-labelledby="dhl-limits-tab-costs">
        <div className="dhl-risk-form">{(['feeBps', 'slippageBps'] as const).map((key) => <label key={key}><span>{key === 'feeBps' ? tr('手续费 · bps', 'Fee · bps') : tr('不利滑点 · bps', 'Adverse slippage · bps')}</span><Input type="number" aria-label={key === 'feeBps' ? tr('模拟手续费 bps', 'Paper fee bps') : tr('模拟滑点 bps', 'Paper slippage bps')} min="0" max="100" step="any" value={costs[key]} onChange={(e) => setCosts((old) => ({ ...old, [key]: e.target.value }))} /></label>)}</div>
        <p className="dhl-limits-note">{tr('1 bps = 0.01%。仅影响之后的模拟成交；不模拟盘口深度、资金费和强平。', '1 bps = 0.01%. Future paper fills only; no depth, funding or liquidation simulation.')}</p>
      </section> : null}
      {tab === 'signing' ? <section className="dhl-limits-section" role="tabpanel" id="dhl-limits-panel-signing" aria-labelledby="dhl-limits-tab-signing">
        <div className="dhl-risk-form dhl-wallet-form">
          <label><span>{tr('签名方式', 'Signer')}</span>
            <Select aria-label={tr('签名方式', 'Signer')} value={wallet.signer} onChange={(event) => setWallet((old) => ({ ...old, signer: event.target.value }))}>
              <option value="web3">{tr('dsh-web3 钱包', 'dsh-web3 wallet')}</option>
              <option value="local">{tr('插件配置的私钥', 'Plugin private key')}</option>
            </Select></label>
          {wallet.signer === 'web3' ? <label><span>{tr('钱包账户', 'Wallet account')}</span>
            <Select aria-label={tr('钱包账户', 'Wallet account')} value={wallet.web3Account} onChange={(event) => setWallet((old) => ({ ...old, web3Account: event.target.value }))}>
              {web3Accounts.accounts.some((row) => row.id === wallet.web3Account || row.label === wallet.web3Account) ? null : <option value={wallet.web3Account}>{wallet.web3Account}</option>}
              {web3Accounts.accounts.map((row) => <option key={row.id} value={row.id}>{`${row.label} · ${row.address.slice(0, 6)}…${row.address.slice(-4)}`}</option>)}
            </Select></label> : null}
          <label className="dhl-risk-wide"><span>{tr('Hyperliquid 主账户地址（交易与查询用）', 'Hyperliquid main account address')}</span>
            <Input aria-label={tr('主账户地址', 'Main account address')} placeholder="0x…" value={wallet.tradingAddress} maxLength={42} spellCheck={false}
              onChange={(event) => setWallet((old) => ({ ...old, tradingAddress: event.target.value.trim() }))} /></label>
        </div>
        {wallet.signer === 'web3' && !web3Accounts.available ? <p className="dhl-limits-note">{tr('没有检测到 dsh-web3 钱包插件。', 'The dsh-web3 wallet plugin is not available.')}</p> : null}
        <p className="dhl-limits-note">{tr('保存后立即生效，无需重启；私钥仍只在插件配置里管理。新建的 dsh-web3 账户若不在列表中，需重启 DSH 刷新钱包。', 'Applies immediately, no restart; the private key stays in plugin config. A dsh-web3 account created elsewhere may need a DSH restart to appear.')}</p>
        <dl className="dhl-limits-facts">
          <dt>{tr('当前', 'Current')}</dt>
          <dd>{paper ? tr('模拟盘本地撮合，不签名。', 'Paper fills locally without signing.')
            : st?.signer === 'web3' ? tr('dsh-web3 钱包，按其签名策略处理（DSH 设置 → Web3 钱包）。', 'dsh-web3 wallet, under its signing policy (DSH Settings → Web3 wallet).')
              : tr('插件配置中的私钥（DSH 插件配置）。', 'Private key from plugin configuration.')}</dd>
          <dt>{tr('托管模式', 'Custody')}</dt>
          <dd>{st?.custody === 'managed'
            ? tr('全托管：agent 在限额内直接执行，也可调整这些限额并划转 HIP-3 保证金，每次都会在会话里说明。', 'Managed: the agent trades within limits, may adjust them and move HIP-3 margin, and says so each time.')
            : tr('半托管：agent 每笔实盘下单、改杠杆和划转都需要你批准，限额只由你修改。', 'Assisted: you approve each live order, leverage change and transfer; only you change limits.')}
            <span className="dhl-limits-hint">{tr('在右上角 设置 → 托管模式 切换。', 'Switch in Settings → Custody.')}</span></dd>
        </dl>
      </section> : null}
      {error ? <p className="dhl-risk-error" role="alert">{error}</p> : null}
    </div>
  </Modal>
}
