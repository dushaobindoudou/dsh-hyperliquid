/**
 * Store regression tests — the paper ledger is the source of truth for
 * paper-mode equity; a sign error in realized-PnL settlement silently
 * corrupts every account (found 2026-10-13: `usd -= realized` paid losses
 * and charged profits).
 *
 * Run: node test/store.test.mjs   (exit 0 = all checks pass)
 * @module test/store.test.mjs
 */

import { HyperStore } from '../lib/store.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let fail = 0
function check(label, cond, extra) {
  console.log(cond ? 'PASS' : 'FAIL', label, cond ? '' : JSON.stringify(extra ?? {}))
  if (!cond) fail += 1
}
const approx = (a, b, eps = 1e-9) => Math.abs(Number(a) - Number(b)) < eps
function freshStore() {
  return new HyperStore(join(mkdtempSync(join(tmpdir(), 'dhl-store-')), 'data'))
}

// 1. THE regression: closing a winner must INCREASE cash.
{
  const s = freshStore()
  s.paperFill({ coin: 'BTC', isBuy: true, sz: 1, px: 100 })
  s.paperFill({ coin: 'BTC', isBuy: false, sz: 1, px: 110 })
  check('平多盈利 +10 入账', approx(s.paperAccount().usd, 100010), { usd: s.paperAccount().usd })
}

// 2. Closing a loser decreases cash.
{
  const s = freshStore()
  s.paperFill({ coin: 'BTC', isBuy: true, sz: 1, px: 100 })
  s.paperFill({ coin: 'BTC', isBuy: false, sz: 1, px: 90 })
  check('平多亏损 -10 入账', approx(s.paperAccount().usd, 99990), { usd: s.paperAccount().usd })
}

// 3. Short side: sell high, buy back low → profit.
{
  const s = freshStore()
  s.paperFill({ coin: 'ETH', isBuy: false, sz: 2, px: 100 })
  s.paperFill({ coin: 'ETH', isBuy: true, sz: 2, px: 90 })
  check('平空盈利 +20 入账', approx(s.paperAccount().usd, 100020), { usd: s.paperAccount().usd })
}

// 4. Partial close: only the closed portion realizes; entry stays weighted.
{
  const s = freshStore()
  s.paperFill({ coin: 'BTC', isBuy: true, sz: 1, px: 100 })
  s.paperFill({ coin: 'BTC', isBuy: false, sz: 0.5, px: 110 })
  const mid = s.paperAccount()
  check('平半仓盈利 +5 入账', approx(mid.usd, 100005), { usd: mid.usd })
  check('剩余半仓持仓', approx(mid.positions.BTC.size, 0.5), mid.positions.BTC)
  check('剩余持仓均价保持 100', approx(mid.positions.BTC.entryPx, 100), mid.positions.BTC)
}

// 5. Flip long → short: realizes, then opens the opposite side at the fill px.
{
  const s = freshStore()
  s.paperFill({ coin: 'BTC', isBuy: true, sz: 1, px: 100 })
  s.paperFill({ coin: 'BTC', isBuy: false, sz: 2, px: 110 })
  const mid = s.paperAccount()
  check('翻空后持仓为 -1', approx(mid.positions.BTC.size, -1), mid.positions.BTC)
  check('翻空开仓价 = 110', approx(mid.positions.BTC.entryPx, 110), mid.positions.BTC)
  check('翻空实现盈亏 +10', approx(mid.usd, 100010), { usd: mid.usd })
}

// 6. Adding to a position keeps the weighted-average entry.
{
  const s = freshStore()
  s.paperFill({ coin: 'BTC', isBuy: true, sz: 1, px: 100 })
  s.paperFill({ coin: 'BTC', isBuy: true, sz: 1, px: 120 })
  check('加仓后均价 110', approx(s.paperAccount().positions.BTC.entryPx, 110))
}

// 7. Full close removes the position row entirely.
{
  const s = freshStore()
  s.paperFill({ coin: 'BTC', isBuy: true, sz: 1, px: 100 })
  s.paperFill({ coin: 'BTC', isBuy: false, sz: 1, px: 100 })
  check('全平后删除持仓行', !('BTC' in s.paperAccount().positions))
}

// 8. Event ring records fills and replays since a seq.
{
  const s = freshStore()
  const seq0 = s.eventSeq
  s.paperFill({ coin: 'BTC', isBuy: true, sz: 1, px: 100 })
  const ev = s.eventsSince(seq0)
  check('事件环记录 paper.fill', ev.events.some((e) => e.kind === 'paper.fill' && e.seq > seq0), ev.events)
  check('eventsSince 返回推进的 seq', Number.isFinite(ev.seq) && ev.seq > seq0)
}

// 9. Session registry: register / bind / remove / guard.
{
  const s = freshStore()
  s.registerSession('s1', { coin: 'BTC' })
  s.registerSession('s2', { coin: 'ETH' })
  check('会话登记 2 条', s.listSessions().length === 2)
  s.bindCoin('s1', 'SOL')
  check('bindCoin 生效', s.getSession('s1').coin === 'SOL')
  s.removeSession('s1')
  check('removeSession 生效', s.listSessions().length === 1)
  let threw = false
  try { s.bindCoin('nope', 'BTC') } catch { threw = true }
  check('未登记会话 bind 抛错', threw)
}

// 10. Durability: reopen from the same dataDir.
{
  const dir = join(mkdtempSync(join(tmpdir(), 'dhl-store-')), 'data')
  const s1 = new HyperStore(dir)
  s1.paperFill({ coin: 'BTC', isBuy: true, sz: 1, px: 100 })
  const s2 = new HyperStore(dir)
  check('落盘后可恢复持仓', approx(s2.paperAccount().positions.BTC.size, 1), s2.paperAccount().positions.BTC)
}

// 11. Live order journal survives a restart for timeout reconciliation.
{
  const dir = join(mkdtempSync(join(tmpdir(), 'dhl-store-')), 'data')
  const cloid = '0x' + 'ab'.repeat(16)
  const s1 = new HyperStore(dir)
  s1.recordLiveOrder(cloid, { status: 'submitting', coin: 'BTC' })
  const s2 = new HyperStore(dir)
  check('live 订单审计可恢复', s2.getLiveOrder(cloid)?.status === 'submitting')
}

// 12. Paper leverage persists before opening and on an existing position.
{
  const s = freshStore()
  s.paperSetLeverage('BTC', 3)
  s.paperFill({ coin: 'BTC', isBuy: true, sz: 1, px: 100 })
  check('paper 开仓使用预设杠杆', s.paperAccount().positions.BTC.leverage === 3)
  s.paperSetLeverage('BTC', 2)
  check('paper 已有仓位杠杆同步', s.paperAccount().positions.BTC.leverage === 2)
}

// 13. Decision rationale survives a restart and links to the order ID.
{
  const dir = join(mkdtempSync(join(tmpdir(), 'dhl-store-')), 'data')
  const s1 = new HyperStore(dir)
  s1.recordLiveDecision('decision-1', { sessionId: 's1', order: { coin: 'BTC' }, thesis: '测试依据', preview: { mid: 100 } })
  const s2 = new HyperStore(dir)
  check('live 决策依据可恢复', s2.liveDecisions['decision-1']?.thesis === '测试依据')
}

console.log(fail ? `${fail} check(s) FAILED` : 'store 全部通过')
process.exit(fail ? 1 : 0)
