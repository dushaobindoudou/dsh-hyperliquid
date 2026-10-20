/**
 * dsh-hyperliquid — client connection, locale and host-context plumbing.
 *
 * The dsh shell hands the plugin a `require` whose static module map exposes
 * react (and react-dom / @deepseek-ai/dsh-client-ui-primitives). Everything
 * else the desk needs is bundled at build time by esbuild.
 * @module src/client/remote
 */

import { notify } from './store'

let conn: any = null
let ctxRef: any = null
let localeT: (key: string, fallback: string) => string = (_k, fallback) => fallback

export function setConnection(c: any): void {
  conn = c
}

export function setContext(ctx: any): void {
  ctxRef = ctx
}

export function getContext(): any {
  return ctxRef
}

export function setLocaleBinder(binder: (key: string, fallback: string) => string): void {
  localeT = binder
}

/** Translate with a fallback; also the only caller of the bound locale. */
export function t(key: string, fallback: string): string {
  return localeT(key, fallback)
}

/** Small inline translations for desk-only labels outside the shared dictionary. */
export function tr(zh: string, en: string): string {
  // The host locale lookup is a service call; a desk render makes hundreds of tr() calls (one live tick
  // re-rendered the drawing list and tool menu ~450ms in 3s). The language changes rarely: read it at
  // most every 250ms.
  const now = Date.now()
  if (now - localeReadAt > 250) {
    localeReadAt = now
    english = ctxRef?.get?.('locale')?.getLocale?.()?.active === 'en'
  }
  return english ? en : zh
}
let localeReadAt = -Infinity
let english = false

/**
 * Invoke one host `hyper/<method>` Remote endpoint through the DSH RPC
 * carrier. The gateway wraps successful business values in `{ok,value}`.
 */
export async function hyperCall(method: string, request: any = null): Promise<any> {
  if (!conn) throw new Error(t('error.noConnection', '无连接'))
  if (typeof conn.rpc?.call !== 'function') throw new Error(t('error.callFailed', '远端调用失败') + `: hyper.${method}`)
  const envelope = await conn.rpc.call('/api', `hyper/${method}`, { args: { request: request ?? null } })
  if (envelope && typeof envelope === 'object' && envelope.ok === false) {
    throw new Error(envelope.error?.message ?? t('error.callFailed', '远端调用失败'))
  }
  if (envelope && typeof envelope === 'object' && envelope.ok === true) return envelope.value
  throw new Error(t('error.badResponse', '远端响应格式错误'))
}

// Same RPC the page already holds, for the real-host smoke and scripted setups.
try { (window as any).__dhlCall = hyperCall } catch { /* non-window env */ }

export { notify }
