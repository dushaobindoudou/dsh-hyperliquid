/**
 * dsh-hyperliquid — the trader's journal: what the agent has learned about this trader, the strategies
 * being developed, and the trade / review log those strategies are scored against. It lives in the
 * plugin data dir, survives sessions and restarts, and is summarised into every session's prompt.
 * Pure functions over a plain state object; the store persists it.
 * @module lib/journal
 */

import { randomUUID } from 'node:crypto'

export const STRATEGY_STATUSES = ['idea', 'testing', 'active', 'paused', 'retired']
export const ENTRY_TYPES = ['plan', 'trade', 'review', 'lesson', 'note']
const STRATEGY_FIELDS = ['name', 'markets', 'timeframe', 'thesis', 'entry', 'exit', 'invalidation', 'sizing', 'notes']
const MAX_PROFILE_KEYS = 30
const MAX_STRATEGIES = 60
const MAX_ENTRIES = 1000

export function emptyJournal() {
  return { profile: {}, strategies: [], entries: [] }
}

const text = (value, label, max, required = false) => {
  if (value == null || value === '') { if (required) throw new Error(`${label} 不能为空`); return undefined }
  const out = String(value).trim()
  if (required && !out) throw new Error(`${label} 不能为空`)
  if (out.length > max) throw new Error(`${label} 最多 ${max} 字`)
  return out
}

/** Merge profile fields; null removes a field. Keys are short labels such as 风险偏好 or 持仓周期. */
export function updateProfile(journal, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('profile 需要 { 字段: 内容 } 对象')
  const profile = { ...journal.profile }
  for (const [rawKey, value] of Object.entries(patch)) {
    const key = text(rawKey, '档案字段名', 40, true)
    if (value === null) { delete profile[key]; continue }
    profile[key] = { value: text(value, `档案字段 ${key}`, 500, true), updatedAt: Date.now() }
  }
  if (Object.keys(profile).length > MAX_PROFILE_KEYS) throw new Error(`交易员档案最多 ${MAX_PROFILE_KEYS} 个字段，先合并或删除旧字段`)
  return { ...journal, profile }
}

/** Create or revise a strategy. Every revision bumps the version and records why it changed. */
export function upsertStrategy(journal, input) {
  if (!input || typeof input !== 'object') throw new Error('strategy 参数无效')
  const existing = input.id ? journal.strategies.find((row) => row.id === input.id) : null
  if (input.id && !existing) throw new Error(`没有策略 ${input.id}；新建时不要传 id`)
  const status = input.status ?? existing?.status ?? 'idea'
  if (!STRATEGY_STATUSES.includes(status)) throw new Error(`status 必须为 ${STRATEGY_STATUSES.join('/')}`)
  const fields = {}
  for (const key of STRATEGY_FIELDS) {
    const value = text(input[key], key, key === 'name' ? 60 : 1500)
    if (value !== undefined) fields[key] = value
  }
  const now = Date.now()
  if (!existing) {
    if (!fields.name || !fields.thesis) throw new Error('新策略至少需要 name 和 thesis')
    if (journal.strategies.length >= MAX_STRATEGIES) throw new Error(`策略库最多 ${MAX_STRATEGIES} 条，先把无效策略标为 retired 并删除`)
    const strategy = { id: randomUUID().slice(0, 8), ...fields, status, version: 1, createdAt: now, updatedAt: now,
      changes: [{ version: 1, at: now, why: text(input.why, 'why', 500) ?? '新建' }] }
    return { journal: { ...journal, strategies: [...journal.strategies, strategy] }, strategy }
  }
  const why = text(input.why, 'why', 500, true)
  const strategy = { ...existing, ...fields, status, version: existing.version + 1, updatedAt: now,
    changes: [...(existing.changes ?? []), { version: existing.version + 1, at: now, why }].slice(-30) }
  return { journal: { ...journal, strategies: journal.strategies.map((row) => row.id === strategy.id ? strategy : row) }, strategy }
}

export function removeStrategy(journal, id) {
  if (!journal.strategies.some((row) => row.id === id)) throw new Error(`没有策略 ${id}`)
  return { ...journal, strategies: journal.strategies.filter((row) => row.id !== id) }
}

/**
 * Append a journal entry. Trades carry their result in R (risk multiples) so a strategy can be scored
 * independently of position size; `context` (mode/network) keeps paper and live results apart.
 */
export function addEntry(journal, input, context = {}) {
  if (!input || typeof input !== 'object') throw new Error('log 参数无效')
  const type = input.type ?? 'note'
  if (!ENTRY_TYPES.includes(type)) throw new Error(`type 必须为 ${ENTRY_TYPES.join('/')}`)
  const strategyId = input.strategyId == null ? undefined : String(input.strategyId)
  const strategy = strategyId ? journal.strategies.find((row) => row.id === strategyId) : undefined
  if (strategyId && !strategy) throw new Error(`没有策略 ${strategyId}`)
  const strategyVersion = strategy ? Number(input.strategyVersion ?? strategy.version) : undefined
  if (input.strategyVersion != null && !strategy || strategy && (!Number.isInteger(strategyVersion) || strategyVersion < 1 || strategyVersion > strategy.version)) throw new Error('strategyVersion 必须为已存在策略的有效版本')
  const resultR = input.resultR == null ? undefined : Number(input.resultR)
  if (resultR !== undefined && (!Number.isFinite(resultR) || Math.abs(resultR) > 100)) throw new Error('resultR 必须为 -100 到 100 的数字（以 1R 风险为单位）')
  const pnlUsd = input.pnlUsd == null ? undefined : Number(input.pnlUsd)
  if (pnlUsd !== undefined && !Number.isFinite(pnlUsd)) throw new Error('pnlUsd 必须为数字')
  if (type === 'trade' && resultR === undefined) throw new Error('trade 记录需要 resultR（盈亏 / 计划风险）；仍在持仓时用 plan')
  const entry = Object.fromEntries(Object.entries({
    id: randomUUID().slice(0, 8), at: Date.now(), type, text: text(input.text, 'text', 2000, true),
    coin: text(input.coin, 'coin', 40), strategyId, strategyVersion, resultR, pnlUsd,
    mode: context.mode, network: context.network, sessionId: context.sessionId,
  }).filter(([, value]) => value !== undefined))
  return { journal: { ...journal, entries: [...journal.entries, entry].slice(-MAX_ENTRIES) }, entry }
}

/** Expectancy per strategy from closed trades, split by mode/network so paper never props up live. */
export function strategyStatsByVersion(journal) {
  const out = {}
  for (const entry of journal.entries) {
    if (entry.type !== 'trade' || !entry.strategyId || !Number.isFinite(entry.resultR)) continue
    const key = `${entry.mode ?? '?'}/${entry.network ?? '?'}`
    const version = Number.isInteger(entry.strategyVersion) && entry.strategyVersion > 0 ? String(entry.strategyVersion) : 'unknown'
    const row = (((out[entry.strategyId] ??= {})[version] ??= {})[key] ??= { trades: 0, wins: 0, totalR: 0, worstR: 0 })
    row.trades += 1
    if (entry.resultR > 0) row.wins += 1
    row.totalR += entry.resultR
    row.worstR = Math.min(row.worstR, entry.resultR)
  }
  for (const versions of Object.values(out)) for (const byMode of Object.values(versions)) for (const row of Object.values(byMode)) {
    row.winRate = row.trades ? row.wins / row.trades : 0
    row.expectancyR = row.trades ? row.totalR / row.trades : 0
  }
  return out
}

/** Only the current revision's samples may support the current strategy. */
export function strategyStats(journal) {
  const versions = strategyStatsByVersion(journal)
  return Object.fromEntries(journal.strategies.map((strategy) => [strategy.id, versions[strategy.id]?.[strategy.version] ?? {}]))
}

/** What a session needs up front: who the trader is, the live strategy book, recent lessons. */
export function journalDigest(journal, { entries = 15 } = {}) {
  const stats = strategyStats(journal)
  const statsByVersion = strategyStatsByVersion(journal)
  return {
    profile: Object.fromEntries(Object.entries(journal.profile).map(([key, row]) => [key, row.value])),
    strategies: journal.strategies.filter((row) => row.status !== 'retired').map((row) => ({ ...row, changes: row.changes?.slice(-3), stats: stats[row.id] ?? {}, statsByVersion: statsByVersion[row.id] ?? {} })),
    retired: journal.strategies.filter((row) => row.status === 'retired').map((row) => ({ id: row.id, name: row.name, why: row.changes?.at(-1)?.why })),
    lessons: journal.entries.filter((entry) => entry.type === 'lesson').slice(-8),
    recent: journal.entries.slice(-entries),
  }
}

/** A few prompt lines (kept short): profile and the strategy book with its live/paper record. */
export function journalPromptLines(journal) {
  const lines = []
  const profile = Object.entries(journal.profile)
  if (profile.length) lines.push('交易员档案（hyper_journal）：' + profile.slice(0, 12).map(([key, row]) => `${key}=${row.value.slice(0, 80)}`).join('；'))
  const stats = strategyStats(journal)
  const book = journal.strategies.filter((row) => row.status === 'active' || row.status === 'testing')
  if (book.length) {
    lines.push('策略库：' + book.slice(0, 10).map((row) => {
      const record = Object.entries(stats[row.id] ?? {}).map(([mode, s]) => `${mode} ${s.trades}笔 胜率${Math.round(s.winRate * 100)}% 期望${s.expectancyR.toFixed(2)}R`).join('，')
      return `[${row.id}] ${row.name}（${row.status}，v${row.version}${row.markets ? '，' + row.markets.slice(0, 30) : ''}${record ? '，' + record : ''}）`
    }).join('；'))
  }
  const lessons = journal.entries.filter((entry) => entry.type === 'lesson').slice(-3)
  if (lessons.length) lines.push('最近教训：' + lessons.map((entry) => entry.text.slice(0, 100)).join('；'))
  return lines
}
