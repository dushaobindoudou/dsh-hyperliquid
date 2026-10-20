// Root cause of "a chart click sometimes does nothing": a live candle arriving between press and
// release shifts the visible logical range by one slot. The old rule treated any range change as a
// pan and dropped the click; the guard keeps it unless the user actually zoomed or panned.
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const out = await build({ entryPoints: ['src/client/click-guard.ts'], bundle: true, format: 'esm', write: false, platform: 'node' })
const { pressStillAClick, legacyPressStillAClick, LIVE_SHIFT_BARS } = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
const legacyStillAClick = legacyPressStillAClick

const press = { from: 180.4, to: 300.4 }
const newBarArrived = { from: 181.4, to: 301.4 } // same width, view follows the latest bar by one slot
assert.equal(legacyStillAClick(press, newBarArrived), false, 'reproduces the bug: the old rule dropped this click')
assert.equal(pressStillAClick(press, newBarArrived), true, 'the click survives a live bar arriving mid-click')
assert.equal(pressStillAClick(press, { from: 180.4 + LIVE_SHIFT_BARS + 1, to: 300.4 + LIVE_SHIFT_BARS + 1 }), false, 'a real pan still cancels the click')
assert.equal(pressStillAClick(press, { from: 190, to: 290 }), false, 'a zoom still cancels the click')
assert.equal(pressStillAClick(press, press), true)
assert.equal(pressStillAClick(null, newBarArrived), true)
globalThis.__dhlLegacyClickGuard = true
assert.equal(pressStillAClick(press, newBarArrived), false, 'the test switch restores the old rule (used by the real-host smoke)')
delete globalThis.__dhlLegacyClickGuard
console.log('点击判定：新 K 线在点击过程中到达时点击仍然生效（复现旧规则丢点击），平移与缩放照常取消')
