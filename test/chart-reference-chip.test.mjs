// Chart quote chips: the ref round-trips the full model text and the point to reopen.
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const out = await build({ entryPoints: ['src/client/chart-reference.ts'], bundle: true, format: 'esm', write: false, platform: 'node' })
const mod = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
const candle = { t: Date.UTC(2026, 9, 15, 5, 45), o: 81302, h: 81418, l: 81266, c: 81397, v: 24 }
const selection = { candle, hit: null, values: [], priorVolumeMean20: 10 }
const text = mod.formatChartReference(selection, 'BTC', '15m')
const ref = mod.encodeChartReference({ coin: 'BTC', interval: '15m', t: candle.t, text })
assert.deepEqual(mod.decodeChartReference(ref), { coin: 'BTC', interval: '15m', t: candle.t, text })
assert.equal(mod.decodeChartReference('not json'), null)
assert.equal(mod.decodeChartReference(JSON.stringify({ coin: 'BTC' })), null)
assert.match(mod.chartReferenceLabel(selection, 'BTC', '15m'), /^BTC 15m \d\d-\d\d \d\d:\d\d · C 81397$/)
console.log('图表引用标签编码、解码与短标签通过')
