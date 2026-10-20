// Trackpad: pinch (wheel + ctrlKey, as Chrome reports it) zooms the chart, not the page;
// a two-finger horizontal swipe (wheel deltaX) pans; drawings stay attached to their bars.
import { chromium, CHROME, readUrl, openDesk, store, waitCandles, check, toolItem } from './common.mjs'

const url = await readUrl()
const browser = await chromium.launch({ headless: true, executablePath: CHROME })
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e?.message ?? e)))
  await openDesk(page, url)
  await page.getByRole('button', { name: /新建交易会话/ }).click()
  await page.locator('.dhl-chatmount').waitFor({ state: 'visible', timeout: 20_000 })
  await waitCandles(page)
  const box = await page.locator('.dhl-chart canvas').first().boundingBox()
  const at = (fx, fy) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy })
  const click = async (p) => { await page.mouse.move(p.x, p.y); await page.waitForTimeout(60); await page.mouse.click(p.x, p.y); await page.waitForTimeout(200) }
  await page.locator('.dhl-draw-menu summary').click()
  await toolItem(page, '趋势线').click()
  await click(at(.35, .6)); await click(at(.55, .4)); await page.waitForTimeout(1600)
  const trend = (await store(page)).chartMarks.find((m) => m.kind === 'trend')
  check(Boolean(trend), 'trackpad: trend drawn')
  // Where the line should be, from the chart's own time→x mapping, vs where the overlay drew it.
  const geometry = () => page.evaluate((id) => {
    const line = document.querySelector(`.dhl-drawing[data-mark-id="${id}"] > line`)
    return { x1: Number(line?.getAttribute('x1')), x2: Number(line?.getAttribute('x2')), scale: window.visualViewport?.scale ?? 1 }
  }, trend.id)
  const g0 = await geometry()
  await page.mouse.move(at(.5, .5).x, at(.5, .5).y)
  await page.keyboard.down('Control')
  for (let i = 0; i < 6; i += 1) { await page.mouse.wheel(0, -40); await page.waitForTimeout(30) }
  await page.keyboard.up('Control'); await page.waitForTimeout(500)
  const g1 = await geometry()
  check(g1.scale === 1 && (g1.x2 - g1.x1) > (g0.x2 - g0.x1) * 1.1, 'trackpad: pinch-out zooms the chart (not the page) and the drawing widens with it', { g0, g1 })
  for (let i = 0; i < 6; i += 1) { await page.mouse.wheel(60, 0); await page.waitForTimeout(30) }
  await page.waitForTimeout(500)
  const g2 = await geometry()
  check(Math.abs((g2.x2 - g2.x1) - (g1.x2 - g1.x1)) < 2 && Math.abs(g2.x1 - g1.x1) > 20, 'trackpad: a two-finger horizontal swipe pans and the drawing moves with the bars', { g1, g2 })
  // With the pointer on the drawing itself (its hit stroke is on top), the gesture must still reach the chart.
  // A second line in the current view (the first one was zoomed and panned away).
  await page.locator('.dhl-draw-menu summary').click(); await toolItem(page, '趋势线').click()
  await click(at(.4, .65)); await click(at(.6, .45)); await page.waitForTimeout(1600)
  const second = (await store(page)).chartMarks.find((m) => m.kind === 'trend' && m.id !== trend.id)
  const geometry2 = () => page.evaluate((id) => { const line = document.querySelector(`.dhl-drawing[data-mark-id="${id}"] > line`); return { x1: Number(line?.getAttribute('x1')) } }, second.id)
  const mid = await page.evaluate((id) => { const line = document.querySelector(`.dhl-drawing[data-mark-id="${id}"] > line`), o = document.querySelector('.dhl-chart-drawing-overlay').getBoundingClientRect(); return { x: o.left + (+line.getAttribute('x1') + +line.getAttribute('x2')) / 2, y: o.top + (+line.getAttribute('y1') + +line.getAttribute('y2')) / 2 } }, second.id)
  const onTop = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('.dhl-chart-drawing-overlay') != null, [mid.x, mid.y])
  const g3 = await geometry2()
  await page.mouse.move(mid.x, mid.y)
  for (let i = 0; i < 6; i += 1) { await page.mouse.wheel(-60, 0); await page.waitForTimeout(30) }
  await page.waitForTimeout(500)
  const g4 = await geometry2()
  check(onTop && Math.abs(g4.x1 - g3.x1) > 20, 'trackpad: a swipe with the pointer on a drawing still pans the chart', { onTop, g3, g4 })
  check(errors.length === 0, 'trackpad: no page errors', errors)
} finally { await browser.close() }
