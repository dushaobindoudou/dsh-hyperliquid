import { chromium, CHROME, readUrl, openDesk, waitCandles, check } from './common.mjs'
const url = await readUrl()
const browser = await chromium.launch({ headless: true, executablePath: CHROME })
try {
  const page = await browser.newPage({ viewport: { width: 2100, height: 1100 }, timezoneId: 'UTC' })
  await openDesk(page, url)
  await page.getByRole('button', { name: /新建交易会话/ }).click(); await waitCandles(page)
  const state = () => page.evaluate(() => { const s = window.__dhlStore.get(); return { head: s.candles[0].t, tail: s.candles.at(-1).t, count: s.candles.length, older: s.candlesOlder, range: s.workspace.chartRanges[`${s.activeCoin}:${s.interval}`], notices: s.notices } })
  await page.getByRole('button', { name: '1D', exact: true }).click(); await page.waitForTimeout(900)
  const before = await state(), target = before.head - 2 * 3600_000
  await page.locator('summary[aria-label="跳转到日期"]').click()
  await page.locator('#dhl-chart-date').fill(new Date(target).toISOString().slice(0, 16))
  const input = await page.locator('#dhl-chart-date').evaluate((el) => ({ value: el.value, valid: el.checkValidity(), validation: el.validationMessage }))
  await page.getByRole('button', { name: '定位 K 线', exact: true }).click()
  await page.waitForFunction((time) => window.__dhlStore.get().candles[0].t <= time || ['done', 'error'].includes(window.__dhlStore.get().candlesOlder), target, { timeout: 30_000 })
  await page.waitForTimeout(1000)
  const after = await state()
  check(after.range?.from * 1000 <= Math.max(target, after.head) && after.range?.to * 1000 >= Math.max(target, after.head), 'date navigation persists the final viewport', { before, target, input, after })
} finally { await browser.close() }
