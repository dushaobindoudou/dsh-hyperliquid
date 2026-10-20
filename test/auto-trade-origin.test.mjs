import assert from 'node:assert/strict'
import { createTurnOriginGuard } from '../lib/turn-origin.js'

const origin = new Map()
let hear
let enabled = false
const guard = createTurnOriginGuard({ on: (_name, fn) => { hear = fn } }, {
  origin: { get: (id) => origin.get(id), set: (id, value) => origin.set(id, value) },
  canAutoTrade: () => enabled,
})
const session = { id: 'test-session' }
const exec = { agent: { id: session.id, session } }
const start = (source) => {
  hear(session, { type: 'turn/start' })
  hear(session, { type: 'user/message', data: { source } })
}

// Switch off: automatic rounds keep the degraded allowance (stop-carrying opens, reduce-only, cancels).
start({ kind: 'schedule' })
assert.throws(() => guard('hyper_decide', { action: 'place', stopLossPx: 95 }, exec), /自动通知/)
enabled = true
// Owner mandate (2026-10-20): with the switch on, automatic rounds hold every trading permission
// except withdrawal — naked opens, leverage, limits, transfers, any round form, any network.
guard('hyper_decide', { action: 'place', stopLossPx: 95 }, exec)
guard('hyper_order', { action: 'place', stopLossPx: 95 }, exec)
guard('hyper_order', { action: 'place', reduceOnly: true }, exec)
guard('hyper_order', { action: 'place' }, exec)
guard('hyper_order', { action: 'cancel', oid: 1 }, exec)
guard('hyper_order', { action: 'leverage', leverage: 5 }, exec)
guard('hyper_account', { action: 'limits' }, exec)
guard('hyper_account', { action: 'transfer' }, exec)
start({ kind: 'plugin:dsh-hyperliquid', form: 'event' })
guard('hyper_order', { action: 'place' }, exec)
start({ kind: 'plugin:dsh-hyperliquid', form: 'market-bar' })
guard('hyper_account', { action: 'transfer' }, exec)
assert.throws(() => guard('hyper_account', { action: 'withdraw' }, exec), /提现/, 'withdrawal is never permitted')

// Switch off again: degraded allowance only.
enabled = false
start({ kind: 'schedule' })
guard('hyper_order', { action: 'place', stopLossPx: 95 }, exec)
guard('hyper_order', { action: 'place', reduceOnly: true }, exec)
guard('hyper_order', { action: 'cancel', oid: 2 }, exec)
assert.throws(() => guard('hyper_order', { action: 'place' }, exec), /自动通知/)
assert.throws(() => guard('hyper_order', { action: 'leverage', leverage: 5 }, exec), /自动通知/)
assert.throws(() => guard('hyper_account', { action: 'limits' }, exec), /自动通知/)
assert.throws(() => guard('hyper_account', { action: 'withdraw' }, exec), /提现/)

console.log('automatic order gate: mandate grants everything but withdrawal; switch-off keeps the degraded allowance')
