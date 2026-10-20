// The 0.5.0 tools (TradingView's remaining common set), each drawn by real clicks in a fresh session.
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
  const clickAt = async (fx, fy) => { const p = at(fx, fy); await page.mouse.move(p.x, p.y); await page.waitForTimeout(60); await page.mouse.click(p.x, p.y); await page.waitForTimeout(160) }
  const pick = async (name) => { await page.locator('.dhl-draw-menu summary').click(); await toolItem(page, name).click() }
  // Own drawings only: earlier phases leave lines synced to every BTC session.
  const marks = async () => (await store(page)).chartMarks.filter((m) => !m.shared)
  const settle = () => page.waitForTimeout(1300)

  // The menu holds 66 tools: its search narrows them.
  await page.locator('.dhl-draw-menu summary').click()
  await page.getByRole('searchbox', { name: '搜索画线工具' }).fill('vwap')
  check(await page.getByRole('menuitemradio').count() === 1 && await toolItem(page, '锚定 VWAP').count() === 1, 'searching the drawing menu for "vwap" leaves only anchored VWAP')
  await page.getByRole('searchbox', { name: '搜索画线工具' }).fill('斐波那契')
  check(await page.getByRole('menuitemradio').count() === 10, 'searching 斐波那契 lists the 10 Fibonacci tools')
  await page.getByRole('searchbox', { name: '搜索画线工具' }).fill('')
  await page.locator('.dhl-draw-menu summary').click()

  const plan = [
    ['平顶/平底通道', 'flatchannel', [[.1, .7], [.2, .5], [.15, .3]]], ['分离通道', 'disjoint', [[.22, .7], [.3, .55], [.22, .3]]],
    ['斐波那契速度阻力扇', 'fibfan', [[.33, .8], [.4, .5]]], ['斐波那契圆', 'fibcircles', [[.45, .5], [.47, .45]]],
    ['斐波那契弧', 'fibarcs', [[.5, .8], [.55, .6]]], ['斐波那契楔形', 'fibwedge', [[.58, .5], [.66, .35], [.66, .65]]],
    ['基于趋势的斐波那契时间', 'fibtrendtime', [[.1, .9], [.14, .8], [.16, .85]]],
    ['Cypher 形态', 'cypher', [[.7, .8], [.73, .4], [.76, .6], [.79, .3], [.82, .65]]],
    ['三驱形态', 'threedrives', [[.1, .3], [.13, .5], [.15, .4], [.18, .6], [.2, .5], [.23, .7]]],
    ['三角形态', 'tripattern', [[.25, .3], [.28, .7], [.31, .38], [.34, .62]]],
    ['艾略特三角浪', 'elliotttri', [[.36, .3], [.39, .7], [.42, .35], [.45, .65], [.48, .4], [.51, .6]]],
    ['艾略特双重组合', 'elliottwxy', [[.53, .3], [.56, .6], [.59, .45], [.62, .75]]],
    ['艾略特三重组合', 'elliottwxyxz', [[.64, .2], [.66, .4], [.68, .3], [.7, .5], [.72, .4], [.74, .6]]],
    ['周期线', 'cycles', [[.3, .9], [.36, .9]]], ['正弦线', 'sine', [[.4, .15], [.46, .25]]],
    ['椭圆', 'ellipse', [[.76, .2], [.84, .35]]], ['旋转矩形', 'rotrect', [[.85, .5], [.9, .4], [.9, .55]]],
    ['弧线', 'arc', [[.6, .9], [.7, .9], [.65, .8]]], ['曲线', 'curve', [[.72, .9], [.82, .9], [.77, .75]]],
    ['预测', 'forecast', [[.5, .55], [.6, .4]]], ['斐波那契螺旋', 'fibspiral', [[.45, .7], [.48, .7]]], ['K 线形态', 'barspattern', [[.3, .5], [.36, .5], [.86, .3]]], ['投影', 'projection', [[.6, .7], [.7, .7], [.7, .55]]], ['固定江恩方格', 'gannfixed', [[.05, .9], [.12, .7]]], ['内部叉子线', 'insidepitchfork', [[.1, .7], [.2, .35], [.22, .65]]], ['锚定 VWAP', 'avwap', [[.4, .5]]], ['锚定成交量分布', 'avprofile', [[.6, .5]]],
  ]
  for (const [name, kind, clicks] of plan) {
    await pick(name)
    for (const [fx, fy] of clicks) await clickAt(fx, fy)
    await settle()
    const mark = (await marks()).find((m) => m.kind === kind && m.points?.length === clicks.length)
    check(Boolean(mark) && await page.locator(`.dhl-chart-drawing-overlay .dhl-drawing[data-mark-id="${mark.id}"]`).count() === 1, `${name} drawn with ${clicks.length} anchors and rendered`)
  }
  const vwapText = await page.locator('.dhl-chart-drawing-overlay text', { hasText: /^VWAP / }).first().textContent()
  check(/^VWAP [\d,.]+$/.test(vwapText ?? ''), `anchored VWAP shows its value (${vwapText})`)
  check(await page.locator('.dhl-chart-drawing-overlay .dhl-vprofile').count() >= 1, 'anchored volume profile renders bars from the anchor to now')

  // Text tools prompt for their text, like the callout.
  for (const [name, kind, clicks, value] of [['便签', 'note', [[.15, .15]], '等回踩确认'], ['价格便签', 'pricenote', [[.3, .5], [.33, .4]], '止盈一'], ['路标', 'signpost', [[.55, .5]], 'FOMC']]) {
    await pick(name)
    for (const [fx, fy] of clicks) await clickAt(fx, fy)
    await page.getByRole('dialog').getByRole('textbox').fill(value); await page.getByRole('dialog').getByRole('button', { name: '添加' }).click(); await settle()
    const mark = (await marks()).find((m) => m.kind === kind && m.label === value)
    check(Boolean(mark) && await page.locator('.dhl-chart-drawing-overlay text', { hasText: value }).count() > 0, `${name} drawn with its text`)
  }

  // Path: click points, double-click the last one to finish. Polyline: Enter finishes.
  await pick('路径')
  for (const [fx, fy] of [[.2, .85], [.25, .75], [.3, .82]]) await clickAt(fx, fy)
  { const last = at(.3, .82); await page.mouse.dblclick(last.x, last.y) }
  await settle()
  const path = (await marks()).find((m) => m.kind === 'path')
  check(path?.points.length === 3 && await page.locator(`.dhl-drawing[data-mark-id="${path.id}"] > .dhl-arrow-head`).count() === 1, 'path: three clicks and a double-click make a 3-point path with an arrow', path?.points.length)
  await pick('折线')
  for (const [fx, fy] of [[.5, .88], [.55, .8], [.6, .86], [.65, .78]]) await clickAt(fx, fy)
  await page.keyboard.press('Enter'); await settle()
  check((await marks()).find((m) => m.kind === 'polyline')?.points.length === 4, 'polyline: Enter finishes after four clicks')
  // Ghost feed: a clicked path, finished by double-click, becomes imagined candles.
  await pick('幽灵 K 线')
  for (const [fx, fy] of [[.86, .5], [.9, .4]]) await clickAt(fx, fy)
  { const g = at(.94, .45); await page.mouse.dblclick(g.x, g.y) }
  await settle()
  const ghost = (await marks()).find((m) => m.kind === 'ghostfeed')
  const candlesDrawn = ghost ? Number(await page.locator(`.dhl-drawing[data-mark-id="${ghost.id}"] > .dhl-ghost`).getAttribute('data-candles')) : 0
  check(ghost?.points.length === 3 && candlesDrawn >= 5, `幽灵 K 线 draws imagined candles along a 3-point path (${candlesDrawn})`, ghost?.points.length)

  // Stay in drawing mode: the second click of the finishing double-click must not start the next polyline.
  await page.locator('.dhl-draw-menu summary').click(); await page.getByLabel('连续绘制').check(); await page.locator('.dhl-draw-menu summary').click()
  await pick('折线')
  const before = (await marks()).filter((m) => m.kind === 'polyline').length
  await clickAt(.12, .2); await clickAt(.16, .25); { const q = at(.2, .2); await page.mouse.dblclick(q.x, q.y) }
  await page.waitForTimeout(400)
  await clickAt(.24, .25); await clickAt(.28, .2); await page.keyboard.press('Enter'); await settle()
  const lines = (await marks()).filter((m) => m.kind === 'polyline').slice(before)
  check(lines.length === 2 && lines[0].points.length === 3 && lines[1].points.length === 2, 'stay-drawing: a double-click finishes one polyline without seeding the next', lines.map((m) => m.points.length))
  await page.keyboard.press('Escape')
  await page.locator('.dhl-draw-menu summary').click(); await page.getByLabel('连续绘制').uncheck(); await page.locator('.dhl-draw-menu summary').click()
  // Highlighter: drag.
  await pick('荧光笔')
  { const h0 = at(.1, .6); await page.mouse.move(h0.x, h0.y); await page.mouse.down(); for (let i = 1; i <= 25; i += 1) await page.mouse.move(h0.x + i * 8, h0.y + Math.sin(i / 3) * 15); await page.mouse.up() }
  await settle()
  const hl = (await marks()).find((m) => m.kind === 'highlighter')
  check(hl?.points.length >= 10 && await page.locator(`.dhl-drawing[data-mark-id="${hl.id}"] > .dhl-highlighter`).count() === 1, `highlighter records a freehand stroke (${hl?.points.length} points)`)
  // Pin with its note; the bars pattern copies real bars.
  await pick('图钉'); await clickAt(.7, .6)
  await page.getByRole('dialog').getByRole('textbox').fill('加仓点'); await page.getByRole('dialog').getByRole('button', { name: '添加' }).click(); await settle()
  check(await page.locator('.dhl-chart-drawing-overlay .dhl-drawing > .dhl-pin text', { hasText: '加仓点' }).count() === 1, '图钉 shows its note')
  const copied = await page.locator('.dhl-chart-drawing-overlay .dhl-bars-copy').first().getAttribute('data-bars')
  check(Number(copied) >= 3, `K 线形态 copies the source bars (${copied})`)

  // Anchored text stays put on screen while the chart pans; dragging it moves its screen spot.
  const boxOf = (id) => page.evaluate((markId) => { const r = document.querySelector(`.dhl-drawing[data-mark-id="${markId}"] > g > .dhl-text-box, .dhl-drawing[data-mark-id="${markId}"] .dhl-table-box`)?.getBoundingClientRect(); return r ? { x: Math.round(r.left), y: Math.round(r.top) } : null }, id)
  // Pan back into history with a horizontal two-finger scroll (a mouse drag here could grab a drawing;
  // scrolling forward does nothing at the latest bar).
  const pan = async (direction = -1) => {
    // The drawing list, once expanded with dozens of rows, covers the middle of the chart: collapse it first.
    const head = page.locator('.dhl-drawing-list-head')
    if (await head.getAttribute('aria-expanded') === 'true') { await head.click(); await page.waitForTimeout(200) }
    const c = at(.5, .5); await page.mouse.move(c.x, c.y); for (let i = 0; i < 6; i += 1) { await page.mouse.wheel(80 * direction, 0); await page.waitForTimeout(30) } await page.waitForTimeout(600) }
  await pick('锚定文本'); await clickAt(.2, .45)
  await page.getByRole('dialog').getByRole('textbox').fill('今日计划'); await page.getByRole('dialog').getByRole('button', { name: '添加' }).click(); await settle()
  const anchored = (await marks()).find((m) => m.kind === 'anchoredtext')
  check(anchored?.screenX > 0 && anchored?.screenY > 0, 'anchored text is saved with its screen spot', anchored)
  const before0 = await boxOf(anchored.id)
  // A time/price drawing as the control: it must move, or the pan did not happen.
  const pathX = () => page.evaluate((id) => document.querySelector(`.dhl-drawing[data-mark-id="${id}"] > polyline`)?.getBoundingClientRect().left ?? null, path.id)
  const pathBefore = await pathX()
  await page.keyboard.press('Escape'); await pan()
  check(pathBefore != null && Math.abs((await pathX()) - pathBefore) > 30, 'the pan moved a time-anchored drawing (control)', { pathBefore, after: await pathX() })
  check(JSON.stringify(await boxOf(anchored.id)) === JSON.stringify(before0), 'anchored text does not move when the chart pans', { before0, after: await boxOf(anchored.id) })
  // Table: grid from | and ;, then pinned from the toolbar so it stays put too, then unpinned.
  await pick('表格'); await clickAt(.6, .15)
  await page.getByRole('dialog').getByRole('textbox').fill('品种|方向|止损;BTC|多|81000;ETH|空|2400'); await page.getByRole('dialog').getByRole('button', { name: '添加' }).click(); await settle()
  const table = (await marks()).find((m) => m.kind === 'table')
  check(await page.locator(`.dhl-drawing[data-mark-id="${table.id}"] > .dhl-table[data-rows="3"][data-cols="3"]`).count() === 1, 'table renders a 3×3 grid')
  { const b = await boxOf(table.id); await page.mouse.click(b.x + 12, b.y + 8); await page.waitForTimeout(400) }
  await page.getByRole('toolbar', { name: '画线样式' }).getByRole('button', { name: '固定到屏幕' }).click(); await settle()
  check((await marks()).find((m) => m.id === table.id)?.screenX != null, 'the toolbar pins the table to the screen')
  await page.keyboard.press('Escape')
  // Back toward the latest bars this time: the first pan may have reached the start of the loaded history.
  const tableBefore = await boxOf(table.id), path2 = await pathX(); await pan(1)
  check(Math.abs((await pathX()) - path2) > 30, 'the second pan moved the chart too (control)', { path2, after: await pathX() })
  check(JSON.stringify(await boxOf(table.id)) === JSON.stringify(tableBefore), 'a pinned table stays put while the chart pans', { tableBefore, after: await boxOf(table.id) })
  // Select it on the chart (the drawing list would first scroll the chart back to the table's stored time).
  { const b = await boxOf(table.id); await page.mouse.click(b.x + 12, b.y + 8); await page.waitForTimeout(400) }
  await page.getByRole('toolbar', { name: '画线样式' }).getByRole('button', { name: '取消固定到屏幕' }).click(); await settle()
  const unpinned = (await marks()).find((m) => m.id === table.id)
  check(unpinned.screenX == null && unpinned.points[0].time !== table.points[0].time, 'unpinning attaches the table to the time and price under it', { screenX: unpinned.screenX, before: table.points[0], after: unpinned.points[0] })
  await page.keyboard.press('Escape')

  // Editing works on the new kinds too: drag the ellipse's second anchor.
  const ellipse = (await marks()).find((m) => m.kind === 'ellipse')
  { const head = page.locator('.dhl-drawing-list-head'); if (await head.getAttribute('aria-expanded') !== 'true') { await head.click(); await page.waitForTimeout(200) } }
  await (await openList(page)).locator(`[data-mark-id="${ellipse.id}"] .dhl-drawing-list-name`).click(); await page.waitForTimeout(300)
  // Selecting from the list pans the chart to the drawing: read the anchor once it stops moving.
  const anchorAt = () => page.evaluate((id) => { const c = document.querySelector(`circle.dhl-chart-anchor[data-mark-id="${id}"][data-anchor="1"]`); const r = c?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null }, ellipse.id)
  let anchor = await anchorAt()
  for (let i = 0; i < 20; i += 1) { await page.waitForTimeout(150); const next = await anchorAt(); if (next && anchor && Math.abs(next.x - anchor.x) < 0.5 && Math.abs(next.y - anchor.y) < 0.5) break; anchor = next }
  check(await page.locator('.dhl-draw-toolbar.at-bottom').count() === 1, 'the toolbar moves below a drawing near the top of the chart')
  check(Boolean(anchor) && await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.classList.contains('dhl-chart-anchor'), [anchor.x, anchor.y]), 'selecting the ellipse from the list shows a grabbable anchor', anchor)
  await page.mouse.move(anchor.x, anchor.y); await page.mouse.down()
  for (let i = 1; i <= 8; i += 1) { await page.mouse.move(anchor.x + i * 5, anchor.y + i * 5); await page.waitForTimeout(16) }
  await page.mouse.up(); await settle()
  const moved = (await marks()).find((m) => m.id === ellipse.id)
  check(moved.points[1].time > ellipse.points[1].time && moved.points[1].price < ellipse.points[1].price && moved.points[0].time === ellipse.points[0].time, 'an ellipse anchor drags like any other drawing')
  check(errors.length === 0, 'no page errors', errors)
} finally { await browser.close() }
