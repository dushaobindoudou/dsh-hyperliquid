// dsh-hyperliquid — real-host client smoke: boot the packed plugin in a
// throwaway DSH profile, open the desk through the sidebar entry, and
// verify the panel actually renders with an embedded native Conversation.
//
// Adapted from dsh-bots' scripts/dsh-client-smoke.mjs. The local dsh URL
// (with its per-process auth token) is read from stdin so the token never
// appears in command output.
import { chromium } from 'playwright-core'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

let url = ''
for await (const chunk of process.stdin) url += chunk
url = url.trim()
if (!/^http:\/\/127\.0\.0\.1:\d+\/\?token=/.test(url)) throw new Error('Missing local dsh test URL')

const browser = await chromium.launch({ headless: true, executablePath: CHROME })
try {
  const width = Number(process.env.DSH_SMOKE_WIDTH) || 1440
  const page = await browser.newPage({ viewport: { width, height: 900 } })
  const errors = []
  page.on('pageerror', (e) => { const message = String(e?.stack ?? e?.message ?? e); errors.push(message); console.log('PAGEERROR', message.slice(0, 700)) })
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(5000)

  const body = await page.locator('body').innerText()
  if (/Failed to load plugins|entries did not activate|waiting for service: shortcuts|authentication required/i.test(body)) {
    throw new Error('Client plugin activation failed: ' + body.slice(0, 1800))
  }
  if (body.trim().length === 0) throw new Error('dsh client rendered an empty page')
  console.log('PASS dsh web booted, no pending plugins')

  // Open the desk through the sidebar entry (label = app.title).
  const target = page.getByRole('button', { name: /Hyperliquid/ }).first()
  if ((await target.count()) === 0) throw new Error('sidebar entry not found — plugin panel icon missing')
  const previewDialog = page.getByRole('dialog').filter({ hasText: /预览版说明|内测声明/ }).first()
  if (await previewDialog.isVisible().catch(() => false)) {
    await previewDialog.getByRole('button', { name: '继续' }).click()
  }
  // First-run onboarding (“添加一个 API Key 开始使用…”) overlays the sidebar on a
  // fresh throwaway profile. Identify it by its exact copy and skip via
  // 「API 密钥稍后配置」 — this smoke never configures a real API key.
  const onboarding = page.getByText(/添加一个 API Key/).first()
  const hasOnboarding = await onboarding.waitFor({ state: 'visible', timeout: 2500 }).then(() => true).catch(() => false)
  if (hasOnboarding) {
    const skip = page.getByRole('button', { name: /稍后配置/ }).first()
    if ((await skip.count()) === 0) {
      throw new Error(`onboarding overlay present but “稍后配置” button not found; copy=${(await onboarding.innerText()).slice(0, 200)}`)
    }
    await skip.click()
    await onboarding.waitFor({ state: 'hidden', timeout: 5000 })
    console.log('PASS first-run onboarding skipped via 稍后配置')
  }
  try {
    await target.click({ timeout: 5000 })
  } catch (error) {
    const overlays = await page.locator('[role="dialog"], [role="presentation"]').allTextContents()
    throw new Error(`sidebar entry blocked: ${String(error?.message ?? error).slice(0, 160)}; overlays=${JSON.stringify(overlays.map((s) => s.slice(0, 240)))}`)
  }
  await page.waitForTimeout(4000)

  const html = await page.content()
  if (!html.includes('dhl-root')) throw new Error('desk panel did not render (no .dhl-root)')
  await page.locator('.dhl-root').waitFor({ state: 'visible', timeout: 10_000 })
  if (await page.locator('.dhl-topbar').getByRole('combobox', { name: /语言|Language/ }).count()) throw new Error('plugin still renders its own language selector')
  console.log('PASS desk panel rendered (.dhl-root present)')
  const headerIcon = page.locator('.dhl-market-trigger .dhl-market-icon img')
  await headerIcon.waitFor({ state: 'attached' })
  if (!(await headerIcon.getAttribute('src'))?.endsWith('/coins/BTC.svg')) throw new Error('BTC ticker icon does not use the official Hyperliquid URL')
  await page.waitForFunction(() => {
    const image = document.querySelector('.dhl-market-trigger .dhl-market-icon img')
    return image instanceof HTMLImageElement && image.naturalWidth > 0 && image.classList.contains('loaded')
  }, null, { timeout: 10_000 })
  const iconBackdrop = await page.locator('.dhl-market-trigger .dhl-market-icon').evaluate((element) => ({
    fallbackCount: element.querySelectorAll('.dhl-market-icon-fallback').length,
    background: getComputedStyle(element).backgroundColor,
  }))
  if (iconBackdrop.fallbackCount || iconBackdrop.background !== 'rgba(0, 0, 0, 0)') {
    throw new Error('loaded ticker icon still has artwork or a background behind transparent pixels: ' + JSON.stringify(iconBackdrop))
  }
  console.log('PASS BTC ticker icon loads from Hyperliquid')

  // The LWC chart mounts a <canvas> once candles arrive.
  await page.locator('.dhl-chart canvas').first().waitFor({ state: 'attached', timeout: 10_000 })
  const statusDot = await page.locator('.dhl-badge.ok, .dhl-badge.err').first().evaluate((element) => {
    const badge = getComputedStyle(element)
    const dot = getComputedStyle(element, '::before')
    return { content: dot.content, width: dot.width, dotColor: dot.backgroundColor, textColor: badge.color }
  })
  if (statusDot.content === 'none' || statusDot.width !== '6px' || statusDot.dotColor !== statusDot.textColor) throw new Error('connection status dot does not follow its state color: ' + JSON.stringify(statusDot))
  console.log(`PASS chart canvas mounted (${await page.locator('.dhl-chart canvas').count()} canvas)`)
  const chartToolsFit = await page.locator('.dhl-chart-tools').first().evaluate((element) => element.scrollWidth <= element.clientWidth + 2)
  if (!chartToolsFit) throw new Error('chart drawing toolbar overflows the visible chart width')
  console.log('PASS chart tools fit the visible desk width')
  await page.locator('.dhl-strategy-menu summary').click()
  if (await page.locator('.dhl-strategy-card').count() !== 3) throw new Error('strategy study cards missing')
  await page.locator('.dhl-strategy-caveat').waitFor({ state: 'visible' })
  if (process.env.DSH_SMOKE_STRATEGY_SCREENSHOT) await page.locator('.dhl-chart-panel').screenshot({ path: process.env.DSH_SMOKE_STRATEGY_SCREENSHOT })
  await page.locator('.dhl-strategy-menu summary').click()
  console.log('PASS closed-candle strategy study menu renders three frameworks')

  if (await page.locator('.dhl-topbar').getByRole('combobox', { name: '主题' }).count()) throw new Error('plugin still renders its own theme selector')
  await page.getByRole('button', { name: '交易设置' }).click()
  await page.getByRole('menu').getByRole('button', { name: '模拟盘' }).click()
  await page.waitForFunction(() => window.__dhlStore.get().status?.tradingMode === 'paper')
  const walletTrigger = page.getByRole('button', { name: '查看钱包详情和收益' })
  const walletIconAlignment = await walletTrigger.evaluate((button) => {
    const icon = button.querySelector('svg')
    if (!icon) return { error: 'wallet dropdown icon is not SVG' }
    const outer = button.getBoundingClientRect()
    const inner = icon.getBoundingClientRect()
    return { delta: Math.abs((outer.top + outer.bottom - inner.top - inner.bottom) / 2), iconWidth: inner.width }
  })
  if (walletIconAlignment.error || walletIconAlignment.delta > 2 || walletIconAlignment.iconWidth < 10) throw new Error('paper wallet dropdown icon is misaligned: ' + JSON.stringify(walletIconAlignment))
  if (!await page.getByRole('button', { name: '交易设置' }).locator('svg').count()) throw new Error('trading settings button is missing its SVG icon')
  await page.getByRole('button', { name: '交易设置' }).click()
  await page.getByRole('menu').getByRole('button', { name: '交易限额与签名规则', exact: true }).click()
  const settingsDialog = page.getByRole('dialog', { name: '交易限额与签名规则' })
  if (process.env.DSH_SMOKE_SETTINGS_SCREENSHOT) {
    await page.waitForTimeout(350)
    await settingsDialog.screenshot({ path: process.env.DSH_SMOKE_SETTINGS_SCREENSHOT })
  }
  await settingsDialog.getByRole('spinbutton', { name: '最大杠杆 · 倍' }).fill('3')
  await settingsDialog.getByRole('spinbutton', { name: '单笔上限 · USD' }).fill('125')
  await settingsDialog.getByRole('button', { name: '保存限额' }).click()
  await page.waitForFunction(() => window.__dhlStore.get().status?.riskLimits?.maxLeverage === 3 && window.__dhlStore.get().status?.riskLimits?.maxOrderUsd === 125)
  await settingsDialog.getByRole('button', { name: '恢复插件配置' }).click()
  await page.waitForFunction(() => window.__dhlStore.get().status?.riskSettingsSource === 'plugin' && window.__dhlStore.get().status?.riskLimits?.maxLeverage === 2)
  await settingsDialog.getByRole('button', { name: '关闭' }).click()
  console.log('PASS trading settings save, apply and restore through the top-right gear')
  await walletTrigger.click()
  const walletDialog = page.getByRole('dialog', { name: '钱包详情与收益' })
  await walletDialog.getByText('账户权益').waitFor({ state: 'visible' })
  await walletDialog.getByText('正在读取收益…').waitFor({ state: 'hidden', timeout: 10_000 })
  if (await walletDialog.locator('.dhl-inline-error').count()) throw new Error('paper portfolio RPC failed: ' + await walletDialog.locator('.dhl-inline-error').innerText())
  await walletDialog.getByRole('button', { name: '关闭' }).click()
  await page.waitForFunction(() => window.__dhlStore.get().tradeHistoryAt > 0 && !window.__dhlStore.get().tradeHistoryError, null, { timeout: 10_000 })
  console.log('PASS theme selector removed, paper wallet icon aligned, and portfolio/history RPC accepted')
  await page.getByRole('button', { name: '交易设置' }).click()
  await page.getByRole('menu').getByRole('button', { name: '实盘' }).click()
  const paperToLiveConfirmation = page.getByRole('dialog', { name: '切换到主网实盘' })
  if (await paperToLiveConfirmation.isVisible().catch(() => false)) await paperToLiveConfirmation.getByRole('button', { name: '确认切换' }).click()
  await page.waitForFunction(() => window.__dhlStore.get().status?.tradingMode === 'live')

  // A lost window focus must end a divider drag and release its global cursor.
  const divider = page.locator('.dhl-divider').first()
  const bounds = await divider.boundingBox()
  if (!bounds) throw new Error('resize divider missing')
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 80)
  await page.mouse.down()
  await page.mouse.move(bounds.x + bounds.width / 2 + 35, bounds.y + 80)
  await page.locator('.dhl-divider.dragging').waitFor({ state: 'visible' })
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await page.locator('.dhl-divider.dragging').waitFor({ state: 'detached' })
  await page.mouse.up()
  console.log('PASS divider drag ends when the window loses focus')

  // Every region can be hidden and restored independently, including all three.
  for (const name of ['收起会话栏', '收起行情区', '收起对话栏']) await page.getByRole('button', { name }).click()
  if (await page.locator('.dhl-col-sessions, .dhl-col-desk, .dhl-col-chat').count()) throw new Error('collapsed column still mounted')
  if (await page.locator('.dhl-panel-rail').count() !== 3) throw new Error('collapsed panel rails missing')
  const collapsedLayout = await page.evaluate(() => JSON.parse(localStorage.getItem('dsh-hyperliquid.layout.v1') || '{}'))
  if (!collapsedLayout.sessionsCollapsed || !collapsedLayout.deskCollapsed || !collapsedLayout.chatCollapsed) throw new Error('collapsed state was not persisted')
  for (const name of ['展开会话栏', '展开行情区', '展开对话栏']) await page.getByRole('button', { name }).click()
  if (await page.locator('.dhl-col-sessions, .dhl-col-desk, .dhl-col-chat').count() !== 3) throw new Error('column restore failed')
  const deskWidth = (await page.locator('.dhl-col-desk').boundingBox())?.width ?? 0
  const chatWidth = (await page.locator('.dhl-col-chat').boundingBox())?.width ?? 0
  if (deskWidth < 279 || chatWidth < 319) throw new Error(`visible columns squeezed: desk=${deskWidth}, chat=${chatWidth}`)
  console.log('PASS all three regions collapse and expand')

  // The market selector uses the host catalog: search, categories, sort,
  // favorite and keyboard selection must work inside the desk.
  await page.getByRole('button', { name: /BTC-USDC/ }).first().click()
  await page.getByRole('dialog', { name: '选择市场' }).waitFor({ state: 'visible' })
  const pickerRadius = await page.locator('.dhl-picker-modal').evaluate((element) => getComputedStyle(element).borderRadius)
  if (pickerRadius !== '0px') throw new Error(`market selector should have square corners: ${pickerRadius}`)
  const searchRadius = await page.locator('.dhl-picker-search').evaluate((element) => ({
    actual: getComputedStyle(element).borderRadius,
    token: getComputedStyle(element).getPropertyValue('--dsw-radius-md').trim(),
  }))
  if (searchRadius.actual === '0px' || (searchRadius.token && searchRadius.actual !== searchRadius.token)) throw new Error('market search does not match the DSH input radius: ' + JSON.stringify(searchRadius))
  await page.getByRole('button', { name: '现货', exact: true }).click()
  await page.locator('.dhl-picker-readonly-note').getByText('HIP-3 和现货在 Hyperliquid 本身可交易').waitFor({ state: 'visible' })
  await page.getByRole('textbox', { name: '搜索市场' }).fill('PURR')
  await page.getByRole('option', { name: /PURR\/USDC.*只读/ }).first().waitFor({ state: 'visible', timeout: 15_000 })
  const spotIcon = page.getByRole('option', { name: /PURR\/USDC.*只读/ }).first().locator('.dhl-market-icon img')
  if (!(await spotIcon.getAttribute('src'))?.endsWith('/coins/PURR_spot.svg')) throw new Error('spot icon does not use the official base_spot name')
  if (process.env.DSH_SMOKE_PICKER_SCREENSHOT) await page.getByRole('dialog', { name: '选择市场' }).screenshot({ path: process.env.DSH_SMOKE_PICKER_SCREENSHOT })
  await page.getByRole('option', { name: /PURR\/USDC/ }).first().locator('.dhl-picker-market').click()
  await page.getByRole('button', { name: /PURR\/USDC/ }).first().waitFor({ state: 'visible' })
  await page.waitForFunction(() => {
    const image = document.querySelector('.dhl-market-trigger .dhl-market-icon img')
    return image instanceof HTMLImageElement && image.src.endsWith('/coins/PURR_spot.svg') && image.naturalWidth > 0
  }, null, { timeout: 10_000 })
  console.log('PASS spot icon loads in picker and selected ticker')
  if ((await page.locator('.dhl-market-stats').innerText()).includes('NaN')) throw new Error('spot market stats contain NaN')
  if ((await page.locator('.dhl-market-stat').filter({ hasText: '标记价格' }).innerText()).includes('—')) throw new Error('spot context price missing')
  await page.locator('.dhl-chat-ticket-toggle').click()
  await page.getByRole('button', { name: '启用交易票据' }).click()
  await page.getByText('当前市场仅支持行情查看，尚未接入签名交易').waitFor({ state: 'visible' })
  await page.locator('.dhl-chat-ticket-toggle').click()
  await page.getByRole('button', { name: /PURR\/USDC/ }).first().click()
  await page.getByRole('button', { name: 'Outcome', exact: true }).click()
  if (await page.evaluate(() => window.__dhlStore.get().status?.network === 'mainnet')) {
    await page.getByText('Outcome 目录目前仅在 testnet 提供。').waitFor({ state: 'visible' })
    await page.getByRole('dialog', { name: '选择市场' }).getByRole('button', { name: '关闭' }).click()
    await page.locator('.dhl-market-trigger').click()
  } else {
    await page.locator('.dhl-picker-row .dhl-picker-market').first().waitFor({ state: 'visible', timeout: 15_000 })
    const outcomeCount = Number(((await page.locator('.dhl-picker-foot').innerText()).match(/(\d+) 个市场/) || [])[1])
    if (outcomeCount > 150) {
      await page.locator('.dhl-picker-list').evaluate((element) => { element.scrollTop = element.scrollHeight })
      await page.waitForFunction(() => document.querySelectorAll('.dhl-picker-row').length > 150)
    }
    await page.locator('.dhl-picker-row .dhl-picker-market').first().click()
    await page.getByText('OUTCOME', { exact: true }).first().waitFor({ state: 'visible' })
    await page.locator('.dhl-market-trigger').click()
  }
  await page.getByRole('button', { name: 'HIP-3', exact: true }).click()
  await page.getByRole('textbox', { name: '搜索市场' }).fill('unit:ES')
  const hip3FixtureAvailable = await page.evaluate(() => window.__dhlStore?.get?.().marketCatalog.some((row) => row.name === 'unit:ES'))
  if (hip3FixtureAvailable) {
    await page.locator('.dhl-picker-market strong').filter({ hasText: /^unit:ES$/ }).waitFor({ state: 'visible' })
    await page.waitForFunction(() => Number(window.__dhlStore?.get?.().marketCatalog.find((row) => row.name === 'unit:ES')?.ctx?.markPx) > 0, null, { timeout: 18_000 })
    await page.locator('.dhl-picker-row').filter({ has: page.locator('.dhl-picker-market strong').filter({ hasText: /^unit:ES$/ }) }).locator('.dhl-picker-market').click()
    await page.waitForFunction(() => {
      const s = window.__dhlStore?.get?.()
      return s?.activeCoin === 'unit:ES' && s.selectedMarket?.name === 'unit:ES' && s.selectedMarketAt > 0 && Number(s.selectedMarket.ctx?.markPx) > 0
    }, null, { timeout: 15_000 })
    const selectedAt = await page.evaluate(() => window.__dhlStore.get().selectedMarketAt)
    await page.waitForFunction((previousAt) => {
      const s = window.__dhlStore?.get?.()
      return s?.activeCoin === 'unit:ES' && s.selectedMarketAt > previousAt && Number(s.selectedMarket?.ctx?.markPx) > 0
    }, selectedAt, { timeout: 35_000 })
    console.log('PASS selected HIP-3 market keeps refreshing after picker closes')
    await page.getByRole('button', { name: /^unit:ES/ }).first().click()
  } else console.log('INFO unit:ES is absent from the current exchange catalog')
  await page.getByRole('button', { name: 'TradFi', exact: true }).click()
  await page.getByRole('textbox', { name: '搜索市场' }).fill('eqde:SAP')
  if (await page.evaluate(() => window.__dhlStore?.get?.().marketCatalog.some((row) => row.name === 'eqde:SAP'))) await page.locator('.dhl-picker-market strong').filter({ hasText: /^eqde:SAP$/ }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: 'Crypto', exact: true }).click()
  await page.getByRole('textbox', { name: '搜索市场' }).fill('nova:BTC')
  if (await page.evaluate(() => window.__dhlStore?.get?.().marketCatalog.some((row) => row.name === 'nova:BTC'))) await page.locator('.dhl-picker-market strong').filter({ hasText: /^nova:BTC$/ }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: 'Pre-IPO', exact: true }).click()
  await page.getByRole('textbox', { name: '搜索市场' }).fill('nq:TEST')
  if (await page.evaluate(() => window.__dhlStore?.get?.().marketCatalog.some((row) => row.name === 'nq:TEST'))) await page.locator('.dhl-picker-market strong').filter({ hasText: /^nq:TEST$/ }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '永续', exact: true }).click()
  await page.getByRole('button', { name: '按24h 成交额排序' }).click()
  await page.getByRole('textbox', { name: '搜索市场' }).fill('ETH')
  await page.locator('.dhl-picker-market strong').filter({ hasText: /^ETH-USDC$/ }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '加入自选 ETH-USDC' }).first().click()
  await page.getByRole('textbox', { name: '搜索市场' }).press('Meta+s')
  await page.getByRole('button', { name: '加入自选 ETH-USDC' }).first().waitFor({ state: 'visible' })
  await page.getByRole('textbox', { name: '搜索市场' }).press('Meta+s')
  await page.getByRole('button', { name: '取消自选 ETH-USDC' }).first().waitFor({ state: 'visible' })
  await page.getByRole('dialog', { name: '选择市场' }).press('Enter')
  await page.getByRole('dialog', { name: '选择市场' }).waitFor({ state: 'detached' })
  await page.getByRole('button', { name: /^ETH-USDC/ }).first().waitFor({ state: 'visible' })
  if ((await page.locator('.dhl-notice').allTextContents()).some((text) => text.includes('市场目录加载失败'))) throw new Error('market catalog RPC failed')
  console.log('PASS market picker categories, search, sort, favorite and keyboard selection')

  try {
    await page.locator('.dhl-chart-ohlc').waitFor({ state: 'visible', timeout: 15_000 })
  } catch {
    const chartState = await page.evaluate(() => { const s = window.__dhlStore?.get?.(); return { coin: s?.activeCoin, state: s?.candlesState, count: s?.candles?.length, snapshotError: s?.snapshotError } })
    await page.screenshot({ path: '/tmp/dsh-hl-chart-failure.png' })
    throw new Error('chart OHLC failed after market switch: ' + JSON.stringify(chartState))
  }
  const chartBox = await page.locator('.dhl-chartbox').boundingBox()
  if (!chartBox) throw new Error('chart dimensions missing')
  await page.mouse.move(chartBox.x + chartBox.width * 0.45, chartBox.y + chartBox.height * 0.45)
  await page.waitForTimeout(200)
  if (!(await page.locator('.dhl-chart-ohlc').innerText()).includes('O ')) throw new Error('chart OHLC legend missing')
  await page.getByRole('button', { name: '1h', exact: true }).click()
  await page.getByRole('combobox', { name: '更多 K 线周期' }).selectOption('3m')
  if ((await page.getByRole('combobox', { name: '更多 K 线周期' }).inputValue()) !== '3m') throw new Error('extended candle interval did not select')
  await page.getByRole('button', { name: '15m', exact: true }).click()
  await page.locator('.dhl-indicator-menu summary').click()
  for (const label of ['EMA 20', '布林带 20', 'RSI 14', 'MACD']) {
    await page.locator('.dhl-indicator-popover button').filter({ hasText: label }).click()
  }
  await page.getByLabel('副图指标数值').getByText(/RSI 14/).waitFor({ state: 'visible' })
  await page.getByLabel('副图指标数值').getByText(/MACD/).waitFor({ state: 'visible' })
  const expandedChartHeight = (await page.locator('.dhl-chartbox').boundingBox())?.height ?? 0
  if (expandedChartHeight < 600) throw new Error(`indicator panes did not expand chart: ${expandedChartHeight}`)
  await page.locator('.dhl-indicator-popover button').filter({ hasText: 'RSI 14' }).click()
  if (await page.getByLabel('副图指标数值').getByText(/RSI 14/).count()) throw new Error('RSI pane did not close')
  await page.locator('.dhl-indicator-menu summary').click()
  console.log('PASS indicator menu, EMA/Bollinger overlays and RSI/MACD panes')
  await page.getByRole('button', { name: '放大图表' }).click()
  await page.locator('.dhl-chart-panel-expanded').waitFor({ state: 'visible' })
  const maxChartHeight = (await page.locator('.dhl-chartbox').boundingBox())?.height ?? 0
  if (maxChartHeight < 680) throw new Error(`expanded chart did not occupy viewport: ${maxChartHeight}`)
  await page.getByRole('button', { name: '复位图表视图' }).click()
  await page.keyboard.press('Escape')
  await page.locator('.dhl-chart-panel-expanded').waitFor({ state: 'detached' })
  console.log('PASS chart maximize, view reset and Escape restore')
  await page.getByRole('tab', { name: '成交', exact: true }).click()
  await page.getByRole('tab', { name: '盘口', exact: true }).click()
  await page.getByRole('combobox', { name: '盘口价格档位' }).selectOption('4')
  await page.waitForFunction(() => {
    const s = window.__dhlStore?.get?.()
    return s?.bookGrouping === '4' && s.snapshot?.bookGrouping === '4' &&
      s.snapshot?.groupedBook?.levels?.[0]?.length > 0 && s.snapshot?.observedAt?.groupedBook > 0 &&
      s.snapshot?.seqs?.groupedBook > 0
  }, null, { timeout: 15_000 })
  const depthPrice = await page.locator('.dhl-tape .px').first().innerText()
  await page.locator('.dhl-tape .px').first().click()
  const ticketPrice = await page.evaluate(() => window.__dhlStore.get().ticketDraft?.px)
  if (Number(depthPrice.replaceAll(',', '')) !== Number(ticketPrice)) throw new Error('grouped exchange price was not handed to ticket exactly')
  await page.locator('.dhl-ticket-field').filter({ hasText: '限价' }).locator('input').waitFor({ state: 'visible' })
  await page.locator('.dhl-chat-ticket-toggle').click()
  console.log('PASS chart intervals/OHLC, tape tabs and book-price ticket handoff')

  // A new DSH Session must stay inside the trading desk.
  await page.locator('.dhl-newbtn').click()
  if (process.env.DSH_SMOKE_ALLOW_LEGACY === '1') {
    await page.locator('.dhl-chat-unavailable').waitFor({ state: 'visible', timeout: 15_000 })
    if (!(await page.locator('.dhl-chat-unavailable').innerText()).includes('0.2')) throw new Error('legacy DSH upgrade notice missing')
    if (await page.locator('.dhl-root').count() === 0) throw new Error('legacy session creation navigated away from the desk')
    console.log('PASS legacy DSH displays the native-chat version requirement')
  } else {
  try {
    await page.locator('.dhl-root [data-trading-session]').waitFor({ state: 'visible', timeout: 15_000 })
  } catch (error) {
    await page.screenshot({ path: '/tmp/dsh-hl-session-failure.png' })
    throw new Error(`session did not bind in desk: ${String(error?.message ?? error).slice(0, 100)}; chat=${(await page.locator('.dhl-col-chat').innerText()).slice(0, 1000)}`)
  }
  await page.locator('.dhl-root [data-conversation-scroll]').waitFor({ state: 'visible', timeout: 15_000 })
  await page.waitForTimeout(1200)
  if (await page.locator('.dhl-root').count() === 0) throw new Error('creating a session navigated away from the desk')
  if (await page.locator('.dhl-chatmount [contenteditable="true"]').count() === 0) {
    throw new Error('native DSH Composer did not mount inside the trading desk')
  }
  await page.getByRole('button', { name: '交易体检' }).waitFor({ state: 'visible' })
  const composer = page.locator('.dhl-chatmount [contenteditable="true"]').first()
  await composer.fill('检查 BTC 行情')
  if (!(await composer.innerText()).includes('检查 BTC 行情')) throw new Error('native Composer did not accept text')
  await composer.fill('')
  const firstSession = await page.locator('.dhl-chatmount').getAttribute('data-trading-session')
  if (await page.evaluate(() => window.__dhlStore.get().activeSessionId) !== firstSession) throw new Error('new session was not automatically selected')
  console.log('PASS new session is selected automatically')
  await page.locator('.dhl-newbtn').click()
  await page.waitForFunction((id) => document.querySelector('.dhl-chatmount')?.getAttribute('data-trading-session') !== id, firstSession)
  const secondSession = await page.locator('.dhl-chatmount').getAttribute('data-trading-session')
  await page.locator(`.dhl-srow[data-session-id="${firstSession}"]`).click()
  await page.waitForFunction((id) => document.querySelector('.dhl-chatmount')?.getAttribute('data-trading-session') === id, firstSession)
  if (await page.locator('.dhl-root').count() === 0) throw new Error('switching sessions navigated away from the desk')
  console.log('PASS native DSH conversation and composer embedded in the desk')

  // A real session owns its chart choices and generated drawings.
  await page.waitForFunction((id) => window.__dhlStore.get().workspaceSessionId === id, firstSession)
  await page.locator('.dhl-intervals button').filter({ hasText: /^1h$/ }).click()
  await page.locator('.dhl-indicator-menu summary').click()
  await page.locator('.dhl-indicator-popover button').filter({ hasText: 'SMA 20' }).click()
  await page.locator('.dhl-indicator-menu summary').click()
  await page.getByRole('combobox', { name: '价格刻度' }).selectOption('log')
  await page.getByRole('tab', { name: '成交', exact: true }).click()
  await page.locator('.dhl-desk-foot .dhl-tab').filter({ hasText: '委托与成交' }).click()
  await page.locator('.dhl-history-controls').getByRole('button', { name: '历史委托' }).click()
  await page.locator('.dhl-history-controls').getByRole('button', { name: '成交记录' }).click()
  await page.locator('.dhl-history-controls').getByRole('button', { name: '当前挂单' }).click()
  await page.locator('.dhl-layer-menu summary').click()
  await page.locator('.dhl-layer-popover label').filter({ hasText: '委托' }).getByRole('checkbox').uncheck()
  await page.waitForFunction(() => window.__dhlStore.get().workspace?.chartLayers?.orders === false)
  await page.locator('.dhl-layer-popover label').filter({ hasText: '委托' }).getByRole('checkbox').check()
  await page.locator('.dhl-layer-menu summary').click()
  console.log('PASS order history tabs and chart layer visibility')
  await page.waitForFunction(() => window.__dhlStore.get().candles.length > 2 && window.__dhlStore.get().candlesState === 'ready', null, { timeout: 15000 }).catch(async () => {
    const state = await page.evaluate(() => { const s = window.__dhlStore.get(); return { coin: s.activeCoin, interval: s.interval, candles: s.candles.length, state: s.candlesState, notice: s.notice } })
    throw new Error('session chart did not load before drawing: ' + JSON.stringify(state))
  })
  await page.getByRole('button', { name: '水平线', exact: true }).click()
  const drawBox = await page.locator('.dhl-chartbox').boundingBox()
  if (!drawBox) throw new Error('session drawing chart missing')
  await page.mouse.click(drawBox.x + drawBox.width * 0.48, drawBox.y + drawBox.height * 0.42)
  await page.waitForFunction(() => window.__dhlStore.get().chartMarks.some((mark) => mark.source === 'user'), null, { timeout: 6000 }).catch(async () => {
    const state = await page.evaluate(() => { const s = window.__dhlStore.get(); return { coin: s.activeCoin, interval: s.interval, candles: s.candles.length, key: s.chartMarksKey, marks: s.chartMarks, notice: s.notice, workspace: s.workspaceSessionId } })
    throw new Error('user drawing was not saved: ' + JSON.stringify(state) + '; page errors=' + JSON.stringify(errors))
  })
  await page.waitForFunction(() => document.querySelector('button[title="单击图表添加水平线"]')?.getAttribute('aria-pressed') === 'false')
  await page.getByRole('button', { name: '趋势线', exact: true }).click()
  await page.mouse.click(drawBox.x + drawBox.width * 0.31, drawBox.y + drawBox.height * 0.54)
  await page.mouse.move(drawBox.x + drawBox.width * 0.64, drawBox.y + drawBox.height * 0.37)
  await page.locator('.dhl-chart-drawing-preview').waitFor({ state: 'attached', timeout: 3000 }).catch(async () => {
    const debug = await page.evaluate(() => ({
      pressed: document.querySelector('button[title="单击图表两次添加趋势线"]')?.getAttribute('aria-pressed'),
      start: document.querySelector('.dhl-chart-drawing-start')?.outerHTML,
      overlay: document.querySelector('.dhl-chart-drawing-overlay')?.outerHTML,
      marks: window.__dhlStore.get().chartMarks.map((mark) => ({ kind: mark.kind, source: mark.source })),
    }))
    throw new Error('trend preview missing: ' + JSON.stringify(debug))
  })
  if (process.env.DSH_SMOKE_PREVIEW_SCREENSHOT) await page.locator('.dhl-chart').screenshot({ path: process.env.DSH_SMOKE_PREVIEW_SCREENSHOT })
  await page.mouse.click(drawBox.x + drawBox.width * 0.64, drawBox.y + drawBox.height * 0.37)
  await page.waitForFunction(() => window.__dhlStore.get().chartMarks.some((mark) => mark.source === 'user' && mark.kind === 'trend'))
  await page.waitForFunction(() => document.querySelectorAll('.dhl-chart-drawing-overlay .dhl-chart-anchor').length >= 2)
  await page.locator('.dhl-intervals button').filter({ hasText: /^15m$/ }).click()
  await page.waitForFunction(() => window.__dhlStore.get().interval === '15m' && window.__dhlStore.get().chartMarks.some((mark) => mark.source === 'user' && mark.interval === '1h'))
  await page.getByLabel('画线列表').getByText(/水平线/).first().waitFor({ state: 'visible' })
  await page.locator('.dhl-intervals button').filter({ hasText: /^1h$/ }).click()
  if (process.env.DSH_SMOKE_DRAW_SCREENSHOT) await page.locator('.dhl-chart').screenshot({ path: process.env.DSH_SMOKE_DRAW_SCREENSHOT })
  console.log('PASS trend drawing previews, saves and remains visible across intervals')
  await page.locator('.dhl-indicator-menu summary').click()
  await page.locator('.dhl-indicator-popover button').filter({ hasText: 'MA 60' }).click()
  await page.locator('.dhl-indicator-menu summary').click()
  await page.waitForFunction(() => window.__dhlStore.get().workspace?.indicators.includes('sma60'))
  await composer.fill('这里的成交量明显放大，MA60 交叉？')
  const quoteBox = await page.locator('.dhl-chartbox').boundingBox()
  if (!quoteBox) throw new Error('chart box disappeared before quote')
  const dragFrom = { x: quoteBox.x + quoteBox.width * 0.52, y: quoteBox.y + quoteBox.height * 0.44 }
  await page.mouse.move(dragFrom.x, dragFrom.y)
  await page.mouse.down()
  await page.mouse.move(dragFrom.x + 85, dragFrom.y + 12, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(250)
  const draftAfterPan = await composer.innerText()
  if (draftAfterPan.includes('· C ') || draftAfterPan.includes('【图表点位】') || await page.evaluate(() => window.__dhlStore.get().chartReferences.length > 0)) {
    throw new Error('dragging the chart added a quote to the chat draft')
  }
  console.log('PASS chart pan does not quote a point')
  await page.mouse.click(quoteBox.x + quoteBox.width * 0.48, quoteBox.y + quoteBox.height * 0.42)
  await page.waitForFunction(() => document.querySelector('.dhl-chatmount [contenteditable="true"]')?.textContent?.includes('· C '), null, { timeout: 5000 }).catch(async (error) => {
    const debug = await page.evaluate(() => ({ references: window.__dhlStore.get().chartReferences, notice: window.__dhlStore.get().notice, draft: document.querySelector('.dhl-chatmount [contenteditable="true"]')?.textContent, session: window.__dhlStore.get().activeSessionId, candles: window.__dhlStore.get().candles.length }))
    throw new Error(`chart quote did not reach composer: ${JSON.stringify(debug)}; page errors=${JSON.stringify(errors)}; ${String(error)}`)
  })
  const quotedDraft = await composer.innerText()
  if (!quotedDraft.includes('这里的成交量明显放大，MA60 交叉？') || (quotedDraft.match(/· C /g) ?? []).length !== 1) {
    throw new Error('chart click did not preserve the draft and insert exactly one point chip: ' + quotedDraft.slice(0, 600))
  }
  const quotedClose = Number(quotedDraft.match(/· C (\d+(?:\.\d+)?)/)?.[1])
  const actualCandle = await page.evaluate((close) => window.__dhlStore.get().candles.some((candle) => candle.c === close), quotedClose)
  if (!Number.isFinite(quotedClose) || !actualCandle) throw new Error('chart quote does not identify a loaded candle: ' + quotedDraft.slice(0, 500))
  await composer.fill('')
  console.log('PASS chart click adds one editable point chip while preserving the existing draft')
  await page.getByRole('button', { name: '收起对话栏' }).click()
  await page.locator('.dhl-col-chat').waitFor({ state: 'detached' })
  await page.locator(`.dhl-srow[data-session-id="${secondSession}"]`).click()
  await page.waitForFunction((id) => window.__dhlStore.get().workspaceSessionId === id, secondSession)
  await page.locator('.dhl-col-chat').waitFor({ state: 'visible' })
  const secondPrefs = await page.evaluate(() => { const s = window.__dhlStore.get(); return { interval: s.interval, indicators: s.workspace.indicators, scale: s.workspace.priceScale, tapeTab: s.workspace.tapeTab, bottomTab: s.workspace.bottomTab, marks: s.chartMarks } })
  if (secondPrefs.interval !== '15m' || secondPrefs.indicators.includes('sma20') || secondPrefs.indicators.includes('sma60') || secondPrefs.scale !== 'normal' || secondPrefs.tapeTab !== 'book' || secondPrefs.bottomTab !== 'positions' || secondPrefs.marks.length) throw new Error('second session inherited first session chart settings: ' + JSON.stringify(secondPrefs))
  await page.locator(`.dhl-srow[data-session-id="${firstSession}"]`).click()
  await page.waitForFunction((id) => window.__dhlStore.get().workspaceSessionId === id, firstSession)
  await page.locator('.dhl-col-chat').waitFor({ state: 'detached' })
  await page.getByRole('button', { name: '展开对话栏' }).click()
  await page.waitForFunction(() => window.__dhlStore.get().chartMarks.some((mark) => mark.source === 'user'))
  const firstPrefs = await page.evaluate(() => { const s = window.__dhlStore.get(); return { interval: s.interval, indicators: s.workspace.indicators, scale: s.workspace.priceScale, tapeTab: s.workspace.tapeTab, bottomTab: s.workspace.bottomTab } })
  if (firstPrefs.interval !== '1h' || !firstPrefs.indicators.includes('sma20') || !firstPrefs.indicators.includes('sma60') || firstPrefs.scale !== 'log' || firstPrefs.tapeTab !== 'trades' || firstPrefs.bottomTab !== 'orders') throw new Error('first session settings did not restore: ' + JSON.stringify(firstPrefs))
  console.log('PASS per-session interval, indicators, price scale and user drawing isolation')

  // The ticket remains available as a secondary intent editor.
  await page.locator('.dhl-chat-ticket-toggle').click()
  await page.getByRole('tab', { name: '限价' }).click()
  await page.locator('.dhl-ticket-field').filter({ hasText: '限价' }).locator('input').waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '卖出 / 做空' }).click()
  if ((await page.getByRole('button', { name: '卖出 / 做空' }).getAttribute('aria-pressed')) !== 'true') {
    throw new Error('ticket side control did not update')
  }
  await page.locator('.dhl-chat-ticket-toggle').click()
  await page.locator('.dhl-chatmount [contenteditable="true"]').waitFor({ state: 'visible', timeout: 10_000 })
  console.log('PASS secondary ticket controls and return to chat')

  const firstRow = page.locator(`.dhl-srow[data-session-id="${firstSession}"]`)
  await firstRow.hover()
  await firstRow.getByRole('button', { name: '重命名' }).click()
  await page.getByRole('dialog', { name: '重命名' }).getByRole('textbox', { name: '会话名称' }).fill('BTC 测试会话')
  await page.getByRole('dialog', { name: '重命名' }).getByRole('button', { name: '保存' }).click()
  await firstRow.getByText('BTC 测试会话').waitFor({ state: 'visible' })
  await firstRow.hover()
  await firstRow.getByRole('button', { name: '归档' }).click()
  await firstRow.waitFor({ state: 'detached' })
  await page.waitForFunction((id) => window.__dhlStore.get().activeSessionId !== id, firstSession)
  await page.locator('.dhl-chatmount [contenteditable="true"]').waitFor({ state: 'visible', timeout: 10_000 })
  console.log('PASS native session rename and archive with automatic next-session selection')

  // Draw through the same client state that chartMarks RPC fills. This catches
  // LWC price-line/series integration failures in the packed browser build.
  await page.waitForFunction(() => window.__dhlStore.get().candles.length > 2 && window.__dhlStore.get().workspaceSessionId === window.__dhlStore.get().activeSessionId)
  await page.evaluate(() => {
    const desk = window.__dhlStore.get()
    const last = desk.candles.at(-1)
    const from = desk.candles.at(-10)
    if (!last || !desk.activeSessionId) throw new Error('chart data/session missing for annotation check')
    window.__dhlStore.patch({
      chartMarksKey: `${desk.activeSessionId}:${desk.activeCoin}`,
      chartMarks: [
        { id: 'smoke-mark', sessionId: desk.activeSessionId, coin: desk.activeCoin, interval: desk.interval, kind: 'level', role: 'support', label: 'Agent 支撑测试线', price: last.c * 0.99, source: 'agent', createdAt: Date.now() },
        ...(from ? [{ id: 'smoke-trend', sessionId: desk.activeSessionId, coin: desk.activeCoin, interval: desk.interval, kind: 'trend', role: 'resistance', label: 'Agent 趋势测试线', fromTime: from.t, fromPrice: from.h, toTime: last.t, toPrice: last.h, source: 'agent', createdAt: Date.now() }] : []),
      ],
    })
  })
  await page.getByLabel('画线列表').getByText('Agent 支撑测试线').waitFor({ state: 'visible' })
  await page.getByLabel('画线列表').getByText('Agent 趋势测试线').waitFor({ state: 'visible' })
  console.log('PASS agent annotation renders on the live chart')

  if (await page.evaluate(() => window.__dhlStore.get().status?.network === 'mainnet')) {
    await page.getByRole('button', { name: '交易设置' }).click()
    await page.getByRole('menu').getByRole('button', { name: '测试网' }).click()
    await page.waitForFunction(() => window.__dhlStore.get().status?.network === 'testnet')
  }
  await page.getByRole('button', { name: '交易设置' }).click()
  await page.getByRole('menu').getByRole('button', { name: '主网' }).click()
  await page.getByRole('dialog', { name: '切换到主网实盘' }).getByRole('button', { name: '确认切换' }).click()
  await page.waitForFunction(() => window.__dhlStore.get().status?.network === 'mainnet')
  await page.waitForFunction(() => {
    const s = window.__dhlStore.get()
    return s.snapshot?.network === 'mainnet' && s.snapshot?.book?.levels?.[0]?.length > 0
  }, null, { timeout: 20_000 })
  await page.getByRole('button', { name: '交易设置' }).click()
  await page.getByRole('menu').getByRole('button', { name: '测试网' }).click()
  await page.waitForFunction(() => window.__dhlStore.get().status?.network === 'testnet')
  await page.waitForFunction(() => {
    const s = window.__dhlStore.get()
    return s.snapshot?.network === 'testnet' && s.snapshot?.book?.levels?.[0]?.length > 0
  }, null, { timeout: 20_000 })
  console.log('PASS native mainnet confirmation and network round-trip')
  }

  if (process.env.DSH_SMOKE_SCREENSHOT) {
    await page.locator('.dhl-root').screenshot({ path: process.env.DSH_SMOKE_SCREENSHOT })
    console.log('PASS desk screenshot saved')
  }

  // The host resets its main panel on reload. The plugin restores the desk,
  // then the first visible trading session becomes active.
  const firstVisibleSession = await page.locator('.dhl-srow').first().getAttribute('data-session-id')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('.dhl-root').waitFor({ state: 'visible', timeout: 15_000 })
  await page.waitForFunction((id) => window.__dhlStore?.get?.().sessionsLoaded && window.__dhlStore?.get?.().activeSessionId === id &&
    document.querySelector('.dhl-srow.active')?.getAttribute('data-session-id') === id, firstVisibleSession, { timeout: 15_000 })
  console.log('PASS refresh restores the desk and selects its first visible trading session')

  const fatal = errors.filter((e) => !/ResizeObserver|WebSocket|network|favicon/i.test(e))
  if (fatal.length > 0) throw new Error('fatal page errors: ' + fatal.slice(0, 3).join(' | '))
  console.log('PASS no fatal page errors')
} finally {
  await browser.close()
}
