// Shared helpers for the real-host drawing smoke (npm run smoke:drawing).
import { createRequire } from 'node:module'
export const { chromium } = createRequire(new URL('../../package.json', import.meta.url))('playwright-core')
/** Where phase 1 hands its sessions and drawing ids to phase 2. */
export const STATE_FILE = process.env.DRAWING_SMOKE_STATE ?? new URL('./.phase1-state.json', import.meta.url)
export const CHROME = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
export async function readUrl() { let url = ''; for await (const chunk of process.stdin) url += chunk; return url.trim() }
export async function openDesk(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(4000)
  const preview = page.getByRole('dialog').filter({ hasText: /预览版说明|内测声明/ }).first()
  if (await preview.isVisible().catch(() => false)) await preview.getByRole('button', { name: '继续' }).click()
  const onboarding = page.getByText(/添加一个 API Key/).first()
  if (await onboarding.waitFor({ state: 'visible', timeout: 2500 }).then(() => true).catch(() => false)) {
    await page.getByRole('button', { name: /稍后配置/ }).first().click()
    await onboarding.waitFor({ state: 'hidden', timeout: 5000 })
  }
  // The release notice can mount while the provider onboarding check is waiting.
  if (await preview.isVisible().catch(() => false)) {
    await preview.getByRole('button', { name: '继续' }).click()
    await preview.waitFor({ state: 'hidden', timeout: 5000 })
  }
  await page.getByRole('button', { name: /Hyperliquid/ }).first().click()
  await page.locator('.dhl-root').waitFor({ state: 'visible', timeout: 15_000 })
}
export const store = (page) => page.evaluate(() => { const s = window.__dhlStore.get(); return { activeSessionId: s.activeSessionId, chartMarks: s.chartMarks, maLines: s.workspace?.maLines ?? [], candles: s.candles.length } })
export async function waitCandles(page) { await page.waitForFunction(() => window.__dhlStore.get().candles.length > 100 && window.__dhlStore.get().workspace, null, { timeout: 30_000 }); await page.waitForTimeout(1200) }
export function check(ok, message, detail) { if (!ok) throw new Error('FAIL ' + message + (detail ? ' :: ' + JSON.stringify(detail).slice(0, 600) : '')); console.log('PASS ' + message) }

/** A drawing-menu item by its exact tool name (the menu item's accessible name also carries the hint,
 * so a prefix match would confuse 三角形 with 三角形态). */
export const toolItem = (page, name) => page.getByRole('menuitemradio').filter({ has: page.locator('b', { hasText: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') }) })

/** The drawing list is a popover that starts closed: open it (if needed) and return it. */
export async function openList(page) {
  const head = page.locator('.dhl-drawing-list-head').first()
  if (await head.getAttribute('aria-expanded') !== 'true') { await head.click(); await page.waitForTimeout(150) }
  return page.locator('.dhl-drawing-list').first()
}
