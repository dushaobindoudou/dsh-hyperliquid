// Undo/redo against a scripted host: a batch undo that partly fails keeps only the failed members
// for the retry, so nothing is re-created twice.
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const stub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /^(\.\/(remote|store|data)|react)$/ }, (args) => ({ path: args.path, namespace: 'stub' }))
  b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ loader: 'js', contents: {
    './remote': 'export const hyperCall = (...a) => globalThis.__host(...a); export const tr = (zh) => zh',
    './store': 'export const notify = () => {}; let s = globalThis.__state; export const store = { get: () => globalThis.__state, patch: (p) => { globalThis.__state = { ...globalThis.__state, ...(typeof p === "function" ? p(globalThis.__state) : p) } } }',
    './data': 'export const loadChartMarks = async () => {}',
    // The hook only needs refs and a re-render trigger; effects (scope reset) do not run here.
    react: 'export const useRef = (v) => ({ current: v }); export const useState = (v) => [v, () => {}]; export const useEffect = () => {}',
  }[args.path] })) } }
const out = await build({ entryPoints: ['src/client/drawing-history.ts'], bundle: true, format: 'esm', write: false, platform: 'node', plugins: [stub] })
const { useDrawingHistory } = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))

globalThis.__state = { activeSessionId: 's1', activeCoin: 'BTC', interval: '1h', chartMarks: [] }
const host = new Map(), created = []
let failCreate = new Set(), next = 1
globalThis.__host = async (method, req) => {
  if (method === 'drawChartMark') {
    if (failCreate.has(req.label)) throw new Error('host down')
    const mark = { ...req, id: `m${next++}` }; host.set(mark.id, mark); created.push(req.label); return mark
  }
  if (method === 'eraseChartMark') { host.delete(req.id); return { ok: true } }
  if (method === 'updateChartMark') return { ok: true }
  throw new Error(method)
}
const history = useDrawingHistory('s1:BTC')

await history.create({ kind: 'level', label: 'x', price: 1 })
await history.create({ kind: 'level', label: 'y', price: 2 })
await history.removeMany([...host.keys()])
assert.equal(host.size, 0)
failCreate = new Set(['x'])
await history.undo()
assert.deepEqual([...host.values()].map((m) => m.label), ['y'], 'the member that could be restored is back')
failCreate = new Set()
await history.undo()
assert.deepEqual([...host.values()].map((m) => m.label).sort(), ['x', 'y'], 'the retry restores only the member that failed')
assert.deepEqual(created, ['x', 'y', 'y', 'x'], 'nothing is re-created twice')
await history.redo(); await history.redo()
assert.equal(host.size, 0, 'redo removes both again (two partial steps)')
console.log('画线撤销/重做：批量部分失败后只重试失败成员，不重复创建')
