import assert from 'node:assert/strict'
import { build } from 'esbuild'
const compiled = await build({ entryPoints: [new URL('../src/client/chart-feed.ts', import.meta.url).pathname], bundle: true, format: 'esm', write: false })
const { feed } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'))
const calls = []
const series = { setData: (rows) => calls.push(['set', rows]), update: (point) => calls.push(['update', point]) }
const initial = [{ time: 1, close: 10 }, { time: 2, close: 11 }, { time: 3, close: 12 }]
feed(series, initial)
feed(series, [...initial.slice(0, -1), { time: 3, close: 13 }])
assert.deepEqual(calls.map((call) => call[0]), ['set', 'update'], 'a live tick only updates its tail')
const corrected = [{ time: 1, close: 10 }, { time: 2, close: 20 }, { time: 3, close: 13 }]
feed(series, corrected)
assert.equal(calls.at(-1)[0], 'set', 'REST history correction with unchanged timestamps replaces the full series')
calls.length = 0
feed(series, [...corrected.slice(0, -1), { time: 3, close: 14 }, { time: 4, close: 15 }])
assert.deepEqual(calls, [['update', { time: 3, close: 14 }], ['update', { time: 4, close: 15 }]], 'a new bar also finalizes the preceding one')
feed(series, [{ time: 1, close: 999 }, ...corrected.slice(1), { time: 4, close: 15 }, { time: 5, close: 16 }])
assert.equal(calls.at(-1)[0], 'set', 'appending does not hide an earlier correction')
const points = [{ time: 1, value: 1, color: 'red' }, { time: 2, value: 2, color: 'red' }]
feed(series, points, 'indicator')
feed(series, [{ ...points[0], color: 'blue' }, points[1]], 'indicator')
assert.equal(calls.at(-1)[0], 'set', 'historical per-point colors are compared as well')
feed(series, points, 'new-settings')
assert.equal(calls.at(-1)[0], 'set', 'changed indicator settings force a full feed')
console.log('图表增量更新：末根、追加、历史修正、颜色和参数失效通过')
