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
  const marks = async () => (await store(page)).chartMarks
  const settle = () => page.waitForTimeout(1500)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

  // ── every new tool, drawn by real input ──
  const plan = [['斐波那契扩展', 'fibext', [[.2, .7], [.35, .3], [.45, .55]]], ['斐波那契通道', 'fibchannel', [[.2, .6], [.4, .45], [.3, .4]]],
    ['斐波那契时间周期', 'fibtime', [[.3, .5], [.33, .5]]], ['江恩扇形', 'gannfan', [[.25, .75], [.35, .6]]],
    ['安德鲁叉子线', 'pitchfork', [[.2, .6], [.35, .35], [.38, .7]]], ['回归趋势', 'regression', [[.45, .5], [.65, .5]]], ['固定范围成交量分布', 'vprofile', [[.7, .5], [.4, .5]]],
    ['箭头', 'arrow', [[.55, .3], [.62, .45]]], ['圆形', 'circle', [[.7, .4], [.74, .4]]], ['三角形', 'triangle', [[.5, .7], [.58, .6], [.62, .75]]],
    ['信息线', 'infoline', [[.15, .4], [.25, .3]]], ['趋势角度', 'trendangle', [[.15, .8], [.25, .7]]], ['十字线', 'crossline', [[.4, .2]]],
    ['价格区间', 'pricerange', [[.75, .7], [.77, .55]]], ['日期区间', 'daterange', [[.6, .85], [.7, .85]]], ['价格标签', 'pricelabel', [[.85, .5]]],
    ['艾略特推动浪', 'elliott', [[.1, .8], [.14, .6], [.17, .7], [.22, .35], [.25, .45], [.29, .25]]], ['艾略特调整浪', 'elliottabc', [[.3, .3], [.34, .55], [.37, .45], [.41, .7]]],
    ['XABCD 谐波', 'xabcd', [[.42, .8], [.46, .4], [.5, .65], [.54, .5], [.58, .75]]], ['ABCD 形态', 'abcd', [[.6, .7], [.63, .45], [.66, .58], [.7, .3]]],
    ['头肩形态', 'headshoulders', [[.1, .6], [.13, .4], [.16, .5], [.2, .25], [.24, .5], [.27, .4], [.3, .62]]],
    ['江恩箱', 'gannbox', [[.72, .3], [.8, .6]]], ['江恩方格', 'gannsquare', [[.82, .3], [.9, .6]]],
    ['Schiff 叉子线', 'schiff', [[.15, .7], [.3, .35], [.32, .65]]], ['改良 Schiff 叉子线', 'modschiff', [[.35, .7], [.5, .35], [.52, .65]]]]
  for (const [name, kind, clicks] of plan) {
    await pick(name)
    for (const [fx, fy] of clicks) await clickAt(fx, fy)
    await settle()
    check((await marks()).some((m) => m.kind === kind && m.points?.length === clicks.length), `${name} drawn with ${clicks.length} anchors`)
  }
  await pick('标注气泡'); await clickAt(.66, .62); await clickAt(.7, .52)
  await page.getByRole('dialog').getByRole('textbox').fill('假突破，等回踩确认'); await page.getByRole('dialog').getByRole('button', { name: '添加' }).click(); await settle()
  check((await marks()).some((m) => m.kind === 'callout' && m.label === '假突破，等回踩确认'), '标注气泡 drawn with its text')
  await pick('图标'); await clickAt(.88, .2)
  await page.getByRole('dialog').getByRole('button', { name: '旗帜' }).click(); await settle()
  const flag = (await marks()).find((m) => m.kind === 'icon' && m.label === 'flag')
  check(Boolean(flag) && await page.locator(`.dhl-drawing[data-mark-id="${flag.id}"] > .dhl-icon path`).getAttribute('d') === 'M6 3v18M6 4h11l-2 4 2 4H6', '图标 picked from the grid renders the chosen glyph')
  await pick('画笔')
  const b0 = at(.3, .2); await page.mouse.move(b0.x, b0.y); await page.mouse.down()
  for (let i = 1; i <= 40; i += 1) await page.mouse.move(b0.x + i * 6, b0.y + Math.sin(i / 4) * 25)
  await page.mouse.up(); await settle()
  const brush = (await marks()).find((m) => m.kind === 'brush')
  check(brush && brush.points.length >= 20, `画笔 records a freehand path (${brush?.points.length} points) without panning the chart`)
  check(await page.locator('.dhl-chart-drawing-overlay .dhl-drawing').count() >= 26, 'all new drawings render')

  // ── undo / redo ──
  const count = (await marks()).length
  await page.keyboard.press(`${mod}+z`); await settle()
  check((await marks()).length === count - 1 && !(await marks()).some((m) => m.kind === 'brush'), 'Ctrl/Cmd+Z undoes the last drawing')
  await page.keyboard.press(`${mod}+Shift+z`); await settle()
  check((await marks()).some((m) => m.kind === 'brush'), 'Shift+Ctrl/Cmd+Z redoes it')
  const arrow = (await marks()).find((m) => m.kind === 'arrow')
  await (await openList(page)).getByRole('button', { name: new RegExp('^.*' + arrow.label) }).first().click()
  await page.locator('.dhl-draw-toolbar .dhl-swatch').nth(2).click(); await settle()
  check((await marks()).find((m) => m.id === arrow.id).color === '#ef5f6c', 'list row selects the drawing; color changed')
  await page.keyboard.press(`${mod}+z`); await settle()
  check(!('color' in (await marks()).find((m) => m.id === arrow.id)), 'undo restores the default color (style cleared on host)')
  await (await openList(page)).getByRole('button', { name: new RegExp('^.*' + arrow.label) }).first().click()
  await page.keyboard.press('Delete'); await settle()
  check(!(await marks()).some((m) => m.id === arrow.id), 'deleted')
  await page.keyboard.press(`${mod}+z`); await settle()
  const restored = (await marks()).find((m) => m.kind === 'arrow')
  check(restored && JSON.stringify(restored.points) === JSON.stringify(arrow.points), 'undo brings a deleted drawing back unchanged')
  await page.keyboard.press(`${mod}+Shift+z`); await settle(); await page.keyboard.press(`${mod}+z`); await settle()
  check((await marks()).some((m) => m.kind === 'arrow'), 'redo/undo keeps working after the id changed (history remapped)')

  // ── clone, copy / paste ──
  const tri = (await marks()).find((m) => m.kind === 'triangle')
  await (await openList(page)).getByRole('button', { name: new RegExp('^.*' + tri.label) }).first().click()
  const before = (await marks()).length
  await page.locator('.dhl-draw-toolbar').getByRole('button', { name: '复制画线' }).click(); await settle()
  const clones = (await marks()).filter((m) => m.kind === 'triangle')
  check((await marks()).length === before + 1 && clones.some((m) => m.id !== tri.id && m.points[0].time > tri.points[0].time && m.points[0].price === tri.points[0].price), 'clone adds a shifted copy')
  await (await openList(page)).getByRole('button', { name: new RegExp('^.*' + tri.label) }).first().click()
  await page.keyboard.press(`${mod}+c`); await page.keyboard.press(`${mod}+v`); await settle()
  check((await marks()).filter((m) => m.kind === 'triangle').length === 3, 'Ctrl/Cmd+C then V pastes another copy')

  // ── object list: hide / show ──
  const circle = (await marks()).find((m) => m.kind === 'circle')
  await (await openList(page)).getByRole('button', { name: `隐藏 ${circle.label}` }).click(); await settle()
  check((await marks()).find((m) => m.id === circle.id).hidden === true && await page.locator(`.dhl-drawing[data-mark-id="${circle.id}"]`).count() === 0, 'hide removes it from the chart but keeps it in the list')
  await (await openList(page)).getByRole('button', { name: `显示 ${circle.label}` }).click(); await settle()
  check(await page.locator(`.dhl-drawing[data-mark-id="${circle.id}"]`).count() === 1, 'show brings it back')

  // ── templates: default style per tool ──
  await (await openList(page)).getByRole('button', { name: new RegExp('^.*' + circle.label) }).first().click()
  await page.locator('.dhl-draw-toolbar .dhl-swatch').nth(4).click()
  await page.locator('.dhl-draw-toolbar').getByRole('button', { name: '线宽 4' }).click(); await settle()
  await page.locator('.dhl-draw-toolbar').getByRole('button', { name: '设为默认样式' }).click()
  await page.keyboard.press('Escape')
  await pick('圆形'); await clickAt(.8, .3); await clickAt(.83, .3); await settle()
  const newest = (await marks()).filter((m) => m.kind === 'circle').find((m) => m.id !== circle.id)
  check(newest?.color === '#9b86db' && newest?.lineWidth === 4, 'a new circle takes the saved default style', newest)
  await page.screenshot({ path: process.env.SHOT_P3 ?? new URL('./.phase3.png', import.meta.url).pathname, clip: { x: box.x - 10, y: box.y - 110, width: box.width + 20, height: box.height + 340 } })
  check(errors.length === 0, 'no page errors', errors)
} finally { await browser.close() }
