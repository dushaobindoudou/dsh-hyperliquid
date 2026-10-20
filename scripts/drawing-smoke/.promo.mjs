import { chromium, CHROME, readUrl, openDesk, waitCandles, toolItem, store } from './common.mjs'
const url = await readUrl()
const OUT = process.env.SHOT_DIR
const browser = await chromium.launch({ headless: true, executablePath: CHROME })
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 960 }, deviceScaleFactor: 2, colorScheme: 'dark' })
  const page = await context.newPage()
  await openDesk(page, url)
  await page.getByRole('button', { name: /新建交易会话/ }).click()
  await page.locator('.dhl-chatmount').waitFor({ state: 'visible', timeout: 20_000 }); await waitCandles(page)
  await page.waitForTimeout(1500)
  const box = await page.locator('.dhl-chart canvas').first().boundingBox()
  const at = (fx, fy) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy })
  const click = async (p) => { await page.mouse.move(p.x, p.y); await page.waitForTimeout(60); await page.mouse.click(p.x, p.y); await page.waitForTimeout(180) }
  const draw = async (name, points) => { await page.locator('.dhl-draw-menu summary').click(); await toolItem(page, name).click(); for (const [fx, fy] of points) await click(at(fx, fy)); await page.waitForTimeout(900) }
  // Real anchors: put the fib on the visible swing (highest and lowest candle in view).
  await draw('斐波那契回撤', [[.18, .78], [.52, .2]])
  await draw('固定范围成交量分布', [[.55, .5], [.86, .5]])
  await draw('多头头寸', [[.88, .55], [.97, .68]])
  await draw('趋势线', [[.06, .8], [.48, .55]])
  await page.keyboard.press('Escape'); await page.mouse.move(at(.7, .1).x, at(.7, .1).y)
  await page.waitForTimeout(800)
  await page.screenshot({ path: `${OUT}/desk.png` })
  await page.getByRole('button', { name: '全屏图表', exact: true }).click(); await page.waitForTimeout(1500)
  await page.mouse.move(10, 10)
  await page.screenshot({ path: `${OUT}/fullscreen.png` })
  await page.getByRole('button', { name: '退出全屏图表', exact: true }).click(); await page.waitForTimeout(600)
  // Drawing menu with search
  await page.locator('.dhl-draw-menu summary').click(); await page.getByRole('searchbox', { name: '搜索画线工具' }).fill('斐波那契'); await page.waitForTimeout(300)
  const pop = await page.locator('.dhl-draw-popover').boundingBox()
  await page.screenshot({ path: `${OUT}/draw-menu.png`, clip: { x: Math.max(0, pop.x - 24), y: Math.max(0, pop.y - 60), width: pop.width + 48, height: Math.min(pop.height + 84, 900) } })
  await page.keyboard.press('Escape'); await page.locator('.dhl-draw-menu summary').click({ force: true }).catch(() => {})
  console.log('marks', (await store(page)).chartMarks.length)
} finally { await browser.close() }
