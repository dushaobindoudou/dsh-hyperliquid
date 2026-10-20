interface NativeSessionList {
  phase?: 'pending' | 'ready'
  byId?: Record<string, { displayTitle?: string; title?: string }>
}

/** DSH SnapshotStore uses getSnapshot(); retain get() compatibility for older hosts. */
export function readNativeSessionList(list: { getSnapshot?: () => NativeSessionList; get?: () => NativeSessionList } | null | undefined): NativeSessionList | null {
  return list?.getSnapshot?.() ?? list?.get?.() ?? null
}
