/**
 * dsh-hyperliquid — workbench layout persistence.
 *
 * Column widths and collapse flags live in localStorage so the
 * desk remembers the user's arrangement across reloads. All writes are
 * best-effort (private-mode / storage-quota failures degrade to defaults).
 * @module src/client/layout
 */

import * as React from 'react'

export interface LayoutState {
  sessionsWidth: number
  chatWidth: number
  sessionsCollapsed: boolean
  deskCollapsed: boolean
  chatCollapsed: boolean
}

export const LIMITS = {
  sessions: [160, 400] as const,
  chat: [320, 700] as const,
}

export const DEFAULTS: LayoutState = {
  sessionsWidth: 232,
  chatWidth: 480,
  sessionsCollapsed: false,
  deskCollapsed: false,
  chatCollapsed: false,
}

const KEY = 'dsh-hyperliquid.layout.v1'
const keyFor = (sessionId: string | null) => sessionId ? `dsh-hyperliquid.layout.v2.${encodeURIComponent(sessionId)}` : KEY

/** Module mirror of the live layout so commit() can save without stale closures. */
let current: LayoutState = { ...DEFAULTS }

export function clampWidth(w: number, range: readonly [number, number]): number {
  const [min, max] = range
  if (!Number.isFinite(w)) return min
  return Math.round(Math.min(max, Math.max(min, w)))
}

export function loadLayout(sessionId: string | null = null): LayoutState {
  try {
    const raw = localStorage.getItem(keyFor(sessionId))
    if (!raw) return { ...DEFAULTS }
    const p = JSON.parse(raw) as Partial<LayoutState>
    return {
      sessionsWidth: clampWidth(Number(p.sessionsWidth) || DEFAULTS.sessionsWidth, LIMITS.sessions),
      chatWidth: clampWidth(Number(p.chatWidth) || DEFAULTS.chatWidth, LIMITS.chat),
      sessionsCollapsed: Boolean(p.sessionsCollapsed),
      deskCollapsed: Boolean(p.deskCollapsed),
      chatCollapsed: Boolean(p.chatCollapsed),
    }
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveLayout(s: LayoutState, sessionId: string | null = null): void {
  try { localStorage.setItem(keyFor(sessionId), JSON.stringify(s)) } catch { /* storage unavailable */ }
}

export function getLayout(): LayoutState {
  return current
}

/**
 * Layout state hook. `set` updates live (drag-safe, no writes per move);
 * `commit` persists the latest layout to localStorage once a drag ends.
 */
export function useLayout(sessionId: string | null = null, remoteLayout: LayoutState | null | undefined = null,
  onCommit?: (layout: LayoutState) => void): [LayoutState, (p: Partial<LayoutState> | ((prev: LayoutState) => Partial<LayoutState>)) => void, () => void] {
  const [state, setState] = React.useState<LayoutState>(() => {
    current = loadLayout(sessionId)
    return { ...current }
  })
  React.useEffect(() => {
    current = remoteLayout ? { ...remoteLayout } : loadLayout(sessionId)
    setState(current)
  }, [sessionId, remoteLayout])
  const set = React.useCallback((p: Partial<LayoutState> | ((prev: LayoutState) => Partial<LayoutState>)) => {
    const partial = typeof p === 'function' ? p(current) : p
    current = { ...current, ...partial }
    setState(current)
  }, [])
  const commit = React.useCallback(() => { saveLayout(current, sessionId); if (sessionId) onCommit?.(current) }, [sessionId, onCommit])
  return [state, set, commit]
}
