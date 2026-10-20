import assert from 'node:assert/strict'
import { build } from 'esbuild'

const built = await build({ entryPoints: ['src/client/strategy-theories.ts'], bundle: true, format: 'esm', write: false, platform: 'node' })
const { evaluateStrategyStudies } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'))
const minute = 60_000
const start = Date.UTC(2026, 9, 1)
const rows = Array.from({ length: 70 }, (_, index) => {
  const close = 100 + index * .2 + (index === 69 ? 10 : 0)
  return { t: start + index * minute, o: close - .1, h: close + .5, l: close - .5, c: close, v: index === 69 ? 30 : 10 }
})
const now = start + 70 * minute + 1
const ready = evaluateStrategyStudies(rows, 'BTC', '1m', now)
assert.equal(ready.find((study) => study.id === 'trend')?.state, 'candidate')
assert.equal(ready.find((study) => study.id === 'breakout')?.state, 'candidate')
assert.match(ready[0].prompt, /不要下单/)
const open = { t: start + 70 * minute, o: 100, h: 400, l: 1, c: 400, v: 1000 }
assert.deepEqual(evaluateStrategyStudies([...rows, open], 'BTC', '1m', now), ready, 'forming candle must not change strategy studies')
assert.equal(evaluateStrategyStudies(rows.slice(0, 30), 'BTC', '1m', now)[0].state, 'insufficient')
assert.equal(evaluateStrategyStudies(rows, 'BTC', '1m', now + 4 * minute)[0].state, 'stale')
const quiet = rows.map((row, index) => index === 69 ? { ...row, v: 10 } : row)
assert.equal(evaluateStrategyStudies(quiet, 'BTC', '1m', now).find((study) => study.id === 'breakout')?.state, 'watch')
console.log('策略研究只使用已收盘 K 线，区分候选、观望、过期与数据不足')
