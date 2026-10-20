// Phase 5: multi-select with batch delete + one-step undo, undo of a first-time lock, TradingView
// shortcuts, Esc peeling one layer at a time, and the Ctrl/⌘ magnet inversion with its snap ring.
import { chromium, CHROME, readUrl, openDesk, store, waitCandles, check, toolItem, openList } from './common.mjs'
const url = await readUrl()
const browser = await chromium.launch({ headless: true, executablePath: CHROME })
try {
  const page = await browser.newPage({ viewport: { width: 2100, height: 1000 } })
  const errors = []; page.on('pageerror', (e) => errors.push(String(e?.message ?? e)))
  await openDesk(page, url)
  await page.getByRole('button', { name: /新建交易会话/ }).click()
  await page.locator('.dhl-chatmount').waitFor({ state: 'visible', timeout: 20_000 }); await waitCandles(page)
  const box = await page.locator('.dhl-chart canvas').first().boundingBox()
  const at = (fx, fy) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy })
  const clickXY = async ({ x, y }, modifiers = []) => { await page.mouse.move(x, y); await page.waitForTimeout(60); for (const key of modifiers) await page.keyboard.down(key); await page.mouse.click(x, y); for (const key of modifiers) await page.keyboard.up(key); await page.waitForTimeout(200) }
  const pick = async (name) => { await page.locator('.dhl-draw-menu summary').click(); await toolItem(page, name).click() }
  // Earlier phases leave drawings synced to every BTC session; count only this session's own.
  const marks = async () => (await store(page)).chartMarks.filter((m) => !m.shared)
  const settle = () => page.waitForTimeout(1500)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  const hostMarks = () => page.evaluate(() => { const s = window.__dhlStore.get(); return window.__dhlCall('chartMarks', { sessionId: s.activeSessionId, coin: s.activeCoin, allIntervals: true }).then((r) => r.marks.filter((m) => !m.shared)) })

  // ── two drawings, Shift-click group, batch delete, one undo restores both ──
  // Lines synced from phase4 sit on this chart too: draw ours away from them, otherwise a Shift-click
  // can land on a synced line at the same price (this was the occasional "Delete removes the whole group" failure).
  const syncedYs = await page.evaluate(() => [...document.querySelectorAll('.dhl-chart-drawing-overlay .dhl-drawing')]
    .filter((g) => window.__dhlStore.get().chartMarks.find((m) => m.id === g.getAttribute('data-mark-id'))?.shared)
    .map((g) => g.getBoundingClientRect()).flatMap((r) => [r.top, r.bottom]))
  const [fyA, fyB] = [.3, .65, .2, .45, .8, .55].filter((fy) => syncedYs.every((y) => Math.abs(y - at(.5, fy).y) > 30))
  await pick('水平线'); await clickXY(at(.5, fyA)); await settle()
  await pick('水平线'); await clickXY(at(.5, fyB)); await settle()
  check((await marks()).length === 2, 'two horizontal lines drawn')
  const lineYs = async () => page.evaluate((ids) => ids.map((id) => document.querySelector(`.dhl-chart-drawing-overlay [data-mark-id="${id}"] line`)?.getBoundingClientRect().top).filter((y) => y != null), (await marks()).map((m) => m.id))
  const ys = await lineYs()
  check(ys.length >= 2, 'both lines are on the overlay', ys)
  await clickXY({ x: at(.4, 0).x, y: ys[0] })
  await clickXY({ x: at(.4, 0).x, y: ys[ys.length - 1] }, ['Shift'])
  await page.getByRole('toolbar', { name: '批量编辑画线' }).waitFor({ state: 'visible', timeout: 5000 })
  check(await page.getByText('已选 2 条画线').isVisible(), 'Shift-click builds a two-drawing selection with a batch toolbar')
  const groupIds = (await marks()).map((m) => m.id)
  await page.keyboard.press('Delete')
  // The host round trip can take longer than a fixed settle under a full smoke run: wait for the outcome.
  const deleteAt = Date.now()
  for (let t = 0; t < 25 && ((await marks()).length || (await hostMarks()).length); t += 1) await page.waitForTimeout(200)
  console.log(`group delete reached the host after ${Date.now() - deleteAt}ms`)
  check((await marks()).length === 0 && (await hostMarks()).length === 0, 'Delete removes the whole group', { groupIds, local: (await marks()).map((m) => [m.id, m.kind, m.source, m.shared ?? false, m.sessionId?.slice(-6)]), host: (await hostMarks()).map((m) => [m.id, m.kind, m.source, m.shared ?? false]), session: (await store(page)).activeSessionId?.slice(-6), notice: await page.locator('[role=status], [role=alert]').allInnerTexts().catch(() => []) })
  await page.keyboard.press(`${mod}+z`); await page.waitForTimeout(2500)
  check((await marks()).length === 2 && (await hostMarks()).length === 2, 'one undo restores the whole group', { local: (await marks()).length, host: (await hostMarks()).length })

  // ── group drag moves both lines together (one undo step) and the batch toolbar recolors them ──
  const prices0 = (await marks()).map((m) => m.price).sort((x, y) => x - y)
  const ys1 = await lineYs()
  await clickXY({ x: at(.4, 0).x, y: ys1[0] })
  const singleBar = await page.getByRole('toolbar', { name: '画线样式' }).boundingBox()
  check(singleBar && singleBar.height <= 44, 'the floating toolbar stays one row on a narrow chart', singleBar)
  await clickXY({ x: at(.4, 0).x, y: ys1[1] }, ['Shift'])
  await page.mouse.move(at(.4, 0).x, ys1[0]); await page.mouse.down(); await page.mouse.move(at(.42, 0).x, ys1[0] + 40, { steps: 10 }); await page.mouse.up(); await settle()
  const prices1 = (await marks()).map((m) => m.price).sort((x, y) => x - y)
  check(prices1.every((p, i) => p < prices0[i]) && Math.abs((prices0[0] - prices1[0]) - (prices0[1] - prices1[1])) < 1e-6 * prices0[0], 'dragging a grouped line moves the whole group by the same offset', { prices0, prices1 })
  await page.getByRole('toolbar', { name: '批量编辑画线' }).getByRole('button', { name: '全部改为 #ef5f6c' }).click(); await settle()
  check((await hostMarks()).every((m) => m.color === '#ef5f6c'), 'the batch toolbar recolors every selected drawing')
  await page.keyboard.press('Escape')
  await page.keyboard.press(`${mod}+z`); await settle(); await page.keyboard.press(`${mod}+z`); await settle()
  const prices2 = (await hostMarks()).map((m) => m.price).sort((x, y) => x - y)
  check(prices2.every((p, i) => Math.abs(p - prices0[i]) < 1e-9 * p) && (await hostMarks()).every((m) => !m.color), 'two undos restore color and the group move', { prices0, prices2 })

  // ── first-time lock, then undo: the host must unlock too (undo used to send null, which the host ignored) ──
  const ys2 = await lineYs()
  await clickXY({ x: at(.4, 0).x, y: ys2[0] })
  await page.getByRole('toolbar', { name: '画线样式' }).getByRole('button', { name: '锁定' }).click(); await settle()
  check((await hostMarks()).some((m) => m.locked), 'lock reaches the host')
  await page.keyboard.press('Escape')
  await page.keyboard.press(`${mod}+z`); await settle()
  check((await hostMarks()).every((m) => !m.locked) && (await marks()).every((m) => !m.locked), 'undoing a first lock unlocks on the host as well')

  // ── shortcuts and Esc layering in the expanded chart ──
  await page.getByRole('button', { name: '全屏图表' }).click(); await page.waitForTimeout(600)
  const expanded = () => page.locator('.dhl-chart-panel-expanded').count()
  await page.keyboard.press('Alt+KeyT'); await page.waitForTimeout(200)
  check(await page.locator('.dhl-chart-drawing-overlay.drawing').count() === 1, 'Alt+T starts the trend line tool')
  await page.keyboard.press('Escape'); await page.waitForTimeout(200)
  check(await page.locator('.dhl-chart-drawing-overlay.drawing').count() === 0 && await expanded() === 1, 'first Esc only cancels the tool; the chart stays expanded')
  await page.keyboard.press('Escape'); await page.waitForTimeout(300)
  check(await expanded() === 0, 'second Esc leaves the expanded chart')

  // ── magnet: off by default; holding Ctrl/⌘ snaps to O/H/L/C and shows the ring ──
  const box2 = await page.locator('.dhl-chart canvas').first().boundingBox()
  await page.keyboard.press('Alt+KeyH'); await page.waitForTimeout(150)
  const mid = { x: box2.x + box2.width * .55, y: box2.y + box2.height * .12 }
  await page.mouse.move(mid.x, mid.y); await page.mouse.move(mid.x + 3, mid.y + 2); await page.waitForTimeout(200)
  check(await page.locator('.dhl-snap-ring').count() === 0, 'magnet off: no snap ring')
  await page.keyboard.down('Control'); await page.mouse.move(mid.x + 6, mid.y + 4); await page.waitForTimeout(200)
  check(await page.locator('.dhl-snap-ring').count() === 1, 'holding Ctrl turns the magnet on and shows where it snaps')
  await page.keyboard.up('Control'); await page.keyboard.press('Escape')

  // ── Shift constrains a trend line to 45° (or horizontal) on screen ──
  await page.keyboard.press('Escape')
  const angleOf = async (id) => page.evaluate((markId) => { const l = document.querySelector(`.dhl-chart-drawing-overlay [data-mark-id="${markId}"] line`); const [x1, y1, x2, y2] = ['x1', 'y1', 'x2', 'y2'].map((k) => Number(l.getAttribute(k))); return Math.atan2(-(y2 - y1), x2 - x1) * 180 / Math.PI }, id)
  const drawTrend = async (from, to) => {
    const before = new Set((await marks()).map((m) => m.id))
    await page.keyboard.press('Alt+KeyT'); await page.waitForTimeout(150)
    await clickXY(from); await page.keyboard.down('Shift'); await page.mouse.move(to.x, to.y, { steps: 4 }); await page.mouse.click(to.x, to.y); await page.keyboard.up('Shift'); await settle()
    return (await marks()).find((m) => !before.has(m.id) && m.kind === 'trend')
  }
  const b5 = await page.locator('.dhl-chart canvas').first().boundingBox()
  const steep = await drawTrend({ x: b5.x + b5.width * .3, y: b5.y + b5.height * .7 }, { x: b5.x + b5.width * .3 + 100, y: b5.y + b5.height * .7 - 85 })
  const steepAngle = await angleOf(steep.id)
  check(Math.abs(steepAngle - 45) < 4, `Shift snaps a ~40° drag to 45° (${steepAngle.toFixed(1)}°)`)
  const flat = await drawTrend({ x: b5.x + b5.width * .3, y: b5.y + b5.height * .4 }, { x: b5.x + b5.width * .3 + 160, y: b5.y + b5.height * .4 - 25 })
  check(flat.fromPrice === flat.toPrice, 'Shift snaps a shallow drag to horizontal')

  // ── custom Fibonacci levels from the toolbar ──
  await page.keyboard.press('Alt+KeyF'); await page.waitForTimeout(150)
  await clickXY({ x: b5.x + b5.width * .55, y: b5.y + b5.height * .75 }); await clickXY({ x: b5.x + b5.width * .7, y: b5.y + b5.height * .35 }); await settle()
  const fib = (await marks()).find((m) => m.kind === 'fib')
  await (await openList(page)).getByRole('button', { name: /斐波那契/ }).first().click()
  const levelsBox = page.getByRole('toolbar', { name: '画线样式' }).getByLabel('斐波那契层级（逗号分隔）')
  await levelsBox.fill('0, 0.5, 1, 1.618'); await levelsBox.press('Enter'); await settle()
  check(JSON.stringify((await hostMarks()).find((m) => m.id === fib.id)?.levels) === '[0,0.5,1,1.618]' && (await page.locator(`.dhl-chart-drawing-overlay .dhl-drawing[data-mark-id="${fib.id}"]`).first().textContent()).includes('1.618 ('), 'custom fib levels are saved and drawn')
  await page.keyboard.press('Escape')

  // ── volume profile settings from the toolbar ──
  await page.keyboard.press('Escape')
  await page.locator('.dhl-draw-menu summary').click(); await toolItem(page, '固定范围成交量分布').click()
  await clickXY({ x: box2.x + box2.width * .3, y: box2.y + box2.height * .5 }); await clickXY({ x: box2.x + box2.width * .6, y: box2.y + box2.height * .5 }); await settle()
  const vp = (await marks()).find((m) => m.kind === 'vprofile')
  check(Boolean(vp), 'volume profile drawn')
  await (await openList(page)).getByRole('button', { name: /成交量分布|固定范围/ }).first().click()
  await page.getByRole('toolbar', { name: '画线样式' }).getByLabel('价格行数').selectOption('96'); await settle()
  const profileRows = await page.locator(`[data-mark-id="${vp.id}"] > .dhl-vprofile`).first().evaluate((node) => [...node.querySelectorAll('.dhl-vprofile-up, .dhl-vprofile-down')].reduce((sum, path) => sum + (path.getAttribute('d')?.match(/M/g)?.length ?? 0), 0) / 2)
  check((await hostMarks()).find((m) => m.id === vp.id)?.rows === 96 && profileRows === 96, 'changing rows to 96 re-bins and draws all 96 profile rows')

  // ── custody switch: 全托管 asks first on live, shows a badge, and switches back ──
  await page.keyboard.press('Escape')
  const custody = () => page.evaluate(() => window.__dhlStore.get().status?.custody)
  await page.locator('.dhl-more-trigger').click()
  await page.getByRole('group', { name: '托管模式' }).getByRole('button', { name: '全托管' }).click()
  if (await page.evaluate(() => window.__dhlStore.get().status?.tradingMode) === 'live') {
    await page.getByRole('button', { name: '开启全托管' }).last().click()
  }
  await page.waitForFunction(() => window.__dhlStore.get().status?.custody === 'managed', null, { timeout: 10_000 })
  check(await page.locator('.dhl-badge.managed').isVisible(), 'managed custody shows a badge in the top bar')
  await page.locator('.dhl-more-trigger').click()
  await page.getByRole('group', { name: '托管模式' }).getByRole('button', { name: '半托管' }).click()
  await page.waitForFunction(() => window.__dhlStore.get().status?.custody === 'assisted', null, { timeout: 10_000 })
  check(await custody() === 'assisted' && await page.locator('.dhl-badge.managed').count() === 0, 'switching back to assisted removes it')

  // ── TradingView object properties: show on this interval only, background fill ──
  await page.keyboard.press('Escape')
  await page.keyboard.press('Alt+Shift+KeyR'); await page.waitForTimeout(150)
  const b6 = await page.locator('.dhl-chart canvas').first().boundingBox()
  await clickXY({ x: b6.x + b6.width * .35, y: b6.y + b6.height * .3 }); await clickXY({ x: b6.x + b6.width * .45, y: b6.y + b6.height * .45 }); await settle()
  const box6 = (await marks()).find((m) => m.kind === 'rect')
  await (await openList(page)).getByRole('button', { name: /矩形/ }).first().click()
  const bar = page.getByRole('toolbar', { name: '画线样式' })
  await bar.getByLabel('背景填充').selectOption('0.32'); await settle()
  await bar.getByRole('button', { name: '仅本周期显示' }).click(); await settle()
  const saved6 = (await hostMarks()).find((m) => m.id === box6.id)
  const here = await page.evaluate(() => window.__dhlStore.get().interval)
  check(saved6?.fillOpacity === 0.32 && JSON.stringify(saved6?.visibleIntervals) === JSON.stringify([here]), 'fill and interval visibility are saved', saved6)
  await page.keyboard.press('Escape')
  const other = here === '1h' ? '4h' : '1h'
  await page.getByRole('button', { name: other, exact: true }).first().click(); await page.waitForTimeout(2500)
  check(await page.locator(`.dhl-chart-drawing-overlay [data-mark-id="${box6.id}"]`).count() === 0 && await (await openList(page)).getByText(`仅 ${here} 显示`).count() > 0, 'on another interval it is hidden from the chart but listed', { overlay: await page.locator(`.dhl-chart-drawing-overlay [data-mark-id="${box6.id}"]`).count(), interval: await page.evaluate(() => window.__dhlStore.get().interval), selected: await page.locator('.dhl-draw-toolbar').count(), list: (await (await openList(page)).innerText()).slice(0, 300) })
  await page.getByRole('button', { name: here, exact: true }).first().click(); await page.waitForTimeout(2500)
  check(await page.locator(`.dhl-chart-drawing-overlay [data-mark-id="${box6.id}"]`).count() > 0, 'back on its interval it is drawn again')

  // A level limited to its interval: no native axis line on another interval either.
  const levelsBefore = (await marks()).filter((m) => m.kind === 'level').map((m) => m.id)
  await page.keyboard.press('Alt+KeyH'); await page.waitForTimeout(150)
  await clickXY({ x: b6.x + b6.width * .5, y: b6.y + b6.height * .22 }); await settle()
  const lvl = (await marks()).find((m) => m.kind === 'level' && !levelsBefore.includes(m.id))
  check(Boolean(lvl), 'Alt+H places a level', (await marks()).map((m) => m.kind))
  await (await openList(page)).locator(`[data-mark-id="${lvl.id}"] .dhl-drawing-list-name`).click()
  await bar.getByRole('button', { name: '仅本周期显示' }).click(); await settle()
  await page.keyboard.press('Escape')
  const priceLineCount = () => page.evaluate(() => window.__dhlPriceLines?.() ?? -1)
  const linesHere = await priceLineCount()
  await page.getByRole('button', { name: other, exact: true }).first().click(); await page.waitForTimeout(2500)
  const linesThere = await priceLineCount()
  check(Boolean(lvl) && linesHere > 0 && linesThere === linesHere - 1, 'a level limited to its interval draws no axis line elsewhere', { lvl: lvl?.id, linesHere, linesThere })
  await page.getByRole('button', { name: here, exact: true }).first().click(); await page.waitForTimeout(2500)

  // Text emphasis and the single-drawing hide button.
  await (await openList(page)).getByRole('button', { name: /矩形/ }).first().click()
  await bar.getByRole('button', { name: '隐藏画线' }).click(); await settle()
  check((await hostMarks()).find((m) => m.id === box6.id)?.hidden === true && await page.locator(`.dhl-chart-drawing-overlay [data-mark-id="${box6.id}"]`).count() === 0, 'the toolbar hide button hides the drawing')

  // Trend line extension (TradingView's extend left / right).
  const trendsBefore = (await marks()).filter((m) => m.kind === 'trend').map((m) => m.id)
  await page.keyboard.press('Alt+KeyT'); await page.waitForTimeout(150)
  await clickXY({ x: b6.x + b6.width * .3, y: b6.y + b6.height * .6 }); await clickXY({ x: b6.x + b6.width * .4, y: b6.y + b6.height * .5 }); await settle()
  const tl = (await marks()).find((m) => m.kind === 'trend' && !trendsBefore.includes(m.id))
  await (await openList(page)).locator(`[data-mark-id="${tl.id}"] .dhl-drawing-list-name`).click()
  const tlRight = () => page.evaluate((id) => document.querySelector(`.dhl-chart-drawing-overlay [data-mark-id="${id}"] line`)?.getBoundingClientRect().right ?? 0, tl.id)
  const shortRight = await tlRight()
  await bar.getByRole('button', { name: '向右延长' }).click(); await settle()
  const longRight = await tlRight()
  check((await hostMarks()).find((m) => m.id === tl.id)?.extendRight === true && longRight > shortRight + b6.width * .2, 'extend right is saved and the line runs past its anchor', { shortRight, longRight })
  await page.keyboard.press('Escape')

  check(errors.length === 0, 'no page errors', errors)
  console.log('phase5 ok')
} finally { await browser.close() }
