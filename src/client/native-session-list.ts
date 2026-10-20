interface NativeSessionList {
  phase?: 'pending' | 'ready'
  byId?: Record<string, { displayTitle?: string; title?: string }>
}

/** DSH SnapshotStore uses getSnapshot(); retain get() compatibility for older hosts. */
export function readNativeSessionList(list: { getSnapshot?: () => NativeSessionList; get?: () => NativeSessionList } | null | undefined): NativeSessionList | null {
  return list?.getSnapshot?.() ?? list?.get?.() ?? null
}

/**
 * Desk sessions that still lack a durable title.
 *
 * DSH's display title falls back to the cwd directory basename — the account
 * name for a session created in the home directory — so these are the rows the
 * desk names itself instead of showing that fallback.
 * @param byId - the native session catalog, keyed by session id.
 * @param deskIds - ids the desk registered as trading sessions.
 * @returns the ids to name, in catalog order of `deskIds`.
 */
export function untitledDeskSessions(
  byId: Record<string, { title?: string } | undefined> | undefined,
  deskIds: readonly string[],
): string[] {
  if (!byId) return []
  const ids: string[] = []
  for (const id of deskIds) {
    const row = byId[id]
    if (row !== undefined && row.title === undefined) ids.push(id)
  }
  return ids
}
