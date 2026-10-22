/**
 * dsh-hyperliquid — durable store: trading-session registry, paper account,
 * and the UI event ring. One JSON file per concern under the plugin dataDir;
 * writes are tmp+rename atomic (the dsh namespace sweep lesson).
 * @module lib/store.js
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, rmSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { canonicalMarketCoin } from './market-symbol.js'
import { normalizePaperCosts } from './workspace-settings.js'
import { WATCH_INTERVALS } from './strategy-monitor.js'

const PAPER_START_USD = 100_000
const WORKSPACE_DEFAULTS = Object.freeze({
  interval: '15m', bookGrouping: 'full', chartTab: 'chart', tapeTab: 'book', bottomTab: 'positions', indicators: ['volume'], maLines: [],
  priceScale: 'normal', chartType: 'candles', chartRanges: {}, chartLayers: { orders: true, fills: true, drawings: true },
  layout: { sessionsWidth: 232, chatWidth: 480, sessionsCollapsed: false, deskCollapsed: false, chatCollapsed: false },
})

import { emptyJournal } from './journal.js'

/** Drawings per chart (session + coin, all intervals); the pan budget is verified at this size. */
export const MAX_CHART_MARKS = 100
/** The one rule set that sessions in 全局共享 mode read and write. */
export const GLOBAL_STRATEGY_SCOPE = 'global'

export class HyperStore {
  constructor(dataDir, paperNetwork = 'testnet') {
    this.dataDir = dataDir
    this.sessionsFile = join(dataDir, 'sessions.json')
    this.paperLegacyFile = join(dataDir, 'paper.json')
    this.paperLegacyNetwork = paperNetwork
    this.liveOrdersFile = join(dataDir, 'live-orders.json')
    this.liveDecisionsFile = join(dataDir, 'live-decisions.json')
    this.chartMarksFile = join(dataDir, 'chart-marks.json')
    this.riskSettingsFile = join(dataDir, 'risk-settings.json')
    this.events = [] // UI event ring
    this.eventSeq = 0
    this.sessions = this.#readJson(this.sessionsFile, { sessions: {} })
    // Existing XYZ100 sessions may contain a display shorthand that the
    // exchange rejects with HTTP 500. Repair the saved binding on startup.
    let migratedCoin = false
    for (const row of Object.values(this.sessions.sessions ?? {})) {
      if (!row || typeof row.coin !== 'string') continue
      const canonical = canonicalMarketCoin(row.coin)
      if (canonical !== row.coin) { row.coin = canonical; migratedCoin = true }
    }
    if (migratedCoin) this.#writeJson(this.sessionsFile, this.sessions)
    this.selectPaperNetwork(paperNetwork)
    // A corrupt execution journal is unsafe to discard: an unknown order may
    // have reached the exchange. Refuse live trading until it is repaired.
    this.liveOrders = existsSync(this.liveOrdersFile)
      ? JSON.parse(readFileSync(this.liveOrdersFile, 'utf8'))
      : {}
    if (!this.liveOrders || typeof this.liveOrders !== 'object' || Array.isArray(this.liveOrders)) throw new Error('live 订单审计账本损坏')
    this.liveDecisions = existsSync(this.liveDecisionsFile)
      ? JSON.parse(readFileSync(this.liveDecisionsFile, 'utf8'))
      : {}
    if (!this.liveDecisions || typeof this.liveDecisions !== 'object' || Array.isArray(this.liveDecisions)) throw new Error('live 决策审计账本损坏')
    this.chartMarksBySession = new Map()
    this.workspacesBySession = new Map()
    this.#migrateChartMarks()
    this.#migrateSharing()
  }

  selectPaperNetwork(network) {
    if (network !== 'testnet' && network !== 'mainnet') throw new Error('paper 网络无效')
    const file = join(this.dataDir, `paper-${network}.json`)
    const source = existsSync(file) ? file : network === this.paperLegacyNetwork && existsSync(this.paperLegacyFile) ? this.paperLegacyFile : null
    let paper
    try {
      paper = source ? JSON.parse(readFileSync(source, 'utf8'))
        : { usd: PAPER_START_USD, positions: {}, leverageByCoin: {}, fills: [], orders: [], protections: {} }
    } catch {
      throw new Error('paper 账户文件损坏，拒绝重置模拟权益')
    }
    // Older paper snapshots predate per-coin leverage; an absent map is a
    // known migration and does not change cash, positions, or fills.
    if (paper && typeof paper === 'object' && paper.leverageByCoin == null) paper.leverageByCoin = {}
    if (paper && typeof paper === 'object' && paper.orders == null) paper.orders = []
    if (paper && typeof paper === 'object' && paper.protections == null) paper.protections = {}
    if (!paper || typeof paper !== 'object' || !Number.isFinite(paper.usd) ||
      !paper.positions || typeof paper.positions !== 'object' || Array.isArray(paper.positions) ||
      !Array.isArray(paper.fills) || !Array.isArray(paper.orders) || !paper.leverageByCoin ||
      typeof paper.leverageByCoin !== 'object' || Array.isArray(paper.leverageByCoin) ||
      !paper.protections || typeof paper.protections !== 'object' || Array.isArray(paper.protections)) {
      throw new Error('paper 账户文件损坏，拒绝重置模拟权益')
    }
    this.paperFile = file
    this.paper = paper
  }

  #readJson(file, fallback) {
    try {
      if (!existsSync(file)) return fallback
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      return fallback
    }
  }

  #writeJson(file, value) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
    renameSync(tmp, file)
  }

  /** Hash arbitrary DSH ids: a session id can never escape its artifact directory. */
  sessionDirectory(sessionId) {
    if (!this.sessions.sessions[sessionId]) throw new Error(`会话 ${sessionId} 未登记为交易会话`)
    return join(this.dataDir, 'sessions', createHash('sha256').update(sessionId).digest('hex'))
  }

  #sessionFile(sessionId, name) { return join(this.sessionDirectory(sessionId), name) }

  #readArtifact(file, fallback) {
    if (!existsSync(file)) return fallback
    try { return JSON.parse(readFileSync(file, 'utf8')) }
    catch { throw new Error(`会话文件损坏：${file}`) }
  }

  getRiskSettings() { return this.#readArtifact(this.riskSettingsFile, null) }

  saveRiskSettings(settings) { this.#writeJson(this.riskSettingsFile, settings) }

  clearRiskSettings() {
    if (existsSync(this.riskSettingsFile)) unlinkSync(this.riskSettingsFile)
  }

  #migrateChartMarks() {
    if (!existsSync(this.chartMarksFile)) return
    const legacy = this.#readArtifact(this.chartMarksFile, [])
    if (!Array.isArray(legacy)) throw new Error('旧图表标注文件损坏')
    const grouped = new Map()
    for (const mark of legacy) {
      if (!mark || !this.sessions.sessions[mark.sessionId]) continue
      if (!grouped.has(mark.sessionId)) grouped.set(mark.sessionId, [])
      grouped.get(mark.sessionId).push(mark)
    }
    // Writes are idempotent if a prior migration stopped before the rename.
    for (const [sessionId, marks] of grouped) {
      const file = this.#sessionFile(sessionId, 'chart-marks.json')
      const existing = this.#readArtifact(file, [])
      if (!Array.isArray(existing)) throw new Error('会话图表标注文件损坏')
      const ids = new Set(existing.map((row) => row.id))
      const merged = [...existing, ...marks.filter((row) => !ids.has(row.id))]
      this.#writeJson(file, merged)
    }
    renameSync(this.chartMarksFile, join(this.dataDir, 'chart-marks.migrated.json'))
  }

  getSessionWorkspace(sessionId) {
    const row = this.getSession(sessionId)
    if (!row) throw new Error(`会话 ${sessionId} 未登记为交易会话`)
    if (!this.workspacesBySession.has(sessionId)) {
      const saved = this.#readArtifact(this.#sessionFile(sessionId, 'workspace.json'), {})
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('会话工作台配置损坏')
      this.workspacesBySession.set(sessionId, { ...WORKSPACE_DEFAULTS, ...saved,
        layout: { ...WORKSPACE_DEFAULTS.layout, ...saved.layout },
        chartLayers: { ...WORKSPACE_DEFAULTS.chartLayers, ...saved.chartLayers },
        chartRanges: { ...saved.chartRanges }, coin: row.coin })
    }
    return { ...this.workspacesBySession.get(sessionId), coin: row.coin }
  }

  updateSessionWorkspace(sessionId, patch) {
    const current = this.getSessionWorkspace(sessionId)
    const next = { ...current, ...patch,
      layout: patch.layout ? { ...current.layout, ...patch.layout } : current.layout,
      chartLayers: patch.chartLayers ? { ...current.chartLayers, ...patch.chartLayers } : current.chartLayers,
      chartRanges: patch.chartRanges ? { ...current.chartRanges, ...patch.chartRanges } : current.chartRanges,
      coin: this.getSession(sessionId).coin, sessionId }
    if (Object.keys(next.chartRanges).length > 200) next.chartRanges = Object.fromEntries(Object.entries(next.chartRanges).slice(-200))
    this.#writeJson(this.#sessionFile(sessionId, 'workspace.json'), next)
    this.workspacesBySession.set(sessionId, next)
    return next
  }

  #marks(sessionId) {
    if (!this.chartMarksBySession.has(sessionId)) {
      const marks = this.#readArtifact(this.#sessionFile(sessionId, 'chart-marks.json'), [])
      if (!Array.isArray(marks)) throw new Error('会话图表标注文件损坏')
      this.chartMarksBySession.set(sessionId, marks)
    }
    return this.chartMarksBySession.get(sessionId)
  }

  // ── trading sessions ─────────────────────────────────────────────────
  listSessions() {
    return Object.values(this.sessions.sessions).sort((a, b) => b.createdAt - a.createdAt)
  }

  registerSession(sessionId, meta = {}) {
    const prev = this.sessions.sessions[sessionId]
    this.sessions.sessions[sessionId] = {
      sessionId,
      coin: canonicalMarketCoin(meta.coin ?? prev?.coin ?? 'BTC'),
      title: meta.title ?? prev?.title ?? null,
      strategyScopeId: prev?.strategyScopeId ?? sessionId,
      requirePosition: true,
      // 盯盘 is the user's per-session consent to automatic wakes; off until they turn it on.
      watch: prev?.watch === true,
      createdAt: prev?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    }
    this.#writeJson(this.sessionsFile, this.sessions)
    this.updateSessionWorkspace(sessionId, {})
    return this.sessions.sessions[sessionId]
  }

  removeSession(sessionId) {
    if (this.sessions.sessions[sessionId]) {
      delete this.sessions.sessions[sessionId]
      this.#writeJson(this.sessionsFile, this.sessions)
    }
    const path = join(this.dataDir, 'sessions', createHash('sha256').update(sessionId).digest('hex'))
    rmSync(path, { recursive: true, force: true })
    this.chartMarksBySession.delete(sessionId)
    this.workspacesBySession.delete(sessionId)
  }

  bindCoin(sessionId, coin) {
    const row = this.sessions.sessions[sessionId]
    if (!row) throw new Error(`会话 ${sessionId} 未登记为交易会话`)
    row.coin = canonicalMarketCoin(coin)
    row.updatedAt = Date.now()
    this.#writeJson(this.sessionsFile, this.sessions)
    this.updateSessionWorkspace(sessionId, {})
    return row
  }

  getSession(sessionId) {
    return this.sessions.sessions[sessionId] ?? null
  }

  /**
   * Strategy sharing has two modes: 'private' (the default, own rules) or
   * 'shared' (the one global rule set). Only rules and the profile are
   * shared; entries, orders, fills and drawings stay with each session.
   * `watch` is the user's 盯盘 switch for automatic wakes of this session.
   */
  configureSession(sessionId, { mode, watch, watchInterval } = {}) {
    const row = this.getSession(sessionId)
    if (!row) throw new Error('交易会话未登记')
    if (mode != null && mode !== 'private' && mode !== 'shared') throw new Error('共享模式只能是独立或全局共享')
    if (watch != null && typeof watch !== 'boolean') throw new Error('盯盘只能是开或关')
    if (watchInterval !== undefined && watchInterval !== null && !WATCH_INTERVALS.includes(watchInterval)) throw new Error(`盯盘周期只能是 ${WATCH_INTERVALS.join('/')}`)
    if (watch != null) row.watch = watch
    // null clears the override: the interval follows the strategies again.
    if (watchInterval === null) delete row.watchInterval
    else if (watchInterval !== undefined) row.watchInterval = watchInterval
    const current = row.strategyScopeId === GLOBAL_STRATEGY_SCOPE ? 'shared' : 'private'
    if (mode && mode !== current) {
      // Materialize before switching: the scope being left must survive for its other sessions.
      const content = this.journal(sessionId)
      const globalFile = this.#journalFile(GLOBAL_STRATEGY_SCOPE)
      // The first session to share seeds the global rules with its own.
      if (mode === 'shared' && !existsSync(globalFile)) this.#writeJson(globalFile, { ...content, entries: [] })
      row.strategyScopeId = mode === 'shared' ? GLOBAL_STRATEGY_SCOPE : randomUUID()
      // Leaving the global set keeps a private copy of the rules in force.
      if (mode === 'private') this.saveJournal(content, sessionId)
    }
    row.requirePosition = true
    row.updatedAt = Date.now()
    this.#writeJson(this.sessionsFile, this.sessions)
    this.recordEvent('session.settings', { sessionId })
    return row
  }

  /**
   * Older builds let sessions share a rule set with one chosen peer, and synced
   * drawings across them. Neither exists now: each peer keeps a private copy of
   * the rules, and every synced drawing returns to the session that drew it.
   */
  #migrateSharing() {
    let changed = false
    const holders = new Map()
    for (const row of Object.values(this.sessions.sessions ?? {})) {
      const scope = row.strategyScopeId ?? row.sessionId
      if (scope === GLOBAL_STRATEGY_SCOPE) continue
      if (!holders.has(scope)) holders.set(scope, [])
      holders.get(scope).push(row)
    }
    for (const [scope, rows] of holders) {
      if (rows.length < 2) continue
      const saved = this.#readArtifact(this.#journalFile(scope), null)
      const keeper = rows.find((row) => row.sessionId === scope) ?? rows[0]
      for (const row of rows) {
        if (row === keeper) continue
        row.strategyScopeId = randomUUID()
        if (saved) this.#writeJson(this.#journalFile(row.strategyScopeId), saved)
        changed = true
      }
    }
    if (changed) this.#writeJson(this.sessionsFile, this.sessions)
    const sharedFile = join(this.dataDir, 'shared-chart-marks.json')
    if (!existsSync(sharedFile)) return
    const marks = this.#readArtifact(sharedFile, [])
    if (!Array.isArray(marks)) throw new Error('共享图表标注文件损坏')
    for (const mark of marks) {
      if (!mark || !this.sessions.sessions[mark.sessionId]) continue
      const { shared, sharedScopeId, ...own } = mark
      const list = this.#marks(mark.sessionId)
      if (!list.some((row) => row.id === own.id)) list.push(own)
    }
    for (const sessionId of new Set(marks.map((mark) => mark?.sessionId))) if (this.sessions.sessions[sessionId]) this.#saveSession(sessionId)
    renameSync(sharedFile, join(this.dataDir, 'shared-chart-marks.migrated.json'))
  }

  #saveSession(sessionId) { this.#writeJson(this.#sessionFile(sessionId, 'chart-marks.json'), this.#marks(sessionId)) }

  #notify(mark, sessionId) {
    this.recordEvent('chart.mark', { sessionId, coin: mark.coin, interval: mark.interval, id: mark.id })
  }

  /** Drawings belong to one session: sharing rules never shows them in another chat. */
  listChartMarks(sessionId, coin, interval) {
    return this.#marks(sessionId).filter((mark) => mark.coin === coin && (interval == null || mark.interval === interval))
  }

  /** Every session's drawings (for host-side watchers). */
  allChartMarks() {
    const sessions = Object.keys(this.sessions?.sessions ?? {})
    return sessions.flatMap((id) => { try { return this.#marks(id) } catch { return [] } })
  }

  addChartMark(mark) {
    // The chart shows a coin's drawings from every interval, so the cap counts them all.
    const related = this.listChartMarks(mark.sessionId, mark.coin)
    if (related.length >= MAX_CHART_MARKS) throw new Error(`当前图表最多保留 ${MAX_CHART_MARKS} 条标注，请先删除旧线`)
    const marks = this.#marks(mark.sessionId)
    if (marks.length >= 300) throw new Error('当前会话最多保留 300 条图表标注，请先删除旧线')
    const { shared, ...own } = mark
    const saved = { ...own, id: randomUUID(), createdAt: Date.now() }
    marks.push(saved)
    this.#saveSession(mark.sessionId)
    this.#notify(saved, mark.sessionId)
    return saved
  }

  getChartMark(sessionId, id) {
    const mark = this.#marks(sessionId).find((row) => row.id === id)
    if (!mark) throw new Error('图表标注不存在或不属于当前会话')
    return mark
  }

  updateChartMark(sessionId, id, fields) {
    const own = this.#marks(sessionId)
    const index = own.findIndex((row) => row.id === id)
    if (index < 0) throw new Error('图表标注不存在或不属于当前会话')
    const next = { ...own[index], ...fields, updatedAt: Date.now() }
    // Cleared fields (undefined) are removed, so stored and returned drawings stay lossless JSON.
    for (const [key, value] of Object.entries(next)) if (value === undefined) delete next[key]
    delete next.shared
    own[index] = next
    this.#saveSession(sessionId)
    this.#notify(next, sessionId)
    return next
  }

  removeChartMark(sessionId, id) {
    const own = this.#marks(sessionId)
    const mark = own.find((row) => row.id === id)
    if (!mark) throw new Error('图表标注不存在或不属于当前会话')
    own.splice(own.indexOf(mark), 1)
    this.#saveSession(sessionId)
    this.#notify(mark, sessionId)
    return mark
  }

  // ── UI event ring ────────────────────────────────────────────────────
  recordEvent(kind, data = {}) {
    this.eventSeq += 1
    this.events.push({ seq: this.eventSeq, at: Date.now(), kind, data })
    if (this.events.length > 500) this.events.splice(0, this.events.length - 500)
    return this.eventSeq
  }

  eventsSince(seq) {
    return { events: this.events.filter((e) => e.seq > Number(seq) || !Number.isFinite(Number(seq))), seq: this.eventSeq }
  }

  // ── paper trading ────────────────────────────────────────────────────
  paperAccount() {
    return JSON.parse(JSON.stringify(this.paper))
  }

  paperCosts() {
    const file = join(this.dataDir, 'paper-costs.json')
    return normalizePaperCosts(existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined)
  }
  setPaperCosts(input) {
    const costs = normalizePaperCosts(input)
    this.#writeJson(join(this.dataDir, 'paper-costs.json'), costs)
    return costs
  }
  /** Signing set on the desk (signer, web3Account, tradingAddress); overrides plugin config, no restart. */
  walletSettings() { return this.#readJson(join(this.dataDir, 'wallet-settings.json'), null) }
  saveWalletSettings(settings) { this.#writeJson(join(this.dataDir, 'wallet-settings.json'), { ...settings, at: Date.now() }); return settings }

  /** Whether a session's current turn was started by an alert (see lib/turn-origin.js); survives a plugin reload. */
  setAlertOrigin(sessionId, alert) {
    const rows = { ...this.#readJson(join(this.dataDir, 'turn-origin.json'), {}), [sessionId]: { alert: Boolean(alert), at: Date.now() } }
    // Only cleared rows are pruned: a live alert origin stays until a human message retires it.
    const cleared = Object.entries(rows).filter(([, row]) => !row.alert).sort((a, b) => b[1].at - a[1].at).slice(0, 500)
    const kept = Object.fromEntries([...Object.entries(rows).filter(([, row]) => row.alert), ...cleared])
    this.#writeJson(join(this.dataDir, 'turn-origin.json'), kept)
  }
  alertOrigin(sessionId) { const row = this.#readJson(join(this.dataDir, 'turn-origin.json'), {})[sessionId]; return row ? row.alert === true : undefined }

  /** Custody mode chosen on the desk: 'managed' (全托管) or 'assisted' (半托管); null = not chosen yet. */
  custody() {
    const saved = this.#readJson(join(this.dataDir, 'custody.json'), null)
    return saved?.mode === 'managed' || saved?.mode === 'assisted' ? saved.mode : null
  }
  saveCustody(mode) { this.#writeJson(join(this.dataDir, 'custody.json'), { mode, at: Date.now() }); return mode }

  /** The trader's journal (profile, strategy book, trade/review log); see lib/journal.js. */
  journal(sessionId) {
    if (sessionId) {
      const row = this.getSession(sessionId)
      if (!row) throw new Error('日志仅限已登记的交易会话')
      const file = this.#journalFile(row.strategyScopeId ?? sessionId)
      if (!existsSync(file)) {
        const legacy = this.journal()
        const owned = new Set(legacy.entries.filter((entry) => entry.sessionId === sessionId).map((entry) => entry.strategyId))
        this.#writeJson(file, { profile: {},
          strategies: legacy.strategies.filter((strategy) => strategy.sessionId === sessionId || owned.has(strategy.id)),
          entries: legacy.entries.filter((entry) => entry.sessionId === sessionId) })
      }
      const saved = this.#readArtifact(file, null)
      if (!saved || !Array.isArray(saved.strategies) || !Array.isArray(saved.entries)) throw new Error('会话日志损坏')
      const entriesFile = this.#entriesFile(sessionId)
      if (!existsSync(entriesFile)) {
        const entries = [...this.journal().entries, ...saved.entries].filter((entry) => entry.sessionId === sessionId)
        const unique = new Map(entries.map((entry) => [entry.id ?? JSON.stringify(entry), entry]))
        this.#writeJson(entriesFile, [...unique.values()])
      }
      const entries = this.#readArtifact(entriesFile, [])
      if (!Array.isArray(entries)) throw new Error('会话交易记录损坏')
      return { ...saved, profile: saved.profile ?? {}, entries }
    }
    const saved = this.#readJson(join(this.dataDir, 'journal.json'), null)
    return saved && typeof saved === 'object' && Array.isArray(saved.strategies) && Array.isArray(saved.entries)
      ? { profile: saved.profile ?? {}, strategies: saved.strategies, entries: saved.entries } : emptyJournal()
  }
  #journalFile(scopeId) { return join(this.dataDir, 'strategy-scopes', createHash('sha256').update(scopeId).digest('hex'), 'journal.json') }
  #entriesFile(sessionId) { return join(this.dataDir, 'session-journals', createHash('sha256').update(sessionId).digest('hex'), 'entries.json') }
  saveJournal(journal, sessionId) {
    const row = sessionId ? this.getSession(sessionId) : null
    if (sessionId && !row) throw new Error('日志仅限已登记的交易会话')
    if (row) {
      this.#writeJson(this.#entriesFile(sessionId), journal.entries)
      this.#writeJson(this.#journalFile(row.strategyScopeId ?? sessionId), { ...journal, entries: [] })
    } else this.#writeJson(join(this.dataDir, 'journal.json'), journal)
    return journal
  }

  indicatorTemplates() { return this.#readJson(join(this.dataDir, 'indicator-templates.json'), []) }
  saveIndicatorTemplate(template) {
    const rows = this.indicatorTemplates()
    if (!rows.some((row) => row.id === template.id) && rows.length >= 20) throw Error('最多保存 20 个指标模板')
    const next = { ...template, id: template.id || randomUUID(), updatedAt: Date.now() }
    this.#writeJson(join(this.dataDir, 'indicator-templates.json'), [...rows.filter((row) => row.id !== next.id), next])
    return next
  }
  removeIndicatorTemplate(id) {
    this.#writeJson(join(this.dataDir, 'indicator-templates.json'), this.indicatorTemplates().filter((row) => row.id !== id))
  }

  /**
   * Fill a paper order against the given mid with a simple slippage model.
   * @returns the fill record
   */
  paperFill({ coin, isBuy, sz, px, time = Date.now(), reason = 'order', sessionId = null, feeBps = 0, referencePx = null, slippageBps = null, protection = null }) {
    const szNum = Number(sz)
    const pxNum = Number(px)
    if (!Number.isFinite(szNum) || szNum <= 0) throw new Error('paper: 无效数量')
    if (!Number.isFinite(pxNum) || pxNum <= 0) throw new Error('paper: 无效价格')
    const notional = szNum * pxNum
    if (!Number.isFinite(feeBps) || feeBps < 0 || feeBps > 100) throw Error('paper: 无效手续费')
    const fee = notional * feeBps / 10_000
    const pos = this.paper.positions[coin] ?? { size: 0, entryPx: pxNum, leverage: this.paper.leverageByCoin?.[coin] ?? 1 }
    const signed = isBuy ? szNum : -szNum
    const prevSize = pos.size
    let realized = 0
    if (prevSize !== 0 && Math.sign(prevSize) !== Math.sign(signed)) {
      const closing = Math.min(Math.abs(prevSize), Math.abs(signed))
      realized = (pxNum - pos.entryPx) * closing * Math.sign(prevSize)
    }
    const newSize = prevSize + signed
    if (newSize === 0) delete this.paper.positions[coin]
    else {
      const flip = prevSize !== 0 && Math.sign(newSize) !== Math.sign(prevSize)
      const adding = Math.abs(newSize) > Math.abs(prevSize)
      // Opening / flipping takes the fill price; ADDING keeps the weighted
      // average; a PARTIAL CLOSE leaves the remaining position's entry
      // untouched (its PnL was already settled into cash as `realized`).
      pos.entryPx = prevSize === 0 || flip ? pxNum
        : adding ? (pos.entryPx * Math.abs(prevSize) + pxNum * Math.abs(signed)) / (Math.abs(prevSize) + Math.abs(signed))
        : pos.entryPx
      pos.size = newSize
      this.paper.positions[coin] = pos
    }
    // One bracket covers the entire paper position. Closing or flipping updates it in the
    // same durable write as the fill, so a restart can never fire an already-used stop twice.
    if (prevSize !== 0 && Math.sign(prevSize) !== Math.sign(signed)) {
      for (const [key, bracket] of Object.entries(this.paper.protections)) {
        if (bracket.coin !== coin) continue
        if (newSize === 0 || Math.sign(newSize) !== Math.sign(prevSize)) delete this.paper.protections[key]
        else if (bracket.sessionId === sessionId) {
          bracket.sz = Math.max(0, bracket.sz - szNum)
          if (!bracket.sz) delete this.paper.protections[key]
        }
      }
    }
    if (protection) this.paper.protections[this.paper.protections[coin] ? `${coin}:${sessionId}` : coin] = { ...protection, coin, sz: szNum, sessionId, createdAt: time }
    this.paper.usd += realized - fee
    // sessionId: the trading conversation whose decision produced this fill.
    const fill = { oid: `paper-${randomUUID()}`, coin, isBuy, sz: szNum, px: pxNum, notional, realized, closedPnl: realized,
      fee, feeToken: 'USDC', netPnl: realized - fee, feeBps, referencePx, slippageBps,
      closedSize: Math.min(Math.abs(prevSize), Math.sign(prevSize) !== Math.sign(signed) ? szNum : 0), startPosition: prevSize, time, reason, sessionId }
    this.paper.fills.unshift(fill)
    if (this.paper.fills.length > 5000) this.paper.fills.length = 5000
    this.#writeJson(this.paperFile, this.paper)
    this.recordEvent('paper.fill', fill)
    return fill
  }

  /** Set one session's paper bracket on a coin (the protect action replaces, never stacks, it). */
  setPaperProtection(coin, sessionId, bracket) {
    const key = Object.keys(this.paper.protections).find((name) => (this.paper.protections[name].coin ?? name) === coin && this.paper.protections[name].sessionId === sessionId)
      ?? (this.paper.protections[coin] ? `${coin}:${sessionId}` : coin)
    this.paper.protections[key] = { ...bracket, coin, sessionId, createdAt: Date.now() }
    this.#writeJson(this.paperFile, this.paper)
    return this.paper.protections[key]
  }

  paperOrderRecord(order) {
    const row = { ...order, time: Date.now(), status: 'filled' }
    this.paper.orders.unshift(row)
    if (this.paper.orders.length > 5000) this.paper.orders.length = 5000
    this.#writeJson(this.paperFile, this.paper)
    this.recordEvent('paper.order', row)
  }

  paperSetLeverage(coin, leverage) {
    this.paper.leverageByCoin ??= {}
    this.paper.leverageByCoin[coin] = leverage
    if (this.paper.positions[coin]) this.paper.positions[coin].leverage = leverage
    this.#writeJson(this.paperFile, this.paper)
    this.recordEvent('paper.leverage', { coin, leverage })
  }

  recordLiveDecision(decisionId, decision) {
    this.liveDecisions[decisionId] = { ...decision, decisionId, at: Date.now() }
    const ids = Object.keys(this.liveDecisions)
    if (ids.length > 1000) {
      ids.sort((a, b) => this.liveDecisions[a].at - this.liveDecisions[b].at)
      for (const id of ids.slice(0, ids.length - 1000)) delete this.liveDecisions[id]
    }
    this.#writeJson(this.liveDecisionsFile, this.liveDecisions)
    this.recordEvent('live.decision', { decisionId, sessionId: decision.sessionId, coin: decision.order.coin })
    return this.liveDecisions[decisionId]
  }

  recordLiveOrder(cloid, patch) {
    const prev = this.liveOrders[cloid] ?? {}
    const row = { ...prev, ...patch, cloid, updatedAt: Date.now() }
    this.liveOrders[cloid] = row
    const ids = Object.keys(this.liveOrders)
    if (ids.length > 1000) {
      ids.sort((a, b) => this.liveOrders[a].updatedAt - this.liveOrders[b].updatedAt)
      for (const id of ids.slice(0, ids.length - 1000)) delete this.liveOrders[id]
    }
    this.#writeJson(this.liveOrdersFile, this.liveOrders)
    this.recordEvent('live.order.' + row.status, { cloid, coin: row.coin, status: row.status })
    return row
  }

  getLiveOrder(cloid) { return this.liveOrders[cloid] ?? null }
}
