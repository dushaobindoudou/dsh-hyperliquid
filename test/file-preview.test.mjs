/**
 * File-open fallback test — runs the REAL build artifact (client.js) in Node.
 *
 * DSH's conversation opens a file link with `sidebarRight.openResource(address)`, which
 * needs a mounted rightbar session surface. The trading desk replaces the main area, so
 * that surface is absent and the shipped call throws `sidebarRight: no session surface is
 * mounted` — clicking a file in the desk chat did nothing. The desk keeps the shipped path
 * first and falls back to its own preview only when that path cannot place the file.
 *
 * Covers:
 *   1) `sidebarRight` is a declared dependency (the service must be ready at apply)
 *   2) a `dsh-resource://file/…` link that the shipped sidebar cannot open does not throw
 *   3) a non-file address keeps the shipped throw
 *   4) disposing the effect restores the shipped `openResource`
 *
 * Run: node test/file-preview.test.mjs   (exit 0 = all checks pass)
 * @module test/file-preview.test.mjs
 */

import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const code = readFileSync(join(root, 'client.js'), 'utf8')

let fail = 0
function check(label, cond, extra) {
  console.log(cond ? 'PASS' : 'FAIL', label, cond ? '' : JSON.stringify(extra ?? {}))
  if (!cond) fail += 1
}

const ReactStub = {
  createElement(type, props, ...raw) {
    return { type, props: props ?? {}, children: raw.flat() }
  },
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useRef: (init) => ({ current: init }),
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  memo: (component) => component,
  useSyncExternalStore: (_sub, snapshot) => snapshot(),
}

let plugin = null
const sandbox = {
  console,
  navigator: { userAgent: 'node-integration', userAgentData: undefined },
  window: {
    __ModuleLoader__: {
      load(opts) {
        const requireStub = (id) => id === 'react' ? ReactStub
          : id === '@deepseek-ai/dsh-client-ui-primitives' ? { Modal: () => null, Button: () => null, Input: () => null, DisclosureRow: () => null }
            : undefined
        plugin = opts.factory(requireStub)
      },
    },
  },
  document: {
    createElement: () => ({ setAttribute() {}, remove() {}, textContent: '' }),
    head: { appendChild() {} },
  },
}
vm.createContext(sandbox)
vm.runInContext(code, sandbox, { filename: 'client.js' })

check('产物产出插件对象', plugin !== null && typeof plugin.apply === 'function')
check('inject 声明包含 sidebarRight', Array.isArray(plugin?.inject) && plugin.inject.includes('sidebarRight'), plugin?.inject)

// ── apply with a sidebarRight whose shipped path throws, like the desk ──
const SESSION_ERROR = 'sidebarRight: no session surface is mounted'
const shipped = {
  calls: 0,
  openResource(address) {
    shipped.calls += 1
    throw new Error(SESSION_ERROR)
  },
}
const disposers = []
const ctx = {
  get(name) {
    return {
      connection: { remote: { hyper: new Proxy({}, { get: () => async () => ({}) }) } },
      slots: { register() { return () => {} }, inject(_key, cb) { return cb() } },
      locale: { register: () => () => {}, bind: () => (k, fb) => fb },
      layout: { selectPanel() {} },
      sessions: { retain: () => ({ ready: Promise.resolve(), release() {}, binding: { session: { prompt: async () => {} } } }), list: { get: () => ({ byId: {} }), subscribe: () => () => {} } },
      uiConversation: {},
      uiWorkspace: { openSession() {} },
    }[name] ?? null
  },
  effect(fn) { const d = fn(); const dispose = typeof d === 'function' ? d : () => {}; disposers.push(dispose); return dispose },
  logger: { warn() {} },
}
ctx.sidebarRight = shipped
plugin.apply(ctx)

const address = 'dsh-resource://file/session/sess-1/docs%2Farchitecture%20notes.md'
let threw = null
try {
  const result = ctx.sidebarRight.openResource(address)
  check('文件链接不抛错（落到交易台预览）', result === undefined)
} catch (error) {
  threw = error
}
check('文件链接不再抛 sidebarRight 错误', threw === null, threw?.message)
check('仍先尝试了 shipped 路径', shipped.calls === 1)

let nonFileThrew = null
try {
  ctx.sidebarRight.openResource('dsh-resource://absolute/tmp/x')
} catch (error) {
  nonFileThrew = error
}
check('非文件地址仍按 shipped 抛错', nonFileThrew !== null && nonFileThrew.message === SESSION_ERROR, nonFileThrew?.message)

// ── the fallback is disposable ─────────────────────────────────────────
for (const dispose of disposers) dispose()
let restoredThrew = null
try {
  ctx.sidebarRight.openResource(address)
} catch (error) {
  restoredThrew = error
}
check('dispose 后还原 shipped openResource', restoredThrew !== null && restoredThrew.message === SESSION_ERROR, restoredThrew?.message)

console.log(fail === 0 ? 'file-preview 全部通过' : `file-preview 失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
