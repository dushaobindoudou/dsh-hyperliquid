// Phase 4: sync to every session of a coin, the sticker library, and a price-cross alert on live data.
import { chromium, CHROME, readUrl, openDesk, store, waitCandles, check, toolItem, openList } from './common.mjs'
const url = await readUrl()
const browser = await chromium.launch({ headless: true, executablePath: CHROME })
try {
  const page = await browser.newPage({ viewport: { width: 2100, height: 1000 } })
  const errors = []; page.on('pageerror', (e) => errors.push(String(e?.message ?? e)))
  await openDesk(page, url)
  const newSession = async () => {
    const before = (await store(page)).activeSessionId
    await page.getByRole('button', { name: /新建交易会话/ }).click()
    await page.waitForFunction((id) => window.__dhlStore.get().activeSessionId && window.__dhlStore.get().activeSessionId !== id, before, { timeout: 20_000 })
    await waitCandles(page)
    return (await store(page)).activeSessionId
  }
  const a = await newSession()
  const box = await page.locator('.dhl-chart canvas').first().boundingBox()
  const at = (fx, fy) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy })
  const clickXY = async ({ x, y }) => { await page.mouse.move(x, y); await page.waitForTimeout(60); await page.mouse.click(x, y); await page.waitForTimeout(200) }
  const pick = async (name) => { await page.locator('.dhl-draw-menu summary').click(); await toolItem(page, name).click() }
  const marks = async () => (await store(page)).chartMarks
  const settle = () => page.waitForTimeout(1500)
  const selectByLabel = async (label) => (await openList(page)).getByRole('button', { name: new RegExp('^.*' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first().click()

  // ── sticker library ──
  await pick('图标'); await clickXY(at(.5, .2))
  await page.getByRole('dialog').getByRole('tab', { name: '交易' }).click()
  await page.getByRole('dialog').getByRole('button', { name: '贴纸 🚀' }).click(); await settle()
  check((await marks()).some((m) => m.kind === 'icon' && m.label === 'emoji:🚀') && await page.locator('.dhl-drawing > .dhl-sticker').count() === 1, 'a sticker from the library is placed on the chart',
    { marks: (await marks()).map((m) => [m.kind, m.label]), stickers: await page.locator('.dhl-sticker').count(), dialog: await page.getByRole('dialog').count() })

  // ── price ↔ y calibration from two levels, then a level at the live mid ──
  const levelY = async (id) => page.evaluate((markId) => { const l = document.querySelector(`.dhl-drawing[data-mark-id="${markId}"] .dhl-drawing-hit line`); return +l.getAttribute('y1') + document.querySelector('.dhl-chart-drawing-overlay').getBoundingClientRect().top }, id)
  const drawLevel = async (fy) => { const n = (await marks()).length; await pick('水平线'); await clickXY(at(.6, fy)); await page.waitForFunction((k) => window.__dhlStore.get().chartMarks.length > k, n); return (await marks()).at(-1) }
  const l1 = await drawLevel(.25), l2 = await drawLevel(.75)
  const y1 = await levelY(l1.id), y2 = await levelY(l2.id)
  const yOf = (price) => y1 + (price - l1.price) * (y2 - y1) / (l2.price - l1.price)
  const liveMid = () => page.evaluate(() => { const s = window.__dhlStore.get(); return Number(s.snapshot?.mids?.mids?.[s.activeCoin] ?? s.snapshot?.mids?.[s.activeCoin]) })
  const mid = await liveMid()
  const gap = (Math.abs(l2.price - l1.price) / 20) // ~2.5% of the visible range: far enough that live noise cannot cross it
  const target = await drawLevel((yOf(mid - gap) - box.y) / box.height)
  check(target.price < mid, `alert line placed below the live mid (${target.price.toFixed(1)} < ${mid})`)

  // ── sync to every session of the coin ──
  await selectByLabel(target.label)
  await page.locator('.dhl-draw-toolbar').getByRole('button', { name: '同步到所有会话' }).click(); await settle()
  check((await marks()).find((m) => m.id === target.id).shared === true, 'drawing synced')
  // arm the alert from the toolbar while it is selected
  await page.locator('.dhl-draw-toolbar').getByRole('button', { name: '开启价格提醒' }).click(); await settle()
  check((await marks()).find((m) => m.id === target.id).alert === true, 'price alert armed')
  await page.keyboard.press('Escape')
  const b = await newSession()
  await page.waitForFunction((id) => window.__dhlStore.get().chartMarks.some((m) => m.id === id), target.id, { timeout: 10_000 })
  check((await marks()).length === 1 && (await page.locator(`.dhl-drawing[data-mark-id="${target.id}"]`).count()) === 1, `a new session (${b.slice(8, 14)}) of the same coin shows the synced line, and only that`)

  // ── the alert fires when line and live price cross (once). The host must first observe the
  // price above the line; then the line is dragged above the live mid, which is a cross. ──
  await page.waitForTimeout(5000)
  const yNow = await levelY(target.id)
  await page.mouse.move(at(.3, 0).x, yNow); await page.mouse.down()
  const yAbove = yOf((await liveMid()) + gap)
  for (let i = 1; i <= 10; i += 1) { await page.mouse.move(at(.3, 0).x, yNow + (yAbove - yNow) * i / 10); await page.waitForTimeout(16) }
  await page.mouse.up()
  const fired = await page.waitForFunction((id) => {
    const m = window.__dhlStore.get().chartMarks.find((row) => row.id === id)
    return m && m.alert === false && m.alertTriggeredAt ? m.alertTriggeredAt : false
  }, target.id, { timeout: 30_000, polling: 500 }).then((h) => h.jsonValue(), () => null)
  check(Boolean(fired), 'line and live mid crossed: the alert fired once (switched off, time recorded)')
  check(/BTC 价格(上穿|下穿)「/.test(await page.locator('.dhl-notice').innerText().catch(() => '')), 'the desk shows the crossing alert')
  // …and the agent of the session that drew the line (a, not the session on screen) is woken with a
  // notify-only event message (followup into the real DSH session).
  await page.locator(`.dhl-srow[data-session-id="${a}"]`).click()
  await page.waitForFunction((id) => window.__dhlStore.get().activeSessionId === id, a, { timeout: 10_000 })
  // The event message has a plugin source, so DSH shows the agent's reply rather than the message itself;
  // what must happen is a new agent turn in that session (this smoke host has no working model, so the
  // turn itself fails — the turn counter is the evidence that the agent was woken).
  const woke = await page.waitForFunction(() => /\b1\s*轮/.test(document.querySelector('.dhl-chatmount')?.innerText ?? ''), null, { timeout: 30_000 }).then(() => true).catch(() => false)
  check(woke, 'the alert wakes the session agent (a new turn starts in the drawing\'s session)', await page.locator('.dhl-chatmount').innerText().catch(() => ''))
  // custom emoji from the full emoji set
  await pick('图标'); await clickXY(at(.55, .2))
  await page.getByRole('dialog').getByLabel('自定义 emoji 贴纸').fill('🦄')
  await page.getByRole('dialog').getByRole('button', { name: '放置' }).click(); await settle()
  check((await marks()).some((m) => m.kind === 'icon' && m.label === 'emoji:🦄'), 'any emoji can be placed as a sticker')
  // dark mode: the chat column matches DSH's conversation surface, so the composer fade has no dark band
  const dark = await browser.newPage({ viewport: { width: 1600, height: 1000 }, colorScheme: 'dark' })
  await openDesk(dark, url)
  await dark.locator('.dhl-chatmount').waitFor({ state: 'visible', timeout: 20_000 })
  const tones = await dark.evaluate(() => {
    const probe = document.createElement('div'); probe.style.background = 'var(--dsw-alias-bg-base)'; document.querySelector('.dhl-root').appendChild(probe)
    const base = getComputedStyle(probe).backgroundColor; probe.remove()
    return { base, chat: getComputedStyle(document.querySelector('.dhl-col-chat')).backgroundColor }
  })
  check(tones.base === tones.chat, `dark mode chat column uses the conversation surface (${tones.chat})`, tones)
  await dark.close()
  check(errors.length === 0, 'no page errors', errors)
} finally { await browser.close() }
