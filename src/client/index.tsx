/**
 * dsh-hyperliquid — client plugin entry.
 *
 * esbuild bundles this module (plus the lightweight-charts dependency)
 * into `client.js`, wrapping the CJS output in the shell's
 * `window.__ModuleLoader__.load({ id, factory })` IIFE (see
 * scripts/build-client.mjs). `react` stays external — the shell's static
 * module map provides it.
 *
 * Slot contract:
 *   main (keyed)          the three-column trading workbench; declaring a
 *                         session-scoped child seat makes the renderer hand
 *                         us the SessionProvider kit piece + renderFactorySlot
 *   sidebar.panellist     the entry icon (id MUST equal the main slot key —
 *                         the sidebar passes options.id to layout.selectPanel)
 * @module src/client/index
 */

import * as React from 'react'
import cssText from './styles.css'
import { NS, DICT } from './locale'
import { setConnection, setContext, setLocaleBinder, t } from './remote'
import { App } from './app'
import { PanelEntry } from './components/panel-entry'
import { registerDshExtensions } from './dsh-extensions'

export const inject = ['connection', 'slots', 'locale', 'theme', 'layout', 'sessions', 'workspaces', 'uiConversation', 'uiWorkspace']

export function apply(ctx: any): void {
  setContext(ctx)
  setConnection(ctx.get('connection') ?? null)

  const locale = ctx.get('locale')
  if (locale?.register && locale?.bind) {
    ctx.effect(() => locale.register(NS, DICT), NS + ': dictionaries')
    setLocaleBinder(locale.bind(NS))
  }

  ctx.effect(() => {
    const styleEl = document.createElement('style')
    styleEl.setAttribute('data-dsh-plugin', NS)
    styleEl.textContent = cssText
    document.head.appendChild(styleEl)
    return () => { styleEl.remove() }
  }, NS + ': styles')

  const slots = ctx.get('slots')
  if (slots) {
    // The peer-level app: main-content-area switch (selectPanel) — the
    // dsh shell (sidebar + mode icons) always stays visible.
    ctx.effect(() => slots.inject('main', () => slots.register(
      {
        name: 'main', key: NS, registrant: NS, locale: NS,
        children: { 'hyper.panel.seat': { kind: 'single', scope: 'session' } },
      },
      (props: any) => React.createElement(App, {
        SessionProvider: props?.SessionProvider,
        renderFactorySlot: props?.renderFactorySlot,
      }),
    )), NS + ': main panel')

    // Entry point: a global panel icon (list slot, no conflicts with dsh-bots).
    ctx.effect(() => slots.inject('sidebar.panellist', () => slots.register(
      { name: 'sidebar.panellist', id: NS, order: 20, label: () => t('app.title', 'Hyperliquid 交易台'), registrant: NS, locale: NS },
      (props: any) => React.createElement(PanelEntry, props),
    )), NS + ': panel entry')
  }

  // Quote chips, hyper_* tool rows and the approval order card live in
  // DSH's own conversation surfaces, so they work outside this panel too.
  registerDshExtensions(ctx, slots)

  // DSH starts on Conversation after a browser refresh. Restore this panel
  // only when it was the selected panel in the same browser tab before reload.
  const layout = ctx.get('layout')
  if (layout?.panelInfo?.subscribe && slots) ctx.effect(() => {
    const key = `${NS}.panel-selected.v1`
    let restore = false
    try { restore = sessionStorage.getItem(key) === '1' } catch { /* storage unavailable */ }
    let ready = false
    const remember = () => {
      if (!ready) return
      try { sessionStorage.setItem(key, layout.panelInfo.getSnapshot()?.activePanelId === NS ? '1' : '0') }
      catch { /* storage unavailable */ }
    }
    const unsubscribe = layout.panelInfo.subscribe(remember)
    const frame = requestAnimationFrame(() => {
      ready = true
      if (restore && layout.panelInfo.getSnapshot()?.activePanelId == null) {
        try { layout.selectPanel(NS) } catch { /* panel not registered yet */ }
      }
      remember()
    })
    return () => { cancelAnimationFrame(frame); unsubscribe() }
  }, NS + ': panel restore')
}

export default { inject, apply }
