/**
 * Client integration test — runs the REAL build artifact (client.js) in
 * Node with stubbed shell globals, following dsh-freeroute's harness
 * pattern: no browser needed, but the exercised code is exactly what the
 * dsh web shell loads.
 *
 * Covers:
 *   1) plugin object shape (inject list + apply)
 *   2) apply registers the main panel + sidebar panellist entry, injects styles
 *   3) the main panel renders its full component tree (all columns, chart box,
 *      banner, positions table) with stubbed React hooks
 *   4) artifact hygiene: no base64-vendored blobs, lightweight-charts really
 *      bundled, react external, loader wrapper present
 *
 * Run: node test/client-integration.mjs   (exit 0 = all checks pass)
 * @module test/client-integration.mjs
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

// ── React stub (freeroute pattern): elements are plain objects, hooks are inert ──
const ReactStub = {
  createElement(type, props, ...raw) {
    const children = []
    const flatten = (list) => {
      for (const c of list) {
        if (Array.isArray(c)) flatten(c)
        else if (c !== null && c !== undefined && c !== false) children.push(c)
      }
    }
    flatten(raw)
    return { type, props: props ?? {}, children }
  },
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useRef: (init) => ({ current: init }),
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  memo: (component) => component,
  useSyncExternalStore: (_sub, snapshot) => snapshot(),
}

// ── load the artifact inside a vm with stubbed window/document ──────────
let plugin = null
const styleEls = []
const sandbox = {
  console,
  // The bundled lightweight-charts touches navigator at module scope
  // (Chromium detection); a real browser always has it.
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
    head: { appendChild(el) { styleEls.push(el) } },
  },
}
vm.createContext(sandbox)
vm.runInContext(code, sandbox, { filename: 'client.js' })

// ── 1) plugin object shape ──────────────────────────────────────────────
check('产物产出插件对象', plugin !== null && typeof plugin.apply === 'function')
check('inject 声明完整', JSON.stringify(plugin?.inject) === JSON.stringify(
  ['connection', 'slots', 'locale', 'theme', 'layout', 'sessions', 'workspaces', 'uiConversation', 'uiWorkspace'],
), plugin?.inject)

// ── 2) apply registers slots + styles ──────────────────────────────────
const captured = {}
const slots = {
  register(options, component) { captured[options.key ?? options.name] = component; return () => {} },
  inject(_key, cb) { return cb() },
}
const sessionsSvc = {
  create: async () => 'sess-x',
  retain: () => ({ ready: Promise.resolve(), release() {}, binding: { session: { prompt: async () => {} } } }),
  list: { get: () => ({ byId: {} }), subscribe: () => () => {} },
}
const ctx = {
  get(name) {
    return {
      connection: { remote: { hyper: new Proxy({}, { get: () => async () => ({}) }) } },
      slots,
      locale: { register: () => () => {}, bind: () => (k, fb) => fb },
      layout: { selectPanel() {} },
      sessions: sessionsSvc,
      uiConversation: {},
      uiWorkspace: { openSession() {} },
    }[name] ?? null
  },
  effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
  logger: { warn() {} },
}
plugin.apply(ctx)
check('注册 main 三栏面板', typeof captured['dsh-hyperliquid'] === 'function')
check('注册 sidebar 入口图标', typeof captured['sidebar.panellist'] === 'function')
for (const tool of ['hyper_context', 'hyper_market', 'hyper_chart', 'hyper_account', 'hyper_decide', 'hyper_order', 'hyper_session']) {
  check(`注册 ${tool} 工具卡片`, typeof captured[tool] === 'function')
}
check('注册审批订单详情', typeof captured['conversation.approval.detail'] === 'function')
check('注入插件样式', styleEls.length === 1 && String(styleEls[0].textContent).includes('.dhl-root'))

// ── 3) render the full component tree ──────────────────────────────────
// The React stub does not invoke function components, so walk() drives
// them manually: element → component(props) → element tree.
function walk(node, out) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return }
  if (typeof node.type === 'function') { walk(node.type(node.props ?? {}), out); return }
  if (node.props) {
    if (typeof node.props.className === 'string') out.classes.push(node.props.className)
    for (const c of node.children ?? []) walk(c, out)
  }
}
const tree = ReactStub.createElement(captured['dsh-hyperliquid'], {
  SessionProvider: ({ children }) => children,
  renderFactorySlot: () => ReactStub.createElement('div', null, 'native conversation stub'),
})
const seen = { classes: [] }
walk(tree, seen)
const cls = seen.classes.join(' ')
for (const need of ['dhl-root', 'dhl-topbar', 'dhl-col-sessions', 'dhl-col-desk', 'dhl-col-chat', 'dhl-market-strip', 'dhl-chartbox', 'dhl-tape', 'dhl-banner']) {
  check(`组件树包含 ${need}`, cls.includes(need))
}
check('入口图标组件可渲染', typeof captured['sidebar.panellist'] === 'function'
  && ReactStub.createElement(captured['sidebar.panellist'], { size: 18 }) !== null)

// ── 4) artifact hygiene ────────────────────────────────────────────────
check('无 base64 内联库', !/LWC_B64|base64|atob\(/.test(code))
check('lightweight-charts 真打包', code.includes('createChart') && code.includes('CandlestickSeries'))
check('react 保持外置', code.includes('require("react")'))
check('loader 包装形态正确', code.includes("id: 'dsh-hyperliquid'") && code.includes('__ModuleLoader__'))
check('产物带禁手改标识', code.includes('BUILD ARTIFACT'))

console.log(fail ? `${fail} check(s) FAILED` : 'client-integration 全部通过')
process.exit(fail ? 1 : 0)
