// First-session value: trading check-up, market radar, alert wake-ups and the state-driven prompt.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeTrading, checkupText, roundTrips } from '../lib/analysis.js'
import { rankSignals } from '../lib/scan.js'
import { createAgentWaker, alertWakeText } from '../lib/wake.js'
import { deskPrompt, deskPromptFor, losingStreak, unprotectedPositions } from '../lib/prompt.js'
import { HyperStore } from '../lib/store.js'
import { HyperRemote } from '../lib/remote.js'

const H = 3_600_000, T0 = Date.UTC(2026, 8, 1, 2) // a Tuesday, 10:00 in Shanghai
const fill = (coin, t, side, sz, px, start, closedPnl = 0, fee = 0.1, tid) => ({ coin, time: T0 + t, side, sz: String(sz), px: String(px), startPosition: String(start), closedPnl: String(closedPnl), fee: String(fee), tid: tid ?? `${coin}${t}${side}` })

// ── round trips: add, partial close, flip, and a position already open at the window start ──
const trips = roundTrips([
  fill('ETH', -1 * H, 'A', 1, 2000, 1, 5),                 // closes a long opened before the window → partial
  fill('BTC', 0, 'B', 1, 100, 0), fill('BTC', H, 'B', 1, 110, 1), fill('BTC', 2 * H, 'A', 1, 120, 2, 15), fill('BTC', 3 * H, 'A', 1, 120, 1, 15),
  fill('SOL', 4 * H, 'B', 2, 10, 0), fill('SOL', 5 * H, 'A', 3, 9, 2, -2),   // long 2 → short 1: flip
  fill('SOL', 6 * H, 'B', 1, 8, -1, 1),
])
assert.equal(trips.closed.length, 4)
assert.deepEqual(trips.closed.map((t) => [t.coin, t.side, t.partial]), [['ETH', 'long', true], ['BTC', 'long', false], ['SOL', 'long', false], ['SOL', 'short', false]])
assert.ok(Math.abs(trips.closed[1].net - (30 - 0.4)) < 1e-9, 'a trip nets closed PnL minus every fee in it')
assert.equal(roundTrips([fill('BTC', 0, 'B', 1, 100, 0, 0, 0.1, 'x'), fill('BTC', 0, 'B', 1, 100, 0, 0, 0.1, 'x')]).open.length, 1, 'a fill seen twice counts once')

// ── check-up: 12 trips; quick re-entries after a loss lose money; funding is attributed per trip ──
const fills = []; let t = 0
for (let i = 0; i < 12; i += 1) {
  const loss = i % 3 === 0, quick = i % 3 === 1
  const open = t + (quick ? 10 * 60_000 : 2 * H)
  const pnl = loss ? -20 : quick ? -8 : 25
  fills.push(fill('BTC', open, 'B', 1, 100, 0, 0, 0.5, `o${i}`), fill('BTC', open + H, 'A', 1, 100, 1, pnl, 0.5, `c${i}`))
  t = open + H
}
const funding = [{ time: T0 + 2.5 * H, delta: { type: 'funding', coin: 'BTC', usdc: '-1.5' } }]
const result = analyzeTrading(fills, { funding, timeZone: 'Asia/Shanghai' })
assert.equal(result.summary.trades, 12); assert.equal(result.summary.sampleEnough, true)
assert.equal(result.summary.funding, -1.5, 'funding inside a trip is charged to it')
const quick = result.findings.find((f) => f.text.includes('分钟内又开仓'))
assert.ok(quick && quick.rule.includes('冷静'), JSON.stringify(result.findings))
assert.ok(checkupText(result, { days: 90, mode: 'live/mainnet' }).includes('建议规则'))
const small = analyzeTrading(fills.slice(0, 8))
assert.equal(small.summary.sampleEnough, false); assert.equal(small.findings.filter((f) => !f.strength).length, 0, 'too few trips → no habit verdicts')
assert.ok(checkupText(small, { days: 30, mode: 'paper' }).includes('不足以判断'))
assert.match(checkupText(analyzeTrading([]), { days: 90, mode: 'paper' }), /scan/, 'no history points to the radar instead')

// ── radar ranking ──
const markets = [
  { name: 'BTC', kind: 'perp', ctx: { markPx: '100', prevDayPx: '95', oraclePx: '100', funding: '0.00001', dayNtlVlm: '9e9' } },
  { name: 'HYPE', kind: 'perp', ctx: { markPx: '40', prevDayPx: '44', oraclePx: '40', funding: '0.0002', dayNtlVlm: '5e8' } },
  { name: 'xyz:XYZ100', kind: 'hip3', ctx: { markPx: '30000', prevDayPx: '29900', oraclePx: '29880', funding: '-0.00005', dayNtlVlm: '3e8' } },
]
const ranked = rankSignals(markets, { BTC: { high: 101, low: 90, bars: 20 }, HYPE: { high: 50, low: 41, bars: 20 } })
assert.equal(ranked.funding[0].coin, 'HYPE'); assert.equal(ranked.movers[0].coin, 'HYPE')
assert.equal(ranked.premium[0].coin, 'xyz:XYZ100'); assert.ok(ranked.levels[0].broken && ranked.levels[0].coin === 'HYPE', 'a broken range ranks first')

// ── waker: dedupe, merge, cooldown, stale drop ──
let clock = 0
const timers = []
const delivered = []
const waker = createAgentWaker({ now: () => clock, setTimer: (fn, ms) => { const timer = { fn, at: clock + ms }; timers.push(timer); return timer }, clearTimer: () => {},
  deliver: async (sessionId, text) => { delivered.push({ sessionId, text, at: clock }); return true } })
const run = async (to) => { clock = to; for (const timer of timers.splice(0).sort((a, b) => a.at - b.at)) { if (timer.at <= clock) await timer.fn(); else timers.push(timer) } }
const ev = (id, at, extra = {}) => ({ id, at, sessionId: 's1', coin: 'BTC', label: '支撑', line: 100, price: 99, direction: 'down', ...extra })
assert.equal(waker.notify(ev('a', 0)), true); assert.equal(waker.notify(ev('a', 0)), false, 'the same event is delivered once')
waker.notify(ev('b', 1000))
await run(5_000)
assert.equal(delivered.length, 1); assert.ok(delivered[0].text.includes('支撑') && delivered[0].text.split('\n').filter((l) => l.startsWith('- ')).length === 2, 'two alerts merged into one wake-up')
assert.ok(delivered[0].text.includes('按盯盘闭环自主处理') && delivered[0].text.includes('自动开仓必须带止损'), 'alert wake carries the closed-loop protocol and the stop requirement')
waker.notify(ev('c', 60_000))
await run(65_000)
assert.equal(delivered.length, 1, 'cooldown: no second wake within 5 minutes')
await run(5_000 + 5 * 60_000 + 1) // cooldown counts from the last delivery (at 5s)
assert.equal(delivered.length, 2, 'the waiting event goes out when the cooldown ends')
waker.notify(ev('old', clock - 11 * 60_000))
await run(clock + 6 * 60_000)
assert.equal(delivered.length, 2, 'stale events are dropped')
assert.equal(waker.notify({ id: 'x', at: 1 }), false, 'no session, no wake-up')
assert.match(alertWakeText([ev('z', 0, { direction: 'up' })]), /上穿/)

// ── state-driven prompt ──
const store = new HyperStore(mkdtempSync(join(tmpdir(), 'dhl-prompt-')))
const remote = { cfg: { tradingMode: 'live', network: 'mainnet' }, isManaged: () => false, store, desk: { coin: 'BTC', interval: '1h' }, lastLiveAccount: null }
let text = deskPrompt(remote)
assert.ok(text.includes('【第一次见面】') && text.includes('hyper_account action=analyze') && !text.includes('最高优先'))
assert.ok(text.includes('不要调用 hyper_* 工具'), 'plain greetings must not trigger market/book reads')
assert.ok(text.length < 1700, `the section stays within budget (${text.length} chars)`)
remote.lastLiveAccount = { at: Date.now(), network: 'mainnet', value: { mode: 'live', positions: [{ coin: 'BTC', size: 0.5 }, { coin: 'ETH', size: -2 }],
  openOrders: [{ coin: 'BTC', side: 'A', isTrigger: true, reduceOnly: true, orderType: 'Stop Market', origSz: '0.5' }, { coin: 'ETH', side: 'B', isTrigger: true, reduceOnly: true, orderType: 'Take Profit Market', origSz: '2' }] } }
assert.deepEqual(unprotectedPositions(remote.lastLiveAccount.value), ['ETH'], 'a take-profit is not a stop')
text = deskPrompt(remote)
assert.ok(text.indexOf('最高优先') > 0 && text.indexOf('最高优先') < text.indexOf('【第一次见面】'), 'the unprotected position comes first')
store.saveJournal({ profile: { 风险偏好: { value: '1%' } }, strategies: [], entries: [-1, -0.5, -1].map((r, i) => ({ type: 'trade', resultR: r, mode: 'live', network: 'mainnet', at: i, text: 'x' })) })
assert.equal(losingStreak(store.journal(), { mode: 'live', network: 'mainnet' }), 3)
text = deskPrompt(remote)
assert.ok(text.includes('连续亏损 3 笔') && text.includes('档案还缺：常做市场、持仓周期') && !text.includes('【第一次见面】'))
remote.cfg.tradingMode = 'paper'
assert.ok(!deskPrompt(remote).includes('最高优先'), 'paper mode never warns about live stops')
// The section is attached per Agent and only answers inside desk sessions, so an
// unrelated conversation in the same profile never sees the trading persona.
const scoped = new HyperStore(mkdtempSync(join(tmpdir(), 'dhl-scope-')))
const scopedRemote = { cfg: { tradingMode: 'live', network: 'mainnet' }, isManaged: () => false, store: scoped, desk: { coin: 'BTC', interval: '1h' }, lastLiveAccount: null }
assert.equal(deskPromptFor(scopedRemote, 'session-plain'), '', 'non-desk sessions get no persona')
scoped.registerSession('session-plain')
assert.ok(deskPromptFor(scopedRemote, 'session-plain').includes('交易副手'), 'a registered desk session gets the persona')
// ── HIP-3 alerts fire (their mids are not in core allMids) and reach the waker ──
const alertStore = new HyperStore(mkdtempSync(join(tmpdir(), 'dhl-hip3-alert-')))
alertStore.registerSession('s9', { coin: 'xyz:XYZ100' })
const alertRemote = Object.create(HyperRemote.prototype)
Object.assign(alertRemote, { store: alertStore, cfg: { network: 'mainnet' }, alertSides: new Map(), alertListeners: new Set(), dexMidCache: new Map(),
  touch: (key) => key, client: { snapshot: () => ({ at: Date.now(), data: { mids: { BTC: '80000' } } }) } })
alertStore.addChartMark({ sessionId: 's9', coin: 'xyz:XYZ100', interval: '4h', kind: 'level', role: 'support', label: 'VAL 28,700', source: 'agent', price: 28700, alert: true })
const heard = []
alertRemote.alertListeners.add((event) => heard.push(event))
alertRemote.dexMidCache.set('xyz', { at: Date.now(), mids: { 'xyz:XYZ100': '28750' } })
assert.deepEqual(alertRemote.checkDrawingAlerts(), [], 'first look only records the side')
alertRemote.dexMidCache.set('xyz', { at: Date.now(), mids: { 'xyz:XYZ100': '28650' } })
const fired = alertRemote.checkDrawingAlerts()
assert.equal(fired.length, 1, 'a HIP-3 alert fires on the dex mid'); assert.equal(heard[0]?.sessionId, 's9', 'and the waker hears it for the owning session')
alertRemote.dexMidCache.set('xyz', { at: Date.now() - 60_000, mids: { 'xyz:XYZ100': '28800' } })
assert.deepEqual(alertRemote.checkDrawingAlerts(), [], 'stale dex mids are ignored')

// codex v1 review: spot / non-USDC fills stay out; same-millisecond open+close in reverse order still pairs
assert.equal(roundTrips([fill('@107', 0, 'B', 1, 40, 0), { ...fill('BTC', H, 'B', 1, 100, 0), feeToken: 'HYPE' }]).open.length, 0, 'spot and non-USDC fills are excluded')
const sameMs = roundTrips([fill('ETH', 5 * H, 'A', 1, 2100, 1, 100, 0.1, 'close'), fill('ETH', 5 * H, 'B', 1, 2000, 0, 0, 0.1, 'open')])
assert.equal(sameMs.closed.length, 1); assert.equal(sameMs.closed[0].partial, false, 'reverse-ordered same-ms fills still form one full trip')

console.log('首次价值：交易体检、市场雷达、提醒唤醒护栏与状态驱动的系统提示通过')
