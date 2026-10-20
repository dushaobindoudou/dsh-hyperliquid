/**
 * Static contract check: every `hyper.*` method the web client calls over
 * the wire must be declared as a @Remote method in lib/remote.js.
 *
 * Why static: a missing marker fails SILENTLY at runtime — the client
 * catches the error and the feature just quietly does nothing (this is
 * exactly how the `deskState` bug shipped: the method existed, the marker
 * didn't, and UI→host desk-focus sync died without a sound).
 *
 * Run: node test/markers.test.mjs   (exit 0 = contract holds)
 * @module test/markers.test.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const client = readFileSync(join(root, 'client.js'), 'utf8')
const remote = readFileSync(join(root, 'lib/remote.js'), 'utf8')
const data = readFileSync(join(root, 'src/client/data.ts'), 'utf8')

let fail = 0
function check(label, cond, extra) {
  console.log(cond ? 'PASS' : 'FAIL', label, cond ? '' : JSON.stringify(extra ?? {}))
  if (!cond) fail += 1
}

// The marker list: the `for (const m of [...])` block at the bottom of remote.js.
const markerBlock = remote.match(/for \(const m of \[([\s\S]*?)\]\)/)
if (!markerBlock) {
  console.error('FAIL marker 声明块未在 lib/remote.js 中找到')
  process.exit(1)
}
const markers = [...markerBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1])

// Every method the client dials over the wire: hyperCall('method', …).
// esbuild normalizes string literals to double quotes in the artifact,
// while the TSX source uses single quotes — accept both.
const called = [...new Set([...client.matchAll(/hyperCall\((['"])([A-Za-z0-9_]+)\1/g)].map((m) => m[2]))]

// 1. Client-called methods must be markers (the deskState regression).
const missing = called.filter((m) => !markers.includes(m))
check('客户端调用的远端方法全部已注册 marker', missing.length === 0, { called, missing })

// 2. Every marker must have an implementation in HyperRemote.
const unimplemented = markers.filter((m) => !new RegExp(`async\\s+${m}\\s*\\(`).test(remote))
check('每个 marker 都有对应实现', unimplemented.length === 0, { unimplemented })

// 3. Markers the client never dials are informational (host/tool-side only).
const unused = markers.filter((m) => !called.includes(m))
console.log('INFO 仅宿主/工具侧使用的 marker:', unused.join(', ') || '（无）')
check('交易执行方法不会暴露给浏览器 RPC',
  ['placeOrder', 'cancelOrder', 'setLeverage', 'orders'].every((m) => !markers.includes(m)))
check('live 订单事件按状态前缀刷新账户', data.includes("startsWith('live.order.')"))

console.log(fail ? `${fail} check(s) FAILED` : 'marker 契约全部通过')
process.exit(fail ? 1 : 0)
