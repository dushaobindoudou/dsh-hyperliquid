import assert from 'node:assert/strict'
import { roundTrips, analyzeTrading } from '../lib/analysis.js'
import { scanMarkets } from '../lib/scan.js'
import { createAgentWaker } from '../lib/wake.js'
import { createTurnOriginGuard } from '../lib/turn-origin.js'
import { unprotectedPositions, deskPrompt } from '../lib/prompt.js'
import { HyperRemote } from '../lib/remote.js'
const defer = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
const f = (time, side, sz, start, fee, pnl = 0) => ({ coin: 'BTC', time, side, sz, startPosition: start, px: 100, fee, closedPnl: pnl })
const flipped = roundTrips([f(1,'B',1,0,0),f(2,'A',3,1,3,10)])
assert.equal(flipped.closed[0].fees,1); assert.equal(flipped.closed[0].net,9)
assert.equal(flipped.closed[0].maxNotional,100)
assert.equal(flipped.open[0].fees,2); assert.equal(flipped.open[0].net,-2)
const small = analyzeTrading(Array.from({ length: 5 }, (_, i) => [f(i*2+1,'B',1,0,1),f(i*2+2,'A',1,1,1,3)]).flat())
assert.equal(small.findings.length,0)
assert.deepEqual(unprotectedPositions({ mode:'live', positions:[{coin:'BTC',size:2}],openOrders:[{coin:'BTC',isTrigger:true,reduceOnly:true,side:'A',orderType:'Stop Market',origSz:2,sz:0.5}] }),['BTC'])
assert.ok(!deskPrompt({cfg:{tradingMode:'live',network:'mainnet'},isManaged:()=>true,store:{journal:()=>({})}}).includes('工具报错时换参数重试'))
let listener
const origins=new Map()
const authorize=createTurnOriginGuard({on:(_name,fn)=>{listener=fn}},{origin:{get:(id)=>origins.get(id),set:(id,v)=>origins.set(id,v)}}), session={id:'s1'}, exec={agent:{id:'s1',session}}
// Turn not observed and no persisted alert origin: a normal (e.g. paper) order is allowed.
authorize('hyper_order',{},exec)
// A plugin reload mid-alert retains the automatic turn's restrictions.
{
  const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path')
  const { HyperStore } = await import('../lib/store.js')
  const store = new HyperStore(mkdtempSync(join(tmpdir(), 'dhl-origin-reload-')))
  const persisted = { get: (id) => store.alertOrigin(id), set: (id, v) => store.setAlertOrigin(id, v) }
  let hear; createTurnOriginGuard({ on: (_n, fn) => { hear = fn } }, { origin: persisted })
  const s2 = { id: 's2' }, exec2 = { agent: { id: 's2', session: s2 } }
  hear(s2, { type: 'turn/start' }); hear(s2, { type: 'user/message', data: { source: { kind: 'plugin:dsh-hyperliquid', form: 'event' } } })
  let hear2; const reloaded = createTurnOriginGuard({ on: (_n, fn) => { hear2 = fn } }, { origin: { get: (id) => new HyperStore(store.dataDir).alertOrigin(id), set: persisted.set } })
  assert.throws(() => reloaded('hyper_order', {}, exec2), /自动通知/)
  assert.throws(() => reloaded('hyper_account', { action: 'transfer' }, exec2), /自动通知/)
  assert.throws(() => reloaded('hyper_account', { action: 'withdraw' }, exec2), /提现/, 'withdrawal stays refused after a reload')
  hear2(s2, { type: 'turn/start' }); hear2(s2, { type: 'user/message', data: { source: { kind: 'schedule' } } })
  reloaded('hyper_order', { action: 'cancel', oid: 1 }, exec2)
  assert.throws(() => reloaded('hyper_order', {}, exec2), /自动通知/, 'switch off: naked auto-round opens still wait for the mandate')
  hear2(s2, { type: 'user/message', data: { source: { kind: 'user' } } })
  reloaded('hyper_order', {}, exec2)
  assert.equal(store.alertOrigin('s2'), false, 'a human message clears the persisted alert origin')
  for (let i = 0; i < 520; i += 1) store.setAlertOrigin(`old-${i}`, false)
  store.setAlertOrigin('live-alert', true); for (let i = 0; i < 520; i += 1) store.setAlertOrigin(`newer-${i}`, false)
  assert.equal(store.alertOrigin('live-alert'), true, 'pruning never drops a live alert origin')
}
listener(session,{type:'turn/start'})
authorize('hyper_order',{},exec)
listener(session,{type:'user/message',data:{source:{kind:'plugin:dsh-hyperliquid',form:'event'}}})
listener(session,{type:'user/message',data:{source:{kind:'human'}}})
for(const [tool,args] of [['hyper_order',{}],['hyper_decide',{}],['hyper_account',{action:'limits'}],['hyper_account',{action:'transfer'}]]) assert.throws(()=>authorize(tool,args,exec),/自动通知/)
assert.throws(()=>authorize('hyper_account',{action:'withdraw'},exec),/提现/)
authorize('hyper_account',{action:'analyze'},exec);authorize('hyper_chart',{},exec)
listener(session,{type:'turn/start'});authorize('hyper_order',{},exec)
listener(session,{type:'user/message',data:{source:{kind:'user'}}});authorize('hyper_order',{},exec)
// Network switch while candle reads are in flight must never populate the radar cache.
const pending=defer(),entered=defer(); let calls=0
const remote={cfg:{network:'old-test'},client:{},marketCatalog:async()=>{calls++;return {markets:[{name:'BTC',kind:'perp',tradable:true,ctx:{dayNtlVlm:2e6,markPx:100}}]}},candles:async()=>{entered.resolve();await pending.promise;return {candles:[]}}}
const scanning=scanMarkets(remote);await entered.promise;remote.cfg.network='new-test';remote.client={};pending.resolve()
await assert.rejects(scanning,/网络已切换/)
remote.cfg.network='old-test';await scanMarkets(remote);assert.equal(calls,2)
const dexPending=defer(),dexEntered=defer()
const alerts=Object.create(HyperRemote.prototype)
Object.assign(alerts,{cfg:{network:'testnet'},client:{},store:{allChartMarks:()=>[{alert:true,coin:'xyz:X'}]},dexMidCache:new Map(),dexMids:async()=>{dexEntered.resolve();return dexPending.promise}})
const refreshing=alerts.refreshAlertDexMids();await dexEntered.promise;alerts.client={};alerts.cfg.network='mainnet';dexPending.resolve({'xyz:X':100})
await assert.rejects(refreshing,/网络已切换/);assert.equal(alerts.dexMidCache.size,0)
// Disposing a wake in flight aborts the service lookup and never schedules another delivery.
const deliveryPending=defer(),deliveryEntered=defer(),timers=[];let sent=0
const waker=createAgentWaker({setTimer:(fn)=>{timers.push(fn);return fn},clearTimer:()=>{},deliver:async(_id,_text,{signal})=>{deliveryEntered.resolve();await deliveryPending.promise;if(signal.aborted)return false;sent++;return true}})
const ev={id:'a',at:Date.now(),sessionId:'s',coin:'BTC',line:1,price:2}
waker.notify(ev);timers.shift()();await deliveryEntered.promise;waker.notify({...ev,id:'b'});waker.dispose();deliveryPending.resolve();await new Promise(r=>setImmediate(r))
assert.equal(sent,0);assert.equal(waker.notify({...ev,id:'c'}),false)
for(const fn of timers.splice(0))fn();assert.equal(timers.length,0)
console.log('Release safety: flip fees, sample size, stop coverage, event origin, stale network data and disposal passed')
