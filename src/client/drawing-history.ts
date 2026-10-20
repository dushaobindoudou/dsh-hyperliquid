/**
 * dsh-hyperliquid — drawing operations with undo / redo.
 *
 * Every create, edit and delete the trader makes on the chart goes through
 * here: the desk updates optimistically, the host persists, and the inverse
 * operation is pushed onto a per-chart history (session + coin). Re-creating
 * a deleted drawing yields a new id, so ids inside the history are remapped.
 * @module src/client/drawing-history
 */

import * as React from 'react'
import { hyperCall, tr } from './remote'
import { notify, store } from './store'
import { loadChartMarks } from './data'
import type { ChartMark } from './types'

type Op =
  | { type: 'create'; mark: ChartMark }
  | { type: 'delete'; mark: ChartMark }
  | { type: 'edit'; id: string; before: Record<string, unknown>; after: Record<string, unknown> }
  | { type: 'batch'; ops: Op[] }

const HISTORY_LIMIT = 100
const GEOMETRY = ['price', 'fromTime', 'fromPrice', 'toTime', 'toPrice', 'points'] as const
const STYLE = ['color', 'lineWidth', 'lineStyle', 'locked', 'hidden', 'shared', 'alert', 'rows', 'valueArea', 'levels', 'visibleIntervals', 'fontSize', 'fillOpacity', 'bold', 'italic', 'extendLeft', 'extendRight', 'screenX', 'screenY'] as const
/** Flags the host treats as "absent = false"; undo must send false, since null leaves them unchanged. */
const FLAGS = new Set(['locked', 'hidden', 'shared', 'alert'])

/** Everything needed to recreate a drawing on the host. */
function recreateRequest(mark: ChartMark): Record<string, unknown> {
  const out: Record<string, unknown> = { kind: mark.kind, label: mark.label, role: mark.role, coin: mark.coin, interval: mark.interval }
  for (const key of [...GEOMETRY, ...STYLE]) if (mark[key as keyof ChartMark] != null) out[key] = mark[key as keyof ChartMark]
  if (mark.source === 'agent') out.restoreSource = 'agent'
  return out
}

function remap(ops: Op[], from: string, to: string): void {
  for (const op of ops) {
    if (op.type === 'batch') remap(op.ops, from, to)
    else if (op.type === 'edit') { if (op.id === from) op.id = to }
    else if (op.mark.id === from) op.mark = { ...op.mark, id: to }
  }
}

const beforeOf = (mark: ChartMark, patch: Record<string, unknown>) =>
  Object.fromEntries(Object.keys(patch).map((key) => [key, (mark as unknown as Record<string, unknown>)[key] ?? (FLAGS.has(key) ? false : null)]))

export interface DrawingHistory {
  create: (request: Record<string, unknown>) => Promise<ChartMark | null>
  edit: (id: string, patch: Record<string, unknown>) => Promise<void>
  remove: (id: string) => Promise<void>
  removeMany: (ids: string[]) => Promise<void>
  editMany: (ids: string[], patch: Record<string, unknown>) => Promise<void>
  /** Different patches for several drawings as one undo step (moving a group). */
  editEach: (patches: Array<[string, Record<string, unknown>]>) => Promise<void>
  undo: () => Promise<void>
  redo: () => Promise<void>
  canUndo: boolean
  canRedo: boolean
}

/** The chart an operation was issued on; captured when it is queued, not when it runs. */
interface Ctx { sessionId: string; coin: string; interval: string; scope: string }

/** History is scoped to one chart (session + coin) and resets when that changes. */
export function useDrawingHistory(scope: string): DrawingHistory {
  const undoStack = React.useRef<Op[]>([])
  const redoStack = React.useRef<Op[]>([])
  const scopeRef = React.useRef(scope)
  // Every operation runs after the previous one settles, so undo/redo never act on ids still being recreated.
  const queue = React.useRef<Promise<unknown>>(Promise.resolve())
  const [, setVersion] = React.useState(0)
  const bump = () => setVersion((value) => value + 1)
  React.useEffect(() => { scopeRef.current = scope; undoStack.current = []; redoStack.current = []; bump() }, [scope])
  const ctxNow = (): Ctx | null => {
    const { activeSessionId, activeCoin, interval } = store.get()
    return activeSessionId ? { sessionId: activeSessionId, coin: activeCoin, interval, scope: scopeRef.current } : null
  }
  /** Queue `task` with the chart captured now; it is dropped if the trader leaves that chart before it runs. */
  const serial = <T,>(task: (ctx: Ctx) => Promise<T>, fallback: T): Promise<T> => {
    const ctx = ctxNow()
    if (!ctx) { notify(tr('请先选择交易会话', 'Choose a trading session first')); return Promise.resolve(fallback) }
    const run = queue.current.catch(() => {}).then(() => ctx.scope === scopeRef.current ? task(ctx) : fallback)
    queue.current = run
    return run
  }

  /** The chart this request belongs to is still the one on screen. */
  const onScreen = (ctx: Ctx) => store.get().activeSessionId === ctx.sessionId && store.get().activeCoin === ctx.coin
  const fail = (what: string, error: unknown) => {
    notify(`${what}：${String((error as Error)?.message ?? error)}`)
    void loadChartMarks()
  }
  // ── host primitives (optimistic; never recorded); each reports success ──
  const apiCreate = async (ctx: Ctx, request: Record<string, unknown>): Promise<ChartMark | null> => {
    try {
      const saved = await hyperCall('drawChartMark', { interval: ctx.interval, role: 'neutral', ...request, coin: request.coin ?? ctx.coin, sessionId: ctx.sessionId }) as ChartMark
      // The trader may have switched session or market while the request was in flight.
      if (onScreen(ctx) && saved.coin === ctx.coin) store.patch((current) => ({ chartMarks: [...current.chartMarks.filter((item) => item.id !== saved.id), saved] }))
      return saved
    } catch (error) { fail(tr('画线失败', 'Could not draw'), error); return null }
  }
  const apiDelete = async (ctx: Ctx, id: string): Promise<boolean> => {
    if (onScreen(ctx)) store.patch((current) => ({ chartMarks: current.chartMarks.filter((item) => item.id !== id) }))
    try { await hyperCall('eraseChartMark', { sessionId: ctx.sessionId, id }); return true } catch (error) { fail(tr('删除画线失败', 'Could not remove drawing'), error); return false }
  }
  const apiEdit = async (ctx: Ctx, id: string, patch: Record<string, unknown>): Promise<boolean> => {
    if (onScreen(ctx)) store.patch((current) => ({ chartMarks: current.chartMarks.map((item) => {
      if (item.id !== id) return item
      const next = { ...item, ...patch } as Record<string, unknown>
      for (const [key, value] of Object.entries(patch)) if (value === null) delete next[key]
      return next as unknown as ChartMark
    }) }))
    try { await hyperCall('updateChartMark', { sessionId: ctx.sessionId, id, patch }); return true } catch (error) { fail(tr('修改画线失败', 'Could not edit drawing'), error); return false }
  }

  const record = (op: Op, ctx: Ctx) => {
    if (ctx.scope !== scopeRef.current) return
    undoStack.current.push(op)
    if (undoStack.current.length > HISTORY_LIMIT) undoStack.current.shift()
    redoStack.current = []
    bump()
  }
  const current = (id: string) => store.get().chartMarks.find((item) => item.id === id)

  /** Apply one op forward (redo) or backward (undo); the op is rewritten to what actually happened. Returns success. */
  const apply = async (ctx: Ctx, op: Op, forward: boolean): Promise<boolean> => {
    if (op.type === 'batch') {
      let ok = true
      for (const inner of forward ? op.ops : [...op.ops].reverse()) ok = (await apply(ctx, inner, forward)) && ok
      return ok
    }
    if (op.type === 'edit') return apiEdit(ctx, op.id, forward ? op.after : op.before)
    const shouldExist = (op.type === 'create') === forward
    if (shouldExist) {
      const saved = await apiCreate(ctx, recreateRequest(op.mark))
      if (!saved) return false
      const old = op.mark.id; remap(undoStack.current, old, saved.id); remap(redoStack.current, old, saved.id); op.mark = { ...op.mark, id: saved.id }
      return true
    }
    return apiDelete(ctx, op.mark.id)
  }

  /**
   * Undo (forward=false) or redo one entry. What succeeded moves to the other stack and what failed stays,
   * so a retry never repeats an applied step (a batch is split by member). If the trader left this chart
   * while the request ran, nothing is pushed: the stacks now belong to another chart.
   */
  const step = async (ctx: Ctx, forward: boolean) => {
    const from = forward ? redoStack : undoStack, to = forward ? undoStack : redoStack
    const op = from.current.pop()
    if (!op) return
    bump()
    let done: Op | null = null, left: Op | null = null
    if (op.type === 'batch') {
      const ok: Op[] = [], failed: Op[] = []
      for (const inner of forward ? op.ops : [...op.ops].reverse()) ((await apply(ctx, inner, forward)) ? ok : failed).push(inner)
      if (!forward) { ok.reverse(); failed.reverse() }
      if (ok.length) done = { type: 'batch', ops: ok }
      if (failed.length) left = { type: 'batch', ops: failed }
    } else if (await apply(ctx, op, forward)) done = op
    else left = op
    if (ctx.scope !== scopeRef.current) return
    if (done) to.current.push(done)
    if (left) from.current.push(left)
    bump()
  }

  return {
    create: (request) => serial(async (ctx) => {
      const saved = await apiCreate(ctx, request)
      if (saved) record({ type: 'create', mark: saved }, ctx)
      return saved
    }, null),
    edit: (id, patch) => serial(async (ctx) => {
      const mark = current(id)
      if (!mark) return
      const before = beforeOf(mark, patch)
      if (await apiEdit(ctx, id, patch)) record({ type: 'edit', id, before, after: patch }, ctx)
    }, undefined),
    remove: (id) => serial(async (ctx) => {
      const mark = current(id)
      if (!mark) return
      if (await apiDelete(ctx, id)) record({ type: 'delete', mark }, ctx)
    }, undefined),
    // Batches record only the members the host accepted, so an undo never re-creates something that still exists.
    removeMany: (ids) => serial(async (ctx) => {
      const done: Op[] = []
      for (const mark of ids.map(current).filter((item): item is ChartMark => Boolean(item))) if (await apiDelete(ctx, mark.id)) done.push({ type: 'delete', mark })
      if (done.length) record({ type: 'batch', ops: done }, ctx)
    }, undefined),
    editMany: (ids, patch) => serial(async (ctx) => {
      const done: Op[] = []
      for (const mark of ids.map(current).filter((item): item is ChartMark => Boolean(item))) {
        const before = beforeOf(mark, patch)
        if (await apiEdit(ctx, mark.id, patch)) done.push({ type: 'edit', id: mark.id, before, after: patch })
      }
      if (done.length) record({ type: 'batch', ops: done }, ctx)
    }, undefined),
    editEach: (patches) => serial(async (ctx) => {
      const done: Op[] = []
      for (const [id, patch] of patches) {
        const mark = current(id)
        if (!mark) continue
        const before = beforeOf(mark, patch)
        if (await apiEdit(ctx, id, patch)) done.push({ type: 'edit', id, before, after: patch })
      }
      if (done.length) record({ type: 'batch', ops: done }, ctx)
    }, undefined),
    undo: () => serial((ctx) => step(ctx, false), undefined),
    redo: () => serial((ctx) => step(ctx, true), undefined),
    canUndo: undoStack.current.length > 0,
    canRedo: redoStack.current.length > 0,
  }
}
