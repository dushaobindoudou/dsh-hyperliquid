interface NativeSessionList {
  phase?: 'pending' | 'ready'
  byId?: Record<string, { displayTitle?: string; title?: string }>
}

/** DSH SnapshotStore uses getSnapshot(); retain get() compatibility for older hosts. */
export function readNativeSessionList(list: { getSnapshot?: () => NativeSessionList; get?: () => NativeSessionList } | null | undefined): NativeSessionList | null {
  return list?.getSnapshot?.() ?? list?.get?.() ?? null
}

/** The placeholder older desk builds pinned on new sessions. */
const PLACEHOLDER_TITLES = new Set(['未命名', 'Untitled'])

/**
 * Desk sessions whose durable title is still the placeholder older desk builds
 * pinned, which DSH treats as a user rename and never auto-titles again.
 * @param byId - the native session catalog, keyed by session id.
 * @param deskIds - ids the desk registered as trading sessions.
 * @returns the ids to hand back to DSH's automatic titling, in `deskIds` order.
 */
export function placeholderDeskSessions(
  byId: Record<string, { title?: string } | undefined> | undefined,
  deskIds: readonly string[],
): string[] {
  if (!byId) return []
  return deskIds.filter((id) => PLACEHOLDER_TITLES.has(byId[id]?.title ?? ''))
}
