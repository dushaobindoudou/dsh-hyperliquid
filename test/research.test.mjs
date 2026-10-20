import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeStudies, normalizeIndicatorSettings } from '../lib/studies.js'
import { computeIndicators } from '../lib/indicators.js'
import { reviewLedger, fundingWindow } from '../lib/review.js'
import { HyperRemote } from '../lib/remote.js'
import { HyperStore } from '../lib/store.js'
import { buildToolDefinitions } from '../lib/tools.js'
import { normalizeResearch, normalizePaperCosts } from '../lib/workspace-settings.js'
const near = (a,b) => assert.ok(Math.abs(a-b)<1e-9, `${a} ≈ ${b}`)
const start = Date.UTC(2026, 9, 1)
const bars = Array.from({length:100}, (_,i) => { const c = 100+i/3+Math.sin(i)*5; return { t:start+i*3600000, T:start+(i+1)*3600000-1, o:c-1,h:c+2,l:c-2,c,v:10+i } })
const defaultStudies = computeStudies(bars)
near(defaultStudies.rsi14.at(-1).value, computeIndicators(bars).rsi14)
near(defaultStudies.macd.at(-1).value, computeIndicators(bars).macd.line)
const p = normalizeIndicatorSettings({rsi:{period:2},macd:{fast:2,slow:3,signal:2},bollinger:{period:3,multiplier:1},stochastic:{period:3,smoothK:2,smoothD:2},adx:{period:2,smoothing:2}})
const simple = [10,12,11,14,15,13].map((c,i) => ({t:start+i*60000,o:c,h:c+1,l:c-1,c,v:i+1}))
const values=computeStudies(simple,p)
near(values.rsi14[0].value, 100-100/(1+2))
near(values.rsi14[1].value, 100-100/(1+8))
near(values.basis[0].value,11)
near(values.upper[0].value,11+Math.sqrt(2/3))
near(values.macd[0].value,0)
near(values.signal[0].value,.25)
const raw=(i)=> {const w=simple.slice(i-2,i+1); return 100*(simple[i].c-Math.min(...w.map(c=>c.l)))/(Math.max(...w.map(c=>c.h))-Math.min(...w.map(c=>c.l)))}
near(values.stochK[0].value,(raw(2)+raw(3))/2)
near(values.stochD[0].value,((raw(2)+raw(3))/2+(raw(3)+raw(4))/2)/2)
assert.deepEqual(values.obv.map(p=>p.value),[0,2,-1,3,8,2])
const rising=Array.from({length:40},(_,i)=>({...simple[0],t:start+i*60000,c:100+i,h:101+i,l:99+i}))
assert.equal(computeStudies(rising).adx[0].time,rising[27].t/1000)
near(computeStudies(rising).adx.at(-1).value,100)
const flat=rising.map(c=>({...c,c:100,h:100,l:100}))
near(computeStudies(flat).adx.at(-1).value,0);assert.equal(computeStudies(flat).stochK.length,0)
for(const bad of [{rsi:{period:0}},{macd:{fast:30,slow:20}},{rsi:{lower:80,upper:70}},{bollinger:{multiplier:NaN}},{adx:{period:1.5}},{rsi:{bogus:1}}])assert.throws(()=>normalizeIndicatorSettings(bad))
assert.throws(()=>normalizeResearch({intervals:['1h']})); assert.throws(()=>normalizePaperCosts({feeBps:-1,slippageBps:5}))
const payload={mode:'live',coverage:{fundingStatus:'complete'},orders:[{coin:'BTC',oid:1,origSz:2,status:'filled',referencePx:100,reason:'突破后放量确认'}],fills:[
{coin:'BTC',oid:1,tid:11,time:start,side:'B',px:101,sz:1,closedPnl:10,fee:1,feeToken:' USDC',builderFee:.2,startPosition:-1},
{coin:'BTC',oid:1,tid:12,time:start+1,side:'B',px:100,sz:1,closedPnl:0,fee:1,feeToken:'USDC',startPosition:0}],funding:[{time:start,delta:{coin:'BTC',usdc:'-2'}}]}
let ledger=reviewLedger({...payload,fills:[...payload.fills,payload.fills[0]]})
assert.equal(ledger.duplicates,1);near(ledger.gross,10);near(ledger.tradingNet,8);near(ledger.funding,-2);near(ledger.net,6)
assert.equal(ledger.gaps,0);assert.equal(ledger.missingReasons,0);assert.equal(ledger.closeCount,1);near(ledger.records[0].slippageBps,100)
assert.equal(ledger.fees.USDC,2,'builderFee is already included; do not charge again')
assert.equal(reviewLedger({...payload,coverage:{fundingStatus:'partial'}}).net,null)
assert.equal(reviewLedger({...payload,fills:[{...payload.fills[0],fee:undefined}]}).tradingNet,null)
assert.equal(reviewLedger({...payload,fills:[{...payload.fills[0],coin:'xyz:XYZ100'}]}).unsupported,1)
assert.equal(reviewLedger({...payload,fills:payload.fills.slice(0,1)}).gaps,1)
assert.equal(reviewLedger({...payload,orders:[{coin:'BTC',oid:1,status:'canceled',origSz:2}],fills:[]}).gaps,0)
const frow=(time)=>({time,hash:String(time),delta:{type:'funding',coin:'BTC',usdc:'1'}})
let calls=0
let funding=await fundingWindow({info:async(_type,args)=> {calls++;if(calls===1)return Array.from({length:500},(_,i)=>frow(i+1)); assert.equal(args.startTime,500);return[frow(500),frow(501)]}},'address',0,1000)
assert.equal(funding.rows.length,501);assert.equal(funding.status,'complete')
funding=await fundingWindow({info:async()=>Array(500).fill(frow(1))},'address',0,1000);assert.equal(funding.status,'partial')
let page=0
funding=await fundingWindow({info:async()=>++page===1?[...Array.from({length:499},(_,i)=>frow(i+1)),{bad:1}]:[]},'address',0,1000);assert.equal(funding.status,'partial')
assert.equal(reviewLedger({...payload,fills:[{...payload.fills[0],coin:'xyz:XYZ100'}]},'xyz:XYZ100').tradingNet,null)
assert.equal(reviewLedger({...payload,fills:[{...payload.fills[0],fee:undefined}]}).closeCount,1)
const dir=mkdtempSync(join(tmpdir(),'dhl-research-'))
try{
 const store=new HyperStore(dir);store.registerSession('a',{coin:'BTC'});store.registerSession('b',{coin:'ETH'})
 const remote=Object.create(HyperRemote.prototype);Object.assign(remote,{store,cfg:{tradingMode:'paper',network:'testnet'}})
 await remote.updateSessionWorkspace({sessionId:'a',patch:{indicatorSettings:p,indicators:['rsi14','stochastic','adx','obv'],research:{layout:'quad',intervals:['5m','4h','1d'],syncTime:false,syncCursor:true},showDataWindow:true}})
 await remote.indicatorTemplates({action:'save',name:'研究',indicators:['rsi14','adx'],indicatorSettings:p,maLines:[]})
 await remote.updatePaperCosts({costs:{feeBps:10,slippageBps:5}})
 const loaded=new HyperStore(dir)
 assert.deepEqual(loaded.getSessionWorkspace('a').indicatorSettings,p);assert.equal(loaded.getSessionWorkspace('a').research.layout,'quad');assert.equal(loaded.getSessionWorkspace('b').indicatorSettings,undefined)
 assert.equal(loaded.indicatorTemplates()[0].name,'研究');assert.equal(loaded.paperCosts().feeBps,10)
 const initial=store.paper.usd
 let fill=store.paperFill({coin:'BTC',isBuy:true,sz:1,px:100,feeBps:10,reason:'突破确认',referencePx:99});store.paperOrderRecord({oid:fill.oid,coin:'BTC',sz:1,reason:'突破确认'})
 near(store.paper.usd,initial-.1)
 fill=store.paperFill({coin:'BTC',isBuy:false,sz:1,px:110,feeBps:10,reason:'目标到达'});store.paperOrderRecord({oid:fill.oid,coin:'BTC',sz:1,reason:'目标到达'})
 near(store.paper.usd,initial+10-.21)
 ledger=reviewLedger(await remote.tradeHistory({startTime:Date.now()-10000,includeFunding:true}))
 near(ledger.tradingNet,9.79);assert.equal(ledger.unmatched,0);assert.equal(ledger.net,null,'paper funding remains unmodelled')
 remote.candles=async()=>({candles:bars})
 const tool=buildToolDefinitions(remote).find(t=>t.name==='hyper_market')
 const result=await tool.execute({action:'indicators',coin:'BTC',interval:'1h'},{agent:{id:'a'}})
 assert.deepEqual(result.configured.settings,p);near(result.configured.values.rsi14,computeStudies(bars,p).rsi14.at(-1).value)
 assert.ok(result.text.includes('RSI2='));assert.ok(result.text.includes('Stoch'))
}finally{rmSync(dir,{recursive:true,force:true})}
console.log('研究与复盘：指标金值/参数一致性、窗口和去重、资金费分页、订单核对、成本落账与配置恢复通过')
