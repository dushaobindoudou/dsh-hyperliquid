// Phase 2: after a host restart, each session's drawings and MAs are back.
import { readFileSync } from 'node:fs'
import { chromium, CHROME, STATE_FILE, readUrl, openDesk, store, waitCandles, check } from './common.mjs'

const url = await readUrl()
const saved = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
const browser = await chromium.launch({ headless: true, executablePath: CHROME })
try {
  const page = await browser.newPage({ viewport: { width: 2100, height: 1000 } })
  await openDesk(page, url)
  for (const [session, ids, ma] of [[saved.s1, saved.s1Marks, 'smma21'], [saved.s2, saved.s2Marks, '']]) {
    await page.locator(`[data-session-id="${session}"]`).click()
    await page.waitForFunction((id) => window.__dhlStore.get().activeSessionId === id && window.__dhlStore.get().workspaceSessionId === id, session, { timeout: 20_000 })
    await waitCandles(page)
    await page.waitForFunction((want) => JSON.stringify(window.__dhlStore.get().chartMarks.map((m) => m.id).sort()) === JSON.stringify([...want].sort()), ids, { timeout: 15_000 })
      .catch(async () => check(false, `session ${session.slice(0, 8)} drawings after restart`, { want: ids, got: (await store(page)).chartMarks.map((m) => m.id) }))
    check((await store(page)).maLines.map((l) => l.id).join() === ma, `session ${session === saved.s1 ? 'S1' : 'S2'}: drawings and MAs restored after restart`)
  }
  await page.locator(`[data-session-id="${saved.s1}"]`).click()
  await waitCandles(page)
  const long = (await store(page)).chartMarks.find((m) => m.id === saved.longId)
  check(long?.points?.length === 3 && (await page.locator(`.dhl-drawing[data-mark-id="${saved.longId}"]`).count()) === 1, 'restored position is drawn on the chart')
} finally { await browser.close() }
