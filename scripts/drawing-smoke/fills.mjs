import { chromium, CHROME, readUrl, openDesk, store, waitCandles, check } from './common.mjs'
const url = await readUrl()
const browser = await chromium.launch({ headless: true, executablePath: CHROME })
try {
  const page = await browser.newPage({ viewport: { width: 2100, height: 1000 } })
  const errors = []; page.on('pageerror', (e) => errors.push(String(e?.message ?? e)))
  await openDesk(page, url)
  await page.getByRole('button', { name: /新建交易会话/ }).click()
  await page.locator('.dhl-chatmount').waitFor({ state: 'visible', timeout: 20_000 }); await waitCandles(page)
  const s1 = (await store(page)).activeSessionId
  await page.getByRole('button', { name: /新建交易会话/ }).click()
  await page.waitForFunction((id) => window.__dhlStore.get().activeSessionId !== id, s1, { timeout: 20_000 }); await waitCandles(page)
  const s2 = (await store(page)).activeSessionId
  const reason = '15m 站上 EMA20，回踩 81,180 支撑不破，RSI 58 动量偏强；止损放在支撑下方，盈亏比约 2:1。'
  await page.evaluate(([sessionId, reason]) => {
    const s = window.__dhlStore.get(); const bar = s.candles.at(-12)
    window.__dhlStore.patch({ tradeHistory: { mode: 'paper', orders: [], fills: [{ coin: s.activeCoin, isBuy: true, sz: 0.001, px: (bar.h + bar.l) / 2, time: bar.t + 60_000, reason, sessionId }] }, tradeHistoryAt: Date.now() })
  }, [s1, reason])
  await page.waitForTimeout(600)
  check(await page.locator('.dhl-fill.has-reason').count() === 1, 'fill dot drawn at its price, ringed because it has a rationale')
  const dot = await page.locator('.dhl-fill .dhl-fill-dot').boundingBox()
  await page.mouse.click(dot.x + dot.width / 2, dot.y + dot.height / 2)
  const card = page.locator('.dhl-fill-card')
  check(await card.isVisible() && (await card.innerText()).includes(reason), 'clicking the dot shows the AI rationale')
  await page.screenshot({ path: process.env.SHOT_FILL ?? new URL('./.fill.png', import.meta.url).pathname, clip: { x: dot.x - 420, y: dot.y - 220, width: 840, height: 420 } })
  await page.keyboard.press('Escape'); check(!(await card.isVisible()), 'Esc hides the card')
  await page.locator('.dhl-layer-menu summary').click(); await page.getByLabel('成交原因').check(); await page.locator('.dhl-layer-menu summary').click(); await page.waitForTimeout(800)
  check((await page.locator('.dhl-fill-reason').allTextContents()).some((t) => t.startsWith('15m 站上 EMA20')), 'reason labels can be shown on the chart')
  await page.locator('.dhl-layer-menu summary').click(); await page.getByLabel('成交原因').uncheck(); await page.locator('.dhl-layer-menu summary').click(); await page.waitForTimeout(800)
  check(await page.locator('.dhl-fill-reason').count() === 0, '…and hidden again')
  await page.mouse.click(dot.x + dot.width / 2, dot.y + dot.height / 2)
  await page.getByRole('button', { name: '回到决策会话分析' }).click()
  await page.waitForFunction((id) => window.__dhlStore.get().activeSessionId === id, s1, { timeout: 15_000 })
  await page.locator('.dhl-chatmount [contenteditable="true"]').first().waitFor({ state: 'visible', timeout: 20_000 })
  await page.waitForFunction(() => /成交 买入 0.001 BTC/.test(document.querySelector('.dhl-chatmount [contenteditable="true"]')?.innerText ?? ''), null, { timeout: 15_000 })
  check(true, `"analyze" switches from ${s2.slice(8, 14)} back to the deciding session and drops a review chip in its composer`)
  check(errors.length === 0, 'no page errors', errors)
} finally { await browser.close() }
