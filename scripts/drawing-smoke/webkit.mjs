// WebKit (Safari's engine): desktop drawing with a mouse, and an iPad profile drawing with taps.
// Playwright's WebKit build, not the shipping Safari app; finger drags are not available here.
import { createRequire } from 'node:module'
import { readUrl, openDesk, store, waitCandles, check, toolItem, openList } from './common.mjs'
const { webkit, devices } = createRequire(new URL('../../package.json', import.meta.url))('playwright-core')
const url = await readUrl()
// WebKit is an optional download (npx playwright-core install webkit); without it this phase is skipped, not failed.
let browser
try { browser = await webkit.launch({ headless: true }) } catch (error) {
  // Only a missing WebKit download is skipped; any other launch failure is a real failure.
  if (!/Executable doesn't exist|playwright(-core)? install/i.test(String(error?.message ?? error))) throw error
  console.log('SKIP webkit: WebKit is not installed — run: npx playwright-core install webkit')
  process.exit(0)
}
try {
  // ── desktop Safari: draw, reshape, pan with the pointer over a drawing ──
  {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
    const errors = []; page.on('pageerror', (e) => errors.push(String(e?.message ?? e)))
    await openDesk(page, url)
    await page.getByRole('button', { name: /新建交易会话/ }).click()
    await page.locator('.dhl-chatmount').waitFor({ state: 'visible', timeout: 30_000 }); await waitCandles(page)
    const box = await page.locator('.dhl-chart canvas').first().boundingBox()
    const at = (fx, fy) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy })
    const click = async (p) => { await page.mouse.move(p.x, p.y); await page.waitForTimeout(60); await page.mouse.click(p.x, p.y); await page.waitForTimeout(200) }
    await page.locator('.dhl-draw-menu summary').click(); await toolItem(page, '趋势线').click()
    await click(at(.35, .65)); await click(at(.55, .45)); await page.waitForTimeout(1600)
    const trend = (await store(page)).chartMarks.find((m) => m.kind === 'trend' && !m.shared)
    check(Boolean(trend), 'webkit desktop: two clicks draw a trend line')
    // Select it from the drawing list by id: a line synced from an earlier phase can cross the same spot on the chart.
    const anchorAt = () => page.evaluate((id) => { const c = document.querySelector(`circle.dhl-chart-anchor[data-mark-id="${id}"][data-anchor="1"]`); const r = c?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null }, trend.id)
    let anchor = await anchorAt()
    if (!anchor) {
      const head = page.locator('.dhl-drawing-list-head')
      if (await head.getAttribute('aria-expanded') !== 'true') await head.click()
      await (await openList(page)).locator(`[data-mark-id="${trend.id}"] .dhl-drawing-list-name`).click()
      for (let i = 0; i < 20; i += 1) { await page.waitForTimeout(150); const next = await anchorAt(); if (next && anchor && Math.abs(next.x - anchor.x) < 0.5 && Math.abs(next.y - anchor.y) < 0.5) break; anchor = next }
      if (await head.getAttribute('aria-expanded') === 'true') await head.click()
      anchor = await anchorAt()
    }
    check(Boolean(anchor), 'webkit desktop: selecting the line shows its anchors', { trend: trend?.id, shared: (await store(page)).chartMarks.filter((m) => m.shared).map((m) => m.kind) })
    await page.mouse.move(anchor.x, anchor.y); await page.mouse.down()
    for (let i = 1; i <= 8; i += 1) { await page.mouse.move(anchor.x, anchor.y - i * 8); await page.waitForTimeout(16) }
    await page.mouse.up(); await page.waitForTimeout(1600)
    const reshaped = (await store(page)).chartMarks.find((m) => m.id === trend.id)
    check(reshaped.toPrice > trend.toPrice && reshaped.fromPrice === trend.fromPrice, 'webkit desktop: dragging an anchor reshapes the line', { trend, reshaped })
    await page.keyboard.press('Escape')
    const x1 = () => page.evaluate((id) => Number(document.querySelector(`.dhl-drawing[data-mark-id="${id}"] > line`)?.getAttribute('x1')), trend.id)
    const mid = await page.evaluate((id) => { const line = document.querySelector(`.dhl-drawing[data-mark-id="${id}"] > line`), o = document.querySelector('.dhl-chart-drawing-overlay').getBoundingClientRect(); return { x: o.left + (+line.getAttribute('x1') + +line.getAttribute('x2')) / 2, y: o.top + (+line.getAttribute('y1') + +line.getAttribute('y2')) / 2 } }, trend.id)
    const before = await x1()
    await page.mouse.move(mid.x, mid.y)
    for (let i = 0; i < 6; i += 1) { await page.mouse.wheel(-60, 0); await page.waitForTimeout(30) }
    await page.waitForTimeout(500)
    // Moved, or scrolled far enough that the line is off-screen and no longer rendered (it still exists).
    const after = await x1(), stillThere = (await store(page)).chartMarks.some((m) => m.id === trend.id)
    check(stillThere && (!Number.isFinite(after) || Math.abs(after - before) > 20), 'webkit desktop: a horizontal scroll over the drawing pans the chart', { before, after, stillThere })
    check(errors.length === 0, 'webkit desktop: no page errors', errors)
    await page.close()
  }
  // ── iPad profile: taps draw and select ──
  {
    const context = await browser.newContext({ ...devices['iPad Pro 11 landscape'] })
    const page = await context.newPage()
    const errors = []; page.on('pageerror', (e) => errors.push(String(e?.message ?? e)))
    await openDesk(page, url)
    await page.getByRole('button', { name: /新建交易会话/ }).tap()
    await page.locator('.dhl-chatmount').waitFor({ state: 'visible', timeout: 30_000 }); await waitCandles(page)
    const box = await page.locator('.dhl-chart canvas').first().boundingBox()
    const at = (fx, fy) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy })
    await page.locator('.dhl-draw-menu summary').tap(); await page.waitForTimeout(200)
    const fits = await page.evaluate(() => { const pop = document.querySelector('.dhl-draw-popover').getBoundingClientRect(), col = document.querySelector('.dhl-col-desk').getBoundingClientRect(); return pop.left >= col.left && pop.right <= col.right + 1 })
    check(fits, 'webkit iPad: the drawing menu stays inside its column (it used to spill under the sessions divider)')
    // Narrow the window while the menu is open: it re-fits to the column.
    await page.setViewportSize({ width: 1000, height: 834 }); await page.waitForTimeout(400)
    const refits = await page.evaluate(() => { const pop = document.querySelector('.dhl-draw-popover').getBoundingClientRect(), col = document.querySelector('.dhl-col-desk').getBoundingClientRect(); return pop.left >= col.left && pop.right <= col.right + 1 })
    check(refits, 'webkit iPad: with the menu open, a narrower window keeps it inside the column')
    await page.setViewportSize({ width: 1194, height: 834 }); await page.waitForTimeout(400)
    await toolItem(page, '趋势线').tap()
    const a = at(.3, .65), b = at(.5, .45)
    await page.touchscreen.tap(a.x, a.y); await page.waitForTimeout(300); await page.touchscreen.tap(b.x, b.y); await page.waitForTimeout(1600)
    const trend = (await store(page)).chartMarks.find((m) => m.kind === 'trend' && !m.shared)
    check(Boolean(trend), 'webkit iPad: two taps draw a trend line')
    const m = await page.evaluate((id) => {
      const line = document.querySelector(`.dhl-drawing[data-mark-id="${id}"] > line`), o = document.querySelector('.dhl-chart-drawing-overlay').getBoundingClientRect()
      const [x1, y1, x2, y2] = ['x1', 'y1', 'x2', 'y2'].map((key) => +line.getAttribute(key))
      for (const t of [0.5, 0.4, 0.6, 0.3, 0.7]) { const p = { x: o.left + x1 + (x2 - x1) * t, y: o.top + y1 + (y2 - y1) * t }; if (document.elementFromPoint(p.x, p.y)?.closest('[data-mark-id]')?.getAttribute('data-mark-id') === id) return p }
      return { x: o.left + (x1 + x2) / 2, y: o.top + (y1 + y2) / 2 }
    }, trend.id)
    await page.touchscreen.tap(m.x, m.y); await page.waitForTimeout(400)
    check(await page.getByRole('toolbar', { name: '画线样式' }).isVisible(), 'webkit iPad: tapping the line selects it')
    check(errors.length === 0, 'webkit iPad: no page errors', errors)
    await context.close()
  }
} finally { await browser.close() }
