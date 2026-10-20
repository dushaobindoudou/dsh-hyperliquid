/**
 * Trade desk file preview — the fallback for file links the shipped sidebar cannot open.
 *
 * DSH's conversation opens a file link through `sidebarRight.openResource(address)`, which
 * resolves the address against the right sidebar's *mounted on-screen session surface*. The
 * trading desk replaces the main area with its own three columns, so that surface never mounts
 * and the call throws `sidebarRight: no session surface is mounted`; clicking a file in the
 * desk chat did nothing (and logged that error).
 *
 * This module keeps the shipped path untouched when it works, and when it cannot place the
 * resource, shows the file in a desk-owned modal instead. Content comes from the same
 * `workspaceFiles.read` Remote the shipped document preview reads through, so what the desk
 * shows is the session's workspace view of the file.
 *
 * @module src/client/file-preview
 */

import { useSyncExternalStore } from 'react'
import { getContext } from './remote'

/** One file shown by the desk preview. */
export interface FilePreviewTarget {
  /** Session whose workspace resolves a relative path. */
  sessionId: string
  /** Absolute or workspace-relative path, as the link addressed it. */
  path: string
  /** Requested 1-based line, when the link named one. */
  line?: number
}

export interface FilePreviewState {
  open: boolean
  target: FilePreviewTarget | null
  status: 'loading' | 'ready' | 'error'
  text: string
  /** First line of the loaded page (always 1 for the desk preview). */
  offset: number
  lines: number
  eof: boolean
  error: string | null
}

const listeners = new Set<() => void>()
const INITIAL: FilePreviewState = { open: false, target: null, status: 'loading', text: '', offset: 1, lines: 0, eof: true, error: null }
let state: FilePreviewState = INITIAL
let requestToken = 0

function setState(next: FilePreviewState): void {
  state = next
  for (const fn of listeners) fn()
}

export function subscribeFilePreview(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function getFilePreview(): FilePreviewState {
  return state
}

/** Desk preview snapshot backed by the shared external store. */
export function useFilePreview(): FilePreviewState {
  return useSyncExternalStore(subscribeFilePreview, getFilePreview, getFilePreview)
}

/** Close the preview; also cancels any in-flight page read. */
export function closeFilePreview(): void {
  requestToken += 1
  setState({ ...state, open: false, target: null })
}

/** The address grammar the resource model names a file with. */
const FILE_ADDRESS_PREFIX = 'dsh-resource://file/'

/**
 * Parse `dsh-resource://file/session/<sessionId>/<encoded path…>`.
 * @param address - candidate resource address.
 * @returns the session and decoded path, or undefined for another kind of address.
 */
export function parseFileAddress(address: unknown): FilePreviewTarget | undefined {
  if (typeof address !== 'string' || !address.startsWith(FILE_ADDRESS_PREFIX)) return undefined
  const end = address.search(/[?#]/)
  const rest = address.slice(FILE_ADDRESS_PREFIX.length, end === -1 ? undefined : end)
  const [scope, ...parts] = rest.split('/')
  if (scope !== 'session') return undefined
  const [id, ...segments] = parts
  if (id === undefined || id === '' || segments.length === 0) return undefined
  try {
    return { sessionId: decodeURIComponent(id), path: segments.map(decodeURIComponent).join('/') }
  } catch {
    return undefined
  }
}

async function load(target: FilePreviewTarget): Promise<void> {
  const token = ++requestToken
  setState({ open: true, target, status: 'loading', text: '', offset: 1, lines: 0, eof: true, error: null })
  try {
    const remote = getContext()?.remote
    const read = remote?.workspaceFiles?.read
    if (typeof read !== 'function') throw new Error('workspaceFiles Remote unavailable')
    const result = await read.call(remote.workspaceFiles, target.sessionId, target.path, { offset: 1, limit: 2000 }, new AbortController().signal)
    if (token !== requestToken) return
    if (!result?.ok) throw new Error(String(result?.error?.message ?? 'read failed'))
    const page = result.value
    setState({ ...state, status: 'ready', text: page.text, offset: page.offset, lines: page.lines, eof: page.eof })
  } catch (error) {
    if (token !== requestToken) return
    setState({ ...state, status: 'error', error: String((error as Error)?.message ?? error) })
  }
}

/**
 * Show one file in the desk preview.
 * @param target - session, path and optional line to reveal.
 */
export function openFilePreview(target: FilePreviewTarget): void {
  void load(target)
}

/**
 * Keep the shipped sidebar as the first choice and fall back to the desk preview when it has no
 * mounted surface to place the resource on. Idempotent; restores the original method on dispose.
 * @param ctx - the client plugin context.
 * @returns a disposer restoring `openResource`.
 */
export function installFileOpenFallback(ctx: any): () => void {
  const service = ctx?.sidebarRight ?? ctx?.get?.('sidebarRight')
  if (!service || typeof service.openResource !== 'function') return () => {}
  if (service.__dhlFileFallback === true) return () => {}
  const original = service.openResource
  const patched = function (this: any, address: string, options?: { params?: { line?: number } }) {
    try {
      return original.call(this, address, options)
    } catch (error) {
      const target = parseFileAddress(address)
      if (target === undefined) throw error
      openFilePreview({ ...target, ...(options?.params?.line === undefined ? {} : { line: options.params.line }) })
      return undefined
    }
  }
  try {
    service.openResource = patched
    service.__dhlFileFallback = true
  } catch {
    // A frozen service keeps the shipped behavior; the desk preview is unavailable then.
    return () => {}
  }
  return () => {
    if (service.openResource === patched) {
      service.openResource = original
      service.__dhlFileFallback = false
    }
  }
}
