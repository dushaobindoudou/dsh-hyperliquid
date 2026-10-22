import assert from 'node:assert/strict'
import { createTurnOriginGuard } from '../lib/turn-origin.js'

const origin = new Map()
let hear
let enabled = false
const guard = createTurnOriginGuard({ on: (_name, fn) => { hear = fn } }, {
  origin: { get: (id) => origin.get(id), set: (id, value) => origin.set(id, value) },
  canAutoTrade: () => enabled,
  isLive: () => true,
})
const session = { id: 'test-session' }
const exec = { agent: { id: session.id, session } }
const start = (source) => {
  hear(session, { type: 'turn/start' })
  hear(session, { type: 'user/message', data: { source } })
}

// Switch off: automatic rounds may reduce risk or cancel, but may not open.
start({ kind: 'schedule' })
assert.throws(() => guard('hyper_decide', { action: 'place', stopLossPx: 95 }, exec), /未开启盯盘/)
guard('hyper_order', { action: 'protect', stopLossPx: 95 }, exec) // moving or adding a stop never adds risk
enabled = true
// With the switch on, automatic rounds may open only with a stop loss.
guard('hyper_decide', { action: 'place', stopLossPx: 95 }, exec)
guard('hyper_order', { action: 'place', stopLossPx: 95 }, exec)
guard('hyper_order', { action: 'place', reduceOnly: true }, exec)
assert.throws(() => guard('hyper_order', { action: 'place' }, exec), /必须带有效 stopLossPx/)
assert.throws(() => guard('hyper_decide', { action: 'place' }, exec), /必须带有效 stopLossPx/)
guard('hyper_order', { action: 'cancel', oid: 1 }, exec)
guard('hyper_order', { action: 'leverage', leverage: 5 }, exec)
guard('hyper_account', { action: 'limits' }, exec)
guard('hyper_account', { action: 'transfer' }, exec)
start({ kind: 'plugin:dsh-hyperliquid', form: 'event' })
assert.throws(() => guard('hyper_order', { action: 'place' }, exec), /必须带有效 stopLossPx/)
start({ kind: 'plugin:dsh-hyperliquid', form: 'market-bar' })
guard('hyper_account', { action: 'transfer' }, exec)
assert.throws(() => guard('hyper_account', { action: 'withdraw' }, exec), /提现/, 'withdrawal is never permitted')
assert.throws(() => guard('hyper_session', { action: 'watch', on: true }, exec), /只能由用户开启/, 'an automatic round never turns 盯盘 on')
guard('hyper_session', { action: 'watch', on: false }, exec)
start({ kind: 'user' })
guard('hyper_session', { action: 'watch', on: true }, exec)
start({ kind: 'plugin:dsh-hyperliquid', form: 'market-bar' })

// After a plugin reload, the persisted origin must still enforce the stop requirement.
const reloaded = createTurnOriginGuard({ on: () => {} }, {
  origin: { get: (id) => origin.get(id), set: (id, value) => origin.set(id, value) },
  canAutoTrade: () => enabled,
  isLive: () => true,
})
assert.throws(() => reloaded('hyper_order', { action: 'place' }, exec), /必须带有效 stopLossPx/)
reloaded('hyper_order', { action: 'place', stopLossPx: 95 }, exec)

start({ kind: 'user' })
assert.throws(() => guard('hyper_decide', { action: 'place' }, exec), /实盘开仓必须带有效 stopLossPx/)
assert.throws(() => guard('hyper_order', { action: 'place' }, exec), /实盘开仓必须带有效 stopLossPx/)
guard('hyper_order', { action: 'place', stopLossPx: 95 }, exec)

// Switch off again: degraded allowance only.
enabled = false
start({ kind: 'schedule' })
assert.throws(() => guard('hyper_order', { action: 'place', stopLossPx: 95 }, exec), /未开启盯盘/)
guard('hyper_order', { action: 'place', reduceOnly: true }, exec)
guard('hyper_order', { action: 'cancel', oid: 2 }, exec)
assert.throws(() => guard('hyper_order', { action: 'place' }, exec), /必须带有效 stopLossPx/)
assert.throws(() => guard('hyper_order', { action: 'leverage', leverage: 5 }, exec), /未开启盯盘/)
assert.throws(() => guard('hyper_account', { action: 'limits' }, exec), /未开启盯盘/)
assert.throws(() => guard('hyper_account', { action: 'withdraw' }, exec), /提现/)

console.log('automatic order gate: opens require a stop loss; switch-off allows risk reduction only')
