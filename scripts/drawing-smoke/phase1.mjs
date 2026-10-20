// Phase 1: drawing interactions in a real DSH host.
import { writeFileSync } from 'node:fs'
import { chromium, CHROME, STATE_FILE, readUrl, openDesk, store, waitCandles, check, toolItem, openList } from './common.mjs'

const url = await readUrl()
const browser = await chromium.launch({ headless: true, executablePath: CHROME })
try {
  const page = await browser.newPage({ viewport: { width: 2100, height: 1000 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e?.message ?? e)))
  await openDesk(page, url)
  await page.getByRole('button', { name: /新建交易会话/ }).click()
  await page.locator('.dhl-chatmount').waitFor({ state: 'visible', timeout: 20_000 })
  await waitCandles(page)
  const s1 = (await store(page)).activeSessionId

  const canvas = page.locator('.dhl-chart canvas').first()
  const box = await canvas.boundingBox()
  const at = (fx, fy) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy })
  const clickAt = async (fx, fy) => { const p = at(fx, fy); await page.mouse.move(p.x, p.y); await page.waitForTimeout(80); await page.mouse.click(p.x, p.y); await page.waitForTimeout(200) }
  const pick = async (name) => {
    await page.locator('.dhl-draw-menu summary').click()
    await toolItem(page, name).click()
  }
  const settle = () => page.waitForTimeout(1600) // host event → desk reload
  const marks = async () => (await store(page)).chartMarks
  const drag = async (from, to) => {
    await page.mouse.move(from.x, from.y); await page.mouse.down()
    for (let i = 1; i <= 8; i += 1) { await page.mouse.move(from.x + (to.x - from.x) * i / 8, from.y + (to.y - from.y) * i / 8); await page.waitForTimeout(16) }
    await page.mouse.up(); await page.waitForTimeout(150)
  }
  const lineOf = (id) => page.evaluate((markId) => {
    const g = document.querySelector(`.dhl-drawing[data-mark-id="${markId}"]`), line = g?.querySelector(':scope > line'), o = document.querySelector('.dhl-chart-drawing-overlay').getBoundingClientRect()
    return line ? { x1: o.left + +line.getAttribute('x1'), y1: o.top + +line.getAttribute('y1'), x2: o.left + +line.getAttribute('x2'), y2: o.top + +line.getAttribute('y2') } : null
  }, id)
  const anchorOf = (id, index) => page.evaluate(([markId, i]) => {
    const c = document.querySelector(`circle.dhl-chart-anchor[data-mark-id="${markId}"][data-anchor="${i}"]`), o = document.querySelector('.dhl-chart-drawing-overlay').getBoundingClientRect()
    return c ? { x: o.left + +c.getAttribute('cx'), y: o.top + +c.getAttribute('cy') } : null
  }, [id, index])

  // ── trend: draw, select, move, reshape ──
  await pick('趋势线'); await clickAt(.3, .62); await clickAt(.5, .42); await settle()
  let trend = (await marks()).find((m) => m.kind === 'trend')
  check(Boolean(trend), 'trend drawn')
  const line = await lineOf(trend.id)
  const mid = { x: (line.x1 + line.x2) / 2, y: (line.y1 + line.y2) / 2 }
  await drag(mid, { x: mid.x + 90, y: mid.y + 40 }); await settle()
  let moved = (await marks()).find((m) => m.id === trend.id)
  check(moved.fromTime > trend.fromTime && moved.fromPrice < trend.fromPrice && Math.abs((moved.toPrice - moved.fromPrice) - (trend.toPrice - trend.fromPrice)) < 1e-6 * trend.fromPrice, 'body drag moves the whole trend (shape kept, saved on host)', { trend, moved })
  check(await page.locator('.dhl-draw-toolbar').isVisible(), 'selecting shows the floating style toolbar')
  const end = await anchorOf(trend.id, 1)
  await drag(end, { x: end.x, y: end.y - 70 }); await settle()
  const reshaped = (await marks()).find((m) => m.id === trend.id)
  check(reshaped.toPrice > moved.toPrice && reshaped.fromPrice === moved.fromPrice, 'anchor drag reshapes one end only', { moved, reshaped })

  // ── style toolbar, lock, delete key ──
  await page.locator('.dhl-draw-toolbar .dhl-swatch').nth(2).click(); await settle()
  check((await marks()).find((m) => m.id === trend.id).color === '#ef5f6c', 'color applied and persisted')
  await page.locator('.dhl-draw-toolbar').getByRole('button', { name: '线宽 3' }).click()
  await page.locator('.dhl-draw-toolbar').getByRole('button', { name: '虚线' }).click(); await settle()
  const styled = (await marks()).find((m) => m.id === trend.id)
  check(styled.lineWidth === 3 && styled.lineStyle === 'dashed', 'width and line style persisted', styled)
  await page.locator('.dhl-draw-toolbar').getByRole('button', { name: '锁定' }).click(); await settle()
  const locked = (await marks()).find((m) => m.id === trend.id)
  const lockedLine = await lineOf(trend.id)
  await drag({ x: (lockedLine.x1 + lockedLine.x2) / 2, y: (lockedLine.y1 + lockedLine.y2) / 2 }, { x: lockedLine.x1 + 200, y: lockedLine.y1 }); await settle()
  const after = (await marks()).find((m) => m.id === trend.id)
  check(locked.locked && after.fromTime === locked.fromTime && after.fromPrice === locked.fromPrice, 'a locked drawing does not move')
  await page.keyboard.press('Delete'); await page.waitForTimeout(300)
  check((await marks()).some((m) => m.id === trend.id), 'Delete is refused while locked')
  await page.locator('.dhl-draw-toolbar').getByRole('button', { name: '解锁' }).click(); await settle()
  await page.keyboard.press('Delete'); await settle()
  check(!(await marks()).some((m) => m.id === trend.id), 'Delete key removes the selected drawing')

  // ── strong magnet ──
  await page.locator('.dhl-draw-menu summary').click()
  await page.getByRole('radio', { name: '强' }).click()
  await toolItem(page, '水平射线').click()
  await clickAt(.45, .37); await settle()
  const hray = (await marks()).find((m) => m.kind === 'hray')
  const bar = await page.evaluate((time) => window.__dhlStore.get().candles.find((c) => Math.floor(c.t / 1000) === Math.floor(time / 1000)), hray.points[0].time)
  check(bar && [bar.o, bar.h, bar.l, bar.c].includes(hray.points[0].price), 'strong magnet snaps to that bar’s O/H/L/C', { point: hray.points[0], bar })
  await page.locator('.dhl-draw-menu summary').click(); await page.getByRole('radio', { name: '关' }).click(); await page.locator('.dhl-draw-menu summary').click()

  // ── text + long position ──
  await pick('文本'); await clickAt(.3, .25)
  await page.getByRole('dialog').getByRole('textbox').fill('放量突破，回踩不破继续看多')
  await page.getByRole('dialog').getByRole('button', { name: '添加' }).click(); await settle()
  check((await marks()).some((m) => m.kind === 'text' && m.label === '放量突破，回踩不破继续看多'), 'text tool saves typed text')
  await pick('多头头寸'); await clickAt(.6, .5); await clickAt(.72, .6); await settle()
  const long = (await marks()).find((m) => m.kind === 'long')
  const [entry, stop, target] = long?.points ?? []
  check(long && stop.price < entry.price && Math.abs(target.price - (entry.price + 2 * (entry.price - stop.price))) < 1e-6 * entry.price, 'long position: 2 clicks → entry/stop/target at 2R', long)
  check((await page.locator('.dhl-position-text').allTextContents()).some((t) => t.includes('R:R 2.00')), 'position shows R:R')

  // ── the "click ignored" race, reproduced in the live chart ──
  // A new candle lands between press and release. With the old rule (test switch on) the second
  // click of a trend line is dropped — the original 1-in-5 bug; with the shipped rule it lands.
  const race = async (legacy) => {
    await page.evaluate((on) => { globalThis.__dhlLegacyClickGuard = on }, legacy)
    await pick('趋势线'); await clickAt(.2, .7)
    const before = (await marks()).length
    const p2 = at(.35, .55)
    await page.mouse.move(p2.x, p2.y); await page.mouse.down()
    await page.evaluate(() => { const s = window.__dhlStore.get(); const last = s.candles.at(-1), prev = s.candles.at(-2); const step = last.t - prev.t
      window.__dhlStore.patch({ candles: [...s.candles, { ...last, t: last.t + step, o: last.c, h: last.c, l: last.c, c: last.c, v: 0 }] }) })
    await page.waitForTimeout(250)
    await page.mouse.up(); await settle()
    await page.keyboard.press('Escape')
    await page.evaluate(() => { delete globalThis.__dhlLegacyClickGuard })
    return (await marks()).length - before
  }
  check(await race(true) === 0, 'reproduced in the real chart: with the old rule a click is dropped when a new candle arrives mid-click')
  const landed = await race(false)
  check(landed === 1, 'with the shipped rule the same click lands', { landed, marks: (await marks()).map((m) => [m.kind, m.points?.length ?? 0]), notice: await page.evaluate(() => window.__dhlStore.get().notice) })

  // ── realtime: another writer (second page) changes this session's drawings ──
  const other = await browser.newPage({ viewport: { width: 1600, height: 900 } })
  await openDesk(other, url)
  await other.locator(`[data-session-id="${s1}"]`).click()
  await waitCandles(other) // let the second desk settle its layout before using its list
  await other.waitForFunction((n) => window.__dhlStore.get().chartMarks.length === n, (await marks()).length, { timeout: 15_000 })
  const textMark = (await marks()).find((m) => m.kind === 'text')
  await (await openList(other)).getByRole('button', { name: `删除画线 ${textMark.label}` }).click({ timeout: 8000 }).catch(async (error) => { console.log('ELEMENT', await other.evaluate(() => { const b = [...document.querySelectorAll('.dhl-drawing-list li')].map((li) => li.getBoundingClientRect().top); const c = document.querySelector('.dhl-chartbox').getBoundingClientRect(); return JSON.stringify({ rows: b, chart: [c.top, c.bottom], scroll: document.querySelector('.dhl-col-desk').scrollTop }) })); throw error })
  await page.waitForFunction((id) => !window.__dhlStore.get().chartMarks.some((m) => m.id === id), textMark.id, { timeout: 5000 })
    .then(() => check(true, 'a change from another writer shows up live (no reload)'), () => check(false, 'live update from another writer'))
  await other.close()

  // ── per-session state: drawings and MAs follow the session ──
  await page.locator('.dhl-indicator-menu summary').click()
  await page.locator('.dhl-ma-presets button', { hasText: 'SMMA 21' }).click()
  await page.locator('.dhl-indicator-menu summary').click()
  await settle()
  const s1Marks = (await marks()).map((m) => m.id).sort()
  await page.getByRole('button', { name: /新建交易会话/ }).click()
  await page.waitForFunction((id) => window.__dhlStore.get().activeSessionId && window.__dhlStore.get().activeSessionId !== id, s1, { timeout: 20_000 })
  await waitCandles(page)
  const s2 = (await store(page)).activeSessionId
  check((await marks()).length === 0 && (await store(page)).maLines.length === 0, 'a new session starts with no drawings and no MAs')
  await pick('垂直线'); await clickAt(.5, .5); await settle()
  const s2Marks = (await marks()).map((m) => m.id)
  await page.locator(`[data-session-id="${s1}"]`).click()
  await page.waitForFunction((ids) => JSON.stringify(window.__dhlStore.get().chartMarks.map((m) => m.id).sort()) === JSON.stringify(ids), s1Marks, { timeout: 15_000 })
  check((await store(page)).maLines.map((l) => l.id).join() === 'smma21', 'switching back restores this session’s drawings and MAs')

  writeFileSync(STATE_FILE, JSON.stringify({ s1, s2, s1Marks, s2Marks, longId: long.id, hrayId: hray.id }))
  check(errors.length === 0, 'no page errors', errors)
} finally { await browser.close() }
