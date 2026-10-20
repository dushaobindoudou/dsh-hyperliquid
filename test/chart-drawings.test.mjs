// Drawing tools: host validation for every kind, the agent path, and SVG geometry (ray clipping, fib, measure).
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { DRAWING_CLICKS, DRAWING_KINDS, DRAWING_POINTS, FIB_LEVELS, drawingGeometry, drawingStyle, linePriceAt } from '../lib/chart-drawings.js'
import { HyperStore } from '../lib/store.js'
import { HyperRemote } from '../lib/remote.js'
import { buildToolDefinitions } from '../lib/tools.js'

const now = Date.UTC(2026, 9, 15)
const pt = (hours, price) => ({ time: now - hours * 3600_000, price })
assert.equal(DRAWING_KINDS.length, 78)
assert.deepEqual(drawingGeometry('hray', { points: [pt(5, 100)] }, now), { points: [pt(5, 100)] })
assert.equal(drawingGeometry('channel', { points: [pt(9, 100), pt(3, 110), pt(6, 95)] }, now).points.length, 3)
assert.deepEqual(drawingGeometry('trend', { fromTime: pt(400 * 24, 1).time, fromPrice: 1, toTime: pt(1, 2).time, toPrice: 2 }, now).fromPrice, 1, 'trend lines may start long before the old 90-day window')
for (const [kind, request, error] of [
  ['hexagon', { points: [] }, /画线类型/],
  ['fib', { points: [pt(2, 100)] }, /需要 2 个 points/],
  ['ray', { points: [pt(2, 100), pt(2, 120)] }, /时间不能相同/],
  ['rect', { points: [pt(2, 100), { time: 1, price: 5 }] }, /时间必须/],
  ['vline', { points: [{ time: now, price: -1 }] }, /价格必须为正数/],
  ['level', { price: 0 }, /price/],
  ['trend', { fromTime: pt(1, 1).time, fromPrice: 1, toTime: pt(2, 1).time, toPrice: 1 }, /晚于起点/],
]) assert.throws(() => drawingGeometry(kind, request, now), error, kind)

// New kinds: point counts, freehand bounds, ordering rules, text kinds.
for (const [kind, n] of Object.entries({ fibext: 3, fibchannel: 3, fibtime: 2, gannfan: 2, pitchfork: 3, regression: 2, arrow: 2, callout: 2, circle: 2, triangle: 3 })) {
  const points = Array.from({ length: n }, (_, i) => pt(10 - i * 3, 100 + i))
  assert.equal(drawingGeometry(kind, { points }, now).points.length, n, kind)
}
assert.throws(() => drawingGeometry('regression', { points: [pt(1, 100), pt(5, 100)] }, now), /晚于/)
assert.throws(() => drawingGeometry('brush', { points: [pt(1, 100)] }, now), /2-500/)
assert.equal(drawingGeometry('brush', { points: Array.from({ length: 120 }, (_, i) => pt(120 - i, 100 + Math.sin(i))) }, now).points.length, 120)
assert.throws(() => drawingGeometry('brush', { points: Array.from({ length: 501 }, (_, i) => pt(600 - i, 100)) }, now), /2-500/)
assert.deepEqual(drawingStyle({ hidden: true }), { hidden: true })

// Positions store [entry, stop, target] but are created with two clicks.
assert.equal(DRAWING_POINTS.long, 3); assert.equal(DRAWING_CLICKS.long, 2)
assert.ok(drawingGeometry('long', { points: [pt(6, 100), pt(1, 95), pt(1, 110)] }, now))
assert.throws(() => drawingGeometry('long', { points: [pt(6, 100), pt(1, 105), pt(1, 110)] }, now), /止损 < 入场 < 止盈/)
assert.throws(() => drawingGeometry('short', { points: [pt(6, 100), pt(1, 95), pt(1, 90)] }, now), /止盈 < 入场 < 止损/)
assert.deepEqual(drawingStyle({ color: '#ABCDEF', lineWidth: 3, lineStyle: 'dotted', locked: true }), { color: '#abcdef', lineWidth: 3, lineStyle: 'dotted', locked: true })
for (const bad of [{ color: 'red' }, { lineWidth: 5 }, { lineWidth: 1.5 }, { lineStyle: 'wavy' }, { locked: 'yes' }]) assert.throws(() => drawingStyle(bad))

// Agent path through hyper_chart and the desk's drawChartMark.
const dir = mkdtempSync(join(tmpdir(), 'dhl-draw-'))
const store = new HyperStore(dir)
store.registerSession('s1', { coin: 'BTC' })
const remote = Object.create(HyperRemote.prototype)
remote.store = store
remote.desk = { coin: 'BTC', interval: '1h' }
const chart = buildToolDefinitions(remote).find((tool) => tool.name === 'hyper_chart')
const fib = await chart.execute({ action: 'add', kind: 'fib', label: '本轮上涨回撤', points: [{ time: Date.now() - 20 * 3600_000, price: 78000 }, { time: Date.now() - 3600_000, price: 82000 }] }, { agent: { id: 's1' } })
assert.match(fib.text, /添加斐波那契回撤：本轮上涨回撤/)
assert.equal(fib.mark.points.length, 2)
const user = await remote.drawChartMark({ sessionId: 's1', coin: 'BTC', interval: '1h', kind: 'channel', label: '平行通道', points: [pt(9, 100), pt(3, 110), pt(6, 95)].map((p) => ({ ...p, time: Date.now() - (now - p.time) })) })
assert.equal(user.source, 'user')
assert.deepEqual(new HyperStore(dir).listChartMarks('s1', 'BTC', null).map((mark) => mark.kind).sort(), ['channel', 'fib'], 'drawings survive restart')

// Editing: geometry is re-validated as a whole; style and lock persist; a locked drawing refuses edits.
const moved = await remote.updateChartMark({ sessionId: 's1', id: fib.mark.id, patch: { points: [{ time: Date.now() - 30 * 3600_000, price: 77000 }, { time: Date.now() - 2 * 3600_000, price: 82500 }], color: '#ef5f6c', lineWidth: 3 } })
assert.equal(moved.points[0].price, 77000); assert.equal(moved.color, '#ef5f6c'); assert.equal(moved.lineWidth, 3)
await assert.rejects(remote.updateChartMark({ sessionId: 's1', id: fib.mark.id, patch: { points: [{ time: Date.now(), price: 1 }] } }), /需要 2 个 points/)
await remote.updateChartMark({ sessionId: 's1', id: fib.mark.id, patch: { locked: true } })
await assert.rejects(remote.updateChartMark({ sessionId: 's1', id: fib.mark.id, patch: { color: '#2fd3a0' } }), /已锁定/)
await remote.updateChartMark({ sessionId: 's1', id: fib.mark.id, patch: { locked: false, lineStyle: 'dashed' } })
const reloaded = new HyperStore(dir).listChartMarks('s1', 'BTC', null).find((mark) => mark.id === fib.mark.id)
assert.equal(reloaded.lineStyle, 'dashed'); assert.equal(reloaded.locked, false); assert.equal(reloaded.points[1].price, 82500, 'edits survive restart')
assert.equal(store.events.at(-1).kind, 'chart.mark', 'edits notify open desks')
const viaAgent = await chart.execute({ action: 'update', id: user.id, color: '#9b86db', label: '主通道' }, { agent: { id: 's1' } })
assert.match(viaAgent.text, /已更新平行通道：主通道/)
// Pinned tables: created on a screen spot, unpinned by the agent with both fractions null.
const pinnedTable = await remote.drawChartMark({ sessionId: 's1', coin: 'BTC', interval: '1h', kind: 'table', label: '品种|方向;BTC|多', points: [{ time: Date.now() - 3600_000, price: 81000 }], screenX: 0.7, screenY: 0.1 })
assert.equal(pinnedTable.screenX, 0.7)
await assert.rejects(remote.updateChartMark({ sessionId: 's1', id: pinnedTable.id, patch: { screenX: 0.2, screenY: null } }), /同时提供/)
// Unpinning goes through a plain boolean (no union types in the tool schema).
assert.equal(chart.parameters.properties.unpin.type, 'boolean')
await chart.execute({ action: 'update', id: pinnedTable.id, unpin: true }, { agent: { id: 's1' } })
const unpinnedTable = new HyperStore(dir).listChartMarks('s1', 'BTC', null).find((mark) => mark.id === pinnedTable.id)
assert.ok(unpinnedTable.screenX == null && unpinnedTable.screenY == null && unpinnedTable.points[0].price === 81000, 'the agent unpins a table back to its stored time and price')
await assert.rejects(remote.updateChartMark({ sessionId: 's2', id: user.id, patch: { color: '#ffffff' } }), /交易会话|不存在/)
const callout = await remote.drawChartMark({ sessionId: 's1', coin: 'BTC', interval: '1h', kind: 'callout', label: '这里是假突破：放量后迅速收回，注意多头陷阱，等待回踩确认再考虑入场'.repeat(2), points: [{ time: Date.now() - 7200_000, price: 81000 }, { time: Date.now() - 3600_000, price: 82000 }] })
assert.equal(callout.kind, 'callout', 'callouts accept long text')
const styled = await remote.updateChartMark({ sessionId: 's1', id: callout.id, patch: { color: '#ef5f6c' } })
assert.equal(styled.color, '#ef5f6c')
const cleared = await remote.updateChartMark({ sessionId: 's1', id: callout.id, patch: { color: null, hidden: true } })
assert.equal(cleared.color, undefined, 'null clears a style back to default (undo of a restyle)'); assert.equal(cleared.hidden, true)
assert.ok(!('color' in new HyperStore(dir).listChartMarks('s1', 'BTC', null).find((mark) => mark.id === callout.id)), 'the cleared style is gone after restart')
await assert.rejects(remote.drawChartMark({ sessionId: 's1', coin: 'BTC', interval: '1h', kind: 'icon', label: 'skull', points: [{ time: Date.now() - 3600_000, price: 81000 }] }), /图标 label/)
assert.equal((await remote.drawChartMark({ sessionId: 's1', coin: 'BTC', interval: '1h', kind: 'icon', label: 'flag', points: [{ time: Date.now() - 3600_000, price: 81000 }] })).kind, 'icon')
const hs = await chart.execute({ action: 'add', kind: 'headshoulders', label: '日线头肩顶', points: Array.from({ length: 7 }, (_, i) => ({ time: Date.now() - (8 - i) * 3600_000, price: [100, 110, 104, 118, 104, 109, 99][i] })) }, { agent: { id: 's1' } })
assert.match(hs.text, /头肩形态/)
const text = await remote.drawChartMark({ sessionId: 's1', coin: 'BTC', interval: '1h', kind: 'text', label: '这里放量突破，回踩不破 81k 继续看多', points: [{ time: Date.now() - 3600_000, price: 81000 }] })
assert.equal(text.kind, 'text')

// Geometry: bundle the client module with a stub React renderer.
const out = await build({ stdin: { contents: "export * from './src/client/drawing-tools.tsx'; export { renderToStaticMarkup } from 'react-dom/server'; export * as React from 'react'", resolveDir: process.cwd(), loader: 'tsx' },
  bundle: true, format: 'esm', write: false, platform: 'node', jsx: 'automatic', external: ['react', 'react-dom'] })
const file = fileURLToPath(new URL('./.drawing-tools.bundle.mjs', import.meta.url))
writeFileSync(file, out.outputFiles[0].text)
try {
  const { DrawingShape, DRAWING_TOOLS, tableRows, renderToStaticMarkup, React } = await import(file)
  assert.deepEqual(DRAWING_TOOLS.map((tool) => tool.kind).sort(), [...DRAWING_KINDS].sort(), 'every host kind has a menu entry')
  // 1 hour = 10px, price 100 → y=500 (1px per unit, inverted); plot 400×500
  const view = { width: 400, height: 500, project: (time, price) => ({ x: (time - now) / 360_000 + 200, y: 500 - price }), bars: (a, b) => (b - a) / 3600_000, closes: () => [] }
  const render = (kind, points, extra = {}) => renderToStaticMarkup(React.createElement(DrawingShape, { kind, points, view, ...extra }))
  const ray = render('ray', [{ time: now, price: 100 }, { time: now + 3600_000, price: 110 }])
  assert.match(ray, /x1="200" y1="400" x2="400" y2="200"/, 'ray starts at the origin and runs to the plot edge')
  const extended = render('extended', [{ time: now, price: 100 }, { time: now + 3600_000, price: 110 }])
  assert.match(extended, /x1="0" y1="600"|x1="100" y1="500"/, 'extended line reaches back past the first point')
  const fibSvg = render('fib', [{ time: now - 3600_000, price: 100 }, { time: now, price: 200 }])
  for (const level of FIB_LEVELS) assert.ok(fibSvg.includes(`>${level} (`), `fib level ${level}`)
  assert.ok(fibSvg.includes('0.618 (138.200)'), '0.618 sits 61.8% back from the end point')
  const measure = render('measure', [{ time: now - 4 * 3600_000, price: 100 }, { time: now, price: 105 }])
  assert.ok(measure.includes('+5.000 (+5.00%)') && measure.includes('4 根 · 4h'), measure)
  assert.ok(render('channel', [{ time: now - 7200_000, price: 100 }, { time: now, price: 120 }, { time: now - 3600_000, price: 100 }]).includes('<polygon'))
  assert.equal(DRAWING_POINTS.channel, 3)
  const { completePoints, constrainPoints, geometryPatch } = await import(file)
  const long = completePoints('long', [{ time: now, price: 100 }, { time: now + 7200_000, price: 95 }])
  assert.deepEqual(long.map((p) => p.price), [100, 95, 110], 'target defaults to 2R')
  assert.equal(completePoints('long', [{ time: now, price: 100 }, { time: now + 7200_000, price: 105 }]), null, 'a long stop above entry is rejected')
  assert.equal(constrainPoints('long', [long[0], { ...long[1], price: 101 }, long[2]]), null, 'dragging the stop through entry is refused')
  const posSvg = render('long', long, { id: 'p1', interactive: true, anchors: true })
  assert.ok(posSvg.includes('R:R 2.00') && posSvg.includes('+10.00%') && posSvg.includes('-5.00%'), posSvg)
  assert.equal((posSvg.match(/data-anchor=/g) ?? []).length, 3, 'entry, stop and target handles')
  assert.ok(posSvg.includes('dhl-drawing-hit'), 'interactive shapes carry a hit layer')
  assert.deepEqual(geometryPatch('trend', [{ time: 2, price: 1 }, { time: 1, price: 3 }]), { fromTime: 1, fromPrice: 3, toTime: 2, toPrice: 1 }, 'dragging a trend end past its start keeps time order')
  assert.ok(render('text', [{ time: now, price: 100 }], { text: '突破' }).includes('>突破<'))
  // Fibonacci extension projects (B−A)·k from C; time zones follow the Fibonacci sequence; Gann draws 9 rays.
  const ext = render('fibext', [{ time: now - 7200_000, price: 100 }, { time: now - 3600_000, price: 200 }, { time: now, price: 150 }])
  assert.ok(ext.includes('1.618 (311.800)') && ext.includes('0 (150.000)'), ext)
  const zones = render('fibtime', [{ time: now - 3 * 3600_000, price: 100 }, { time: now - 2 * 3600_000, price: 100 }])
  assert.ok(['>0<', '>1<', '>2<', '>3<', '>5<', '>8<', '>13<'].every((label) => zones.includes(label)), zones)
  assert.equal((render('gannfan', [{ time: now - 3600_000, price: 100 }, { time: now, price: 110 }]).match(/×/g) ?? []).length, 9)
  const fork = render('pitchfork', [{ time: now - 3 * 3600_000, price: 100 }, { time: now - 3600_000, price: 120 }, { time: now - 3600_000, price: 90 }])
  assert.equal((fork.match(/<line/g) ?? []).length, 4, 'median, two prongs and the B–C handle')
  const { regressionFit } = await import(file)
  const fit = regressionFit([100, 102, 104, 106].map((price, i) => ({ time: i, price })))
  assert.ok(Math.abs(fit.slope - 2) < 1e-9 && Math.abs(fit.intercept - 100) < 1e-9 && fit.sigma < 1e-9, 'regression recovers a perfect line')
  const regView = { ...view, closes: () => [100, 103, 101, 106, 104, 109].map((price, i) => ({ time: now - (5 - i) * 3600_000, price })) }
  const reg = renderToStaticMarkup(React.createElement(DrawingShape, { kind: 'regression', points: [{ time: now - 5 * 3600_000, price: 100 }, { time: now, price: 109 }], view: regView }))
  assert.ok(reg.includes('<polygon') && reg.includes('σ'), 'regression draws a ±2σ band')
  const { volumeProfile } = await import('../lib/chart-drawings.js')
  const vp = volumeProfile([{ open: 10, high: 12, low: 10, close: 12, volume: 100 }, { open: 11, high: 11.5, low: 10.5, close: 11, volume: 900 }, { open: 19, high: 20, low: 19, close: 19.5, volume: 10 }], { rows: 10 })
  assert.ok(vp.poc >= 10.5 && vp.poc <= 11.5 && vp.val <= 10.5 && vp.vah >= 11.5 && vp.vah < 19, JSON.stringify({ poc: vp.poc, vah: vp.vah, val: vp.val }))
  assert.ok(Math.abs(vp.rows.reduce((sum, row) => sum + row.up + row.down, 0) - 1010) < 1e-6, 'every unit of volume is binned')
  const vpView = { ...view, candles: () => [100, 104, 102, 108].map((price, i) => ({ time: now - (3 - i) * 3600_000, open: price, high: price + 3, low: price - 3, close: price + (i % 2 ? -1 : 1), volume: 10 + i })) }
  const vpSvg = renderToStaticMarkup(React.createElement(DrawingShape, { kind: 'vprofile', points: [{ time: now - 3 * 3600_000, price: 100 }, { time: now, price: 100 }], view: vpView }))
  assert.ok(vpSvg.includes('POC ') && vpSvg.includes('VAH ') && vpSvg.includes('dhl-vprofile-up'), 'the volume profile draws rows, POC and value area')
  assert.ok(vpSvg.includes('K 线估算'), 'the profile says it is estimated from bars')
  const vpHit = renderToStaticMarkup(React.createElement(DrawingShape, { kind: 'vprofile', id: 'vp', interactive: true, points: [{ time: now - 3 * 3600_000, price: 100 }, { time: now, price: 100 }], view: vpView }))
  assert.ok((vpHit.match(/<(path|rect|line|text)\b/g) ?? []).length < 40, 'rows are merged into a few paths, so even with its click layer a profile stays small')
  const partialSvg = renderToStaticMarkup(React.createElement(DrawingShape, { kind: 'vprofile', points: [{ time: now - 3 * 3600_000, price: 100 }, { time: now, price: 100 }], view: { ...vpView, firstTime: now - 3600_000, barMs: 3600_000 } }))
  assert.ok(partialSvg.includes('区间前段历史未加载'), 'a range that starts before the loaded history is flagged')
  assert.equal(volumeProfile([{ open: 100, high: 100, low: 100, close: 100, volume: 5 }]).poc, 100, 'a flat range puts the POC on the traded price')
  assert.equal(volumeProfile([{ open: 1, high: 2, low: 1, close: 2, volume: 0 }]), null, 'no volume, no profile')
  const { drawingGeometry } = await import('../lib/chart-drawings.js')
  assert.deepEqual(drawingGeometry('vprofile', { points: [{ time: now, price: 1 }, { time: now - 3600_000, price: 1 }] }).points.map((point) => point.time), [now - 3600_000, now], 'drawing the range right-to-left is saved in time order')
  const { wrapText } = await import(file)
  const wrapped = wrapText('上升楔形跌破 + 跌回价值区：回踩下轨不过做空，TP1 POC 29,462，TP2 VAL 28,700；4h 收回下轨上方即作废', 300)
  assert.ok(wrapped.length >= 2 && wrapped.join('') .replace(/\s/g, '') === '上升楔形跌破+跌回价值区：回踩下轨不过做空，TP1POC29,462，TP2VAL28,700；4h收回下轨上方即作废', JSON.stringify(wrapped))
  assert.deepEqual(wrapText('a\nb', 300), ['a', 'b'], 'explicit newlines are kept')
  const { drawingStyle } = await import('../lib/chart-drawings.js')
  assert.deepEqual(drawingStyle({ kind: 'vprofile', rows: 96, valueArea: 0.68 }), { rows: 96, valueArea: 0.68 })
  assert.throws(() => drawingStyle({ kind: 'vprofile', rows: 3 }), /6-200/)
  assert.throws(() => drawingStyle({ kind: 'vprofile', valueArea: 0.99 }), /0.5-0.95/)
  assert.throws(() => drawingStyle({ kind: 'trend', rows: 48 }), /只适用于/)
  assert.deepEqual(drawingStyle({ kind: 'fib', levels: [1, 0.5, 0, 0.5, 1.618] }).levels, [0, 0.5, 1, 1.618], 'fib levels are de-duplicated and sorted')
  assert.throws(() => drawingStyle({ kind: 'fib', levels: [] }), /1-24/)
  assert.throws(() => drawingStyle({ kind: 'fib', levels: [0, 'x'] }), /1-24/)
  assert.throws(() => drawingStyle({ kind: 'trend', levels: [0, 1] }), /只适用于/)
  assert.deepEqual(drawingStyle({ kind: 'rect', visibleIntervals: ['4h', '4h', '1d'], fillOpacity: 0.32 }), { visibleIntervals: ['4h', '1d'], fillOpacity: 0.32 })
  assert.throws(() => drawingStyle({ kind: 'rect', visibleIntervals: ['7m'] }), /visibleIntervals/)
  assert.throws(() => drawingStyle({ kind: 'trend', fillOpacity: 0.2 }), /只适用于/)
  assert.throws(() => drawingStyle({ kind: 'rect', fillOpacity: 0.9 }), /0-0.6/)
  assert.deepEqual(drawingStyle({ kind: 'text', fontSize: 24 }), { fontSize: 24 })
  assert.throws(() => drawingStyle({ kind: 'trend', fontSize: 14 }), /只适用于/)
  assert.deepEqual(drawingStyle({ kind: 'callout', bold: true, italic: false }), { bold: true, italic: false })
  assert.throws(() => drawingStyle({ kind: 'trend', bold: true }), /只适用于/)
  assert.deepEqual(drawingStyle({ kind: 'trend', extendRight: true }), { extendRight: true })
  assert.throws(() => drawingStyle({ kind: 'rect', extendLeft: true }), /只适用于 trend/)
  const seg = { kind: 'trend', fromTime: 1000, fromPrice: 100, toTime: 2000, toPrice: 200 }
  assert.equal(linePriceAt(seg, 3000), null)
  assert.equal(linePriceAt({ ...seg, extendRight: true }, 3000), 300)
  assert.equal(linePriceAt({ ...seg, extendRight: true }, 0), null)
  assert.equal(linePriceAt({ ...seg, extendLeft: true }, 0), 0)
  const x2 = (svg) => Number(/<line[^>]*x2="([\d.-]+)"/.exec(svg)?.[1])
  const pts = [{ time: now - 7200_000, price: 100 }, { time: now - 3600_000, price: 105 }]
  assert.ok(x2(render('trend', pts, { extendRight: true })) > x2(render('trend', pts)), 'extendRight draws past the second anchor')

  // 0.5.0 tools: every new kind renders from its full anchor count.
  const fresh = { flatchannel: 3, disjoint: 3, fibfan: 2, fibcircles: 2, fibarcs: 2, fibwedge: 3, fibtrendtime: 3, cypher: 5, threedrives: 6, tripattern: 4, elliotttri: 6, elliottwxy: 4, elliottwxyxz: 6, cycles: 2, sine: 2, ellipse: 2, rotrect: 3, arc: 3, curve: 3, note: 1, pricenote: 2, signpost: 1, forecast: 2 }
  for (const [kind, n] of Object.entries(fresh)) {
    const anchors = Array.from({ length: n }, (_, i) => ({ time: now - (n - i) * 3600_000, price: 100 + (i % 2 ? 40 : 0) + i * 5 }))
    assert.equal(drawingGeometry(kind, { points: anchors }, now).points.length, n, `${kind} validates`)
    assert.ok(render(kind, anchors, { text: '说明' }).includes('<g'), `${kind} renders`)
  }
  // Flat channel: the second side is horizontal at the third point's price (y = 500 - 90 = 410).
  assert.ok(render('flatchannel', [{ time: now - 7200_000, price: 100 }, { time: now, price: 120 }, { time: now - 3600_000, price: 90 }]).includes('x1="180" y1="410" x2="200" y2="410"'), 'flat side')
  // Disjoint: the second side mirrors the slope from the third point.
  assert.ok(render('disjoint', [{ time: now - 7200_000, price: 100 }, { time: now, price: 120 }, { time: now - 7200_000, price: 140 }]).includes('x1="180" y1="360" x2="200" y2="380"'), 'mirrored side')
  // Rotated rectangle: a horizontal side and a third point 30px below gives a 30px-wide box.
  assert.ok(render('rotrect', [{ time: now - 7200_000, price: 100 }, { time: now, price: 100 }, { time: now - 3600_000, price: 70 }]).includes('points="180,400 200,400 200,430 180,430"'), 'rotated rectangle width')
  // Arc passes through the third point: control = 2·mid − (start+end)/2.
  assert.ok(render('arc', [{ time: now - 7200_000, price: 100 }, { time: now, price: 100 }, { time: now - 3600_000, price: 120 }]).includes('M180 400Q190 360 200 400'), 'arc control point')
  // Cypher: B at 0.618 of XA, C at 1.272 of XA, D retraces 0.786 of XC.
  const cy = render('cypher', [[0, 100], [1, 200], [2, 138.2], [3, 227.2], [4, 227.2 - 0.786 * 127.2]].map(([i, price]) => ({ time: now + i * 3600_000, price })))
  assert.ok(cy.includes('>0.618<') && cy.includes('>1.272<') && cy.includes('>0.786<'), 'cypher ratios')
  // Fib circles: radius 1 is the distance between the points (30px), so 0.5 is 15px.
  assert.ok(render('fibcircles', [{ time: now, price: 100 }, { time: now, price: 130 }]).includes('r="15"'), 'fib circle 0.5')
  // Cycles repeat the period across the plot; a sine runs the full width.
  assert.ok((render('cycles', [{ time: now - 7200_000, price: 100 }, { time: now - 3600_000, price: 100 }]).match(/<line/g) ?? []).length >= 3, 'cyclic lines repeat')
  // Scrolled 1000 periods past the anchor, the cycles still fill the plot (40 lines at 10px each).
  assert.ok((render('cycles', [{ time: now - 1000 * 3600_000, price: 100 }, { time: now - 999 * 3600_000, price: 100 }]).match(/<line/g) ?? []).length >= 40, 'cycles far from the anchor')
  assert.ok(render('sine', [{ time: now - 3600_000, price: 120 }, { time: now, price: 100 }]).includes('points="0.0,'), 'sine spans the plot')
  // Text kinds take free text and a font size.
  assert.ok(render('note', [{ time: now, price: 100 }], { text: '等回踩' }).includes('>等回踩<') && render('signpost', [{ time: now, price: 100 }], { text: '财报' }).includes('>财报<'), 'note and signpost text')
  assert.ok(render('pricenote', [{ time: now, price: 100 }, { time: now + 3600_000, price: 120 }], { text: '目标' }).includes('100.000 · 目标'), 'price note shows the anchored price')
  // Anchored VWAP: HLC3 × volume from the anchor to the last bar.
  const vbars = [[0, 10, 8, 9, 1], [1, 12, 10, 11, 3]].map(([i, high, low, close, volume]) => ({ time: now + i * 3600_000, open: close, high, low, close, volume }))
  const vview = { ...view, candles: (from) => vbars.filter((bar) => bar.time >= from) }
  const vwap = renderToStaticMarkup(React.createElement(DrawingShape, { kind: 'avwap', points: [{ time: now, price: 9 }], view: vview }))
  assert.ok(vwap.includes('VWAP 10.500'), `VWAP = (9·1 + 11·3) / 4 = 10.5: ${vwap}`)
  assert.ok(renderToStaticMarkup(React.createElement(DrawingShape, { kind: 'avwap', points: [{ time: now + 9 * 3600_000, price: 9 }], view: vview })).includes('暂无成交量'), 'no bars after the anchor')
  const early = renderToStaticMarkup(React.createElement(DrawingShape, { kind: 'avwap', points: [{ time: now - 3 * 3600_000, price: 9 }], view: { ...vview, firstTime: now, barMs: 3600_000 } }))
  assert.ok(early.includes('暂不完整'), 'an anchor before the loaded history is flagged')
  // 0.5.1: highlighter, path / polyline, pin, fib spiral, bars pattern.
  assert.equal(drawingGeometry('path', { points: [pt(5, 100), pt(4, 110), pt(3, 105)] }, now).points.length, 3)
  assert.throws(() => drawingGeometry('path', { points: [pt(5, 100)] }, now), /2-50/)
  assert.throws(() => drawingGeometry('polyline', { points: Array.from({ length: 51 }, (_, i) => pt(60 - i, 100)) }, now), /2-50/)
  assert.equal(drawingGeometry('highlighter', { points: Array.from({ length: 30 }, (_, i) => pt(30 - i, 100 + i)) }, now).points.length, 30)
  assert.throws(() => drawingGeometry('barspattern', { points: [pt(2, 100), pt(4, 100), pt(1, 100)] }, now), /晚于起点/)
  const pathPts = [[0, 100], [1, 120], [2, 110]].map(([i, price]) => ({ time: now + i * 3600_000, price }))
  assert.ok(render('path', pathPts).includes('dhl-arrow-head') && !render('polyline', pathPts).includes('dhl-arrow-head'), 'path ends in an arrow, polyline does not')
  assert.ok(render('highlighter', pathPts).includes('dhl-highlighter'), 'highlighter stroke')
  assert.ok(render('pin', [{ time: now, price: 100 }], { text: '加仓点' }).includes('>加仓点<'), 'pin text')
  const spiral = render('fibspiral', [{ time: now, price: 100 }, { time: now + 3600_000, price: 100 }])
  assert.ok(spiral.includes('210.0,400.0'), 'the spiral passes through the second point (radius 10px at angle 0)')
  // Bars pattern: two source bars pasted 5 hours later, first open moved to 200.
  const src = [[0, 105, 95, 100, 102], [1, 110, 99, 102, 108]].map(([i, high, low, open, close]) => ({ time: now + i * 3600_000, open, high, low, close, volume: 1 }))
  const bview = { ...view, candles: (from, to) => src.filter((bar) => bar.time >= from && bar.time <= to) }
  const copy = renderToStaticMarkup(React.createElement(DrawingShape, { kind: 'barspattern', points: [{ time: now, price: 100 }, { time: now + 3600_000, price: 100 }, { time: now + 5 * 3600_000, price: 200 }], view: bview }))
  assert.ok(copy.includes('data-bars="2"') && copy.includes('M250.0 295.0V305.0'), `first copied bar: x = 200 + 50, high 105 → 205 (y 295), low 95 → 195 (y 305): ${copy.slice(0, 300)}`)
  // 0.5.2: projection (sector) and ghost feed.
  const sector = render('projection', [{ time: now, price: 100 }, { time: now + 3600_000, price: 100 }, { time: now + 3600_000, price: 110 }])
  assert.ok(sector.includes('M200 400L210 400A10 10 0 0 0') && sector.includes('(+10.00%)'), `sector from the origin with the estimated change: ${sector.slice(0, 260)}`)
  assert.throws(() => drawingGeometry('projection', { points: [pt(2, 100), pt(3, 100), pt(1, 110)] }, now), /未来方向/)
  assert.throws(() => drawingGeometry('ghostfeed', { points: [pt(2, 100), pt(3, 110)] }, now), /从左到右/)
  const gbars = Array.from({ length: 20 }, (_, i) => ({ time: now - (20 - i) * 3600_000, open: 100, high: 104, low: 96, close: 100, volume: 1 }))
  const gview = { ...view, barMs: 3600_000, candles: (from, to) => gbars.filter((bar) => bar.time >= from && bar.time <= to) }
  const ghost = renderToStaticMarkup(React.createElement(DrawingShape, { kind: 'ghostfeed', points: [{ time: now, price: 100 }, { time: now + 4 * 3600_000, price: 120 }, { time: now + 6 * 3600_000, price: 110 }], view: gview }))
  // 1.5 + 1.5 bars: still one candle per bar slot across the whole path (3), not reset per segment.
  const ghostHalf = renderToStaticMarkup(React.createElement(DrawingShape, { kind: 'ghostfeed', points: [{ time: now, price: 100 }, { time: now + 1.5 * 3600_000, price: 110 }, { time: now + 3 * 3600_000, price: 105 }], view: gview }))
  assert.ok(ghostHalf.includes('data-candles="3"'), 'ghost feed samples one global bar grid')
  const ghostLong = renderToStaticMarkup(React.createElement(DrawingShape, { kind: 'ghostfeed', points: [{ time: now, price: 100 }, { time: now + 1000 * 3600_000, price: 120 }, { time: now + 3000 * 3600_000, price: 110 }], view: gview }))
  assert.ok(ghostLong.includes('data-candles="2000"'), 'capped at 2000 candles')
  assert.ok(ghost.includes('data-candles="6"') && /dhl-ghost-up" d="M/.test(ghost) && /dhl-ghost-down" d="M/.test(ghost), `one candle per bar along the path, up then down: ${ghost.slice(0, 200)}`)
  // 0.5.3: screen-pinned anchored text and tables.
  assert.deepEqual(drawingStyle({ kind: 'anchoredtext', screenX: 0.25, screenY: 0.5 }), { screenX: 0.25, screenY: 0.5 })
  assert.throws(() => drawingStyle({ kind: 'text', screenX: 0.2, screenY: 0.2 }), /只适用于/)
  assert.throws(() => drawingStyle({ kind: 'table', screenX: 0.2 }), /同时提供/)
  assert.throws(() => drawingStyle({ kind: 'table', screenX: 0.2, screenY: null }), /同时提供/)
  assert.throws(() => drawingStyle({ kind: 'table', screenX: 1.2, screenY: 0.1 }), /0-1/)
  // Pinned: placed at 25% / 50% of the 400×500 plot whatever its time and price.
  const pinnedText = render('anchoredtext', [{ time: now - 999 * 3600_000, price: 1 }], { text: '计划', screenX: 0.25, screenY: 0.5 })
  assert.ok(pinnedText.includes('x="100" y="230"') && pinnedText.includes('>计划<'), `anchored text sits on the screen spot: ${pinnedText.slice(0, 200)}`)
  assert.deepEqual(tableRows('品种|方向|止损; BTC | 多 | 81000\nETH|空|'), [['品种', '方向', '止损'], ['BTC', '多', '81000'], ['ETH', '空', '']])
  const tableSvg = render('table', [{ time: now, price: 100 }], { text: '品种|方向;BTC|多;ETH|空' })
  assert.ok(tableSvg.includes('data-rows="3"') && tableSvg.includes('data-cols="2"') && tableSvg.includes('>ETH<'), 'table grid')
  // Gann square fixed: square from the origin (50px side → 10px units), grid, arcs within the square, 3 fans.
  const gf = render('gannfixed', [{ time: now, price: 100 }, { time: now + 5 * 3600_000, price: 120 }])
  assert.ok(gf.includes('width="50" height="50"') && (gf.match(/dhl-gann-grid/g) ?? []).length === 12 && (gf.match(/dhl-fib-ring/g) ?? []).length === 10 && gf.includes('>2×1<') && gf.includes('>1×2<'), `gann fixed: ${gf.slice(0, 160)}`)
  // Each quadrant: the unit arc (radius 10px) starts on the horizontal edge and ends on the vertical one, around the origin (200, 400).
  for (const [dh, dp, sweep, sx, sy] of [[5, 20, 0, 1, -1], [5, -20, 1, 1, 1], [-5, 20, 1, -1, -1], [-5, -20, 0, -1, 1]]) {
    const svg = render('gannfixed', [{ time: now, price: 100 }, { time: now + dh * 3600_000, price: 100 + dp }])
    const first = /class="dhl-fib-ring" d="M([\d.-]+) ([\d.-]+)A10 10 0 0 (\d) ([\d.-]+) ([\d.-]+)"/.exec(svg)
    assert.ok(first && Number(first[1]) === 200 + 10 * sx && Number(first[2]) === 400 && Number(first[3]) === sweep && Number(first[4]) === 200 && Number(first[5]) === 400 + 10 * sy, `gann fixed quadrant ${dh},${dp}: ${first?.[0]}`)
  }
  const forkPts = [{ time: now - 7200_000, price: 100 }, { time: now - 3600_000, price: 140 }, { time: now, price: 110 }]
  assert.equal(render('insidepitchfork', forkPts), render('modschiff', forkPts), 'inside pitchfork uses the documented midpoint origin')
  const forecast = render('forecast', [{ time: now - 3 * 3600_000, price: 100 }, { time: now, price: 110 }])
  assert.ok(forecast.includes('+10.00%') && forecast.includes('3 根'), 'forecast change and bars')
  assert.ok(render('text', [{ time: now, price: 100 }], { text: 'x', bold: true, italic: true }).includes('--dhl-font-weight:700'), 'bold reaches the text')
  const small = render('text', [{ time: now, price: 100 }], { text: '突破' }), big = render('text', [{ time: now, price: 100 }], { text: '突破', fontSize: 24 })
  const boxWidth = (svg) => Number(/dhl-text-box[^>]*width="([\d.]+)"/.exec(svg)?.[1])
  assert.ok(Math.abs(boxWidth(big) / boxWidth(small) - 2) < 1e-6 && big.includes('--dhl-font-size:24px'), 'a 24px text box is twice the 12px one')
  assert.ok(render('rect', [{ time: now - 3600_000, price: 100 }, { time: now, price: 110 }], { fillOpacity: 0 }).includes('--dhl-fill-opacity:0'), 'fill opacity reaches the shape')
  const customFib = render('fib', [{ time: now - 3600_000, price: 100 }, { time: now, price: 200 }], { levels: [0, 0.5, 1.618] })
  assert.ok(customFib.includes('1.618 (') && !customFib.includes('0.236'), 'a fib draws its own levels')
  const bars = Array.from({ length: 40 }, (_, i) => ({ open: 100 + (i % 7), high: 103 + (i % 7), low: 98 + (i % 5), close: 101 + (i % 6), volume: 10 + (i % 9) }))
  const fine = volumeProfile(bars, { rows: 96 }), coarse = volumeProfile(bars, { rows: 12 }), wide = volumeProfile(bars, { valueArea: 0.9 })
  assert.ok(fine.rows.length === 96 && coarse.rows.length === 12 && wide.vah - wide.val >= volumeProfile(bars).vah - volumeProfile(bars).val, 'rows and value-area share change the profile')
  assert.ok(render('arrow', [{ time: now - 3600_000, price: 100 }, { time: now, price: 110 }]).includes('dhl-arrow-head'))
  assert.ok(render('callout', [{ time: now - 3600_000, price: 100 }, { time: now, price: 110 }], { text: '假突破' }).includes('>假突破<'))
  assert.ok(render('circle', [{ time: now, price: 100 }, { time: now + 3600_000, price: 100 }]).includes('r="10"'))
  assert.ok(render('trendangle', [{ time: now, price: 100 }, { time: now + 3600_000, price: 110 }]).includes('45.0°'), 'a 10px/10px rise is 45°')
  const info = render('infoline', [{ time: now - 2 * 3600_000, price: 100 }, { time: now, price: 104 }])
  assert.ok(info.includes('+4.000 (+4.00%)') && info.includes('2 根') && info.includes('角度'), info)
  assert.ok(render('pricerange', [{ time: now, price: 100 }, { time: now + 3600_000, price: 95 }]).includes('-5.000 (-5.00%)'))
  assert.ok(render('daterange', [{ time: now, price: 100 }, { time: now + 3 * 3600_000, price: 100 }]).includes('3 根 · 3h'))
  assert.ok(render('crossline', [{ time: now, price: 100 }]).match(/<line/g).length >= 2)
  assert.ok(render('pricelabel', [{ time: now, price: 81234.5 }]).includes('81,234.5'))
  // Advanced: harmonic ratios, waves, necklines, Gann box levels, Schiff handles, icons.
  const H = 3600_000
  const xabcd = render('xabcd', [[0, 100], [1, 200], [2, 138.2], [3, 176.4], [4, 121.4]].map(([i, price]) => ({ time: now + i * H, price })))
  assert.ok(xabcd.includes('>0.618<') && xabcd.includes('>0.618<') && xabcd.includes('>X<') && xabcd.includes('>D<'), 'XABCD shows AB/XA = 0.618 and labels')
  assert.ok(xabcd.includes('>0.786<'), 'XD/XA = 0.786 for a Gartley-style D')
  const wave5 = render('elliott', [100, 110, 104, 125, 118, 132].map((price, i) => ({ time: now + i * H, price })))
  assert.ok(['(1)', '(3)', '(5)'].every((label) => wave5.includes(`>${label}<`)), 'impulse wave labels')
  assert.ok(render('elliottabc', [130, 115, 122, 105].map((price, i) => ({ time: now + i * H, price }))).includes('>(C)<'))
  assert.ok(render('abcd', [100, 120, 107.64, 128].map((price, i) => ({ time: now + i * H, price }))).includes('>0.618<'), 'ABCD BC/AB')
  const hsSvg = render('headshoulders', [100, 110, 104, 118, 104, 109, 99].map((price, i) => ({ time: now + i * H, price })))
  assert.ok(hsSvg.includes('dhl-neckline') && hsSvg.includes('>头<') && hsSvg.includes('>左肩<'), 'neckline and shoulder labels')
  const box = render('gannbox', [{ time: now, price: 100 }, { time: now + 4 * H, price: 140 }])
  assert.ok(['0.25', '0.382', '0.5', '0.618', '0.75'].every((level) => box.includes(`>${level}<`)), 'Gann box levels on both axes')
  assert.ok(render('gannsquare', [{ time: now, price: 100 }, { time: now + 4 * H, price: 140 }]).match(/<line/g).length >= 10)
  const schiff = render('schiff', [{ time: now, price: 100 }, { time: now + 2 * H, price: 140 }, { time: now + 2 * H, price: 120 }])
  assert.ok(schiff.includes('x1="200" y1="400" x2="200" y2="380"'), 'Schiff handle starts at the A–B price midpoint (y 380 = price 120)')
  assert.ok(render('modschiff', [{ time: now, price: 100 }, { time: now + 2 * H, price: 140 }, { time: now + 2 * H, price: 120 }]).includes('x2="210" y2="380"'), 'modified Schiff starts at the A–B midpoint')
  assert.ok(render('icon', [{ time: now, price: 100 }], { label: 'flag' }).includes('dhl-icon-bg'))
  const { ICONS } = await import(file)
  assert.ok(render('icon', [{ time: now, price: 100 }], { text: 'flag' }).includes(ICONS.flag[2]), 'a user icon renders its own glyph (not the fallback star)')
  assert.ok(render('icon', [{ time: now, price: 100 }], { text: 'emoji:🚀' }).includes('>🚀<'), 'stickers render their emoji')
  assert.ok(render('brush', Array.from({ length: 30 }, (_, i) => ({ time: now + i * 600_000, price: 100 + i }))).includes('<polyline'))
} finally { rmSync(file, { force: true }) }
console.log('画线工具（78 种）校验、编辑与锁定、agent 路径、头寸与 SVG 几何通过')
