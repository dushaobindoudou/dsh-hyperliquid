// hyper_* tool rows and the approval order card render the trader-facing summary.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const stub = fileURLToPath(new URL('./fixtures/primitives-stub.mjs', import.meta.url))
const out = await build({
  stdin: { contents: "export * from './src/client/dsh-extensions.tsx'; export { renderToStaticMarkup } from 'react-dom/server'; export * as React from 'react'", resolveDir: process.cwd(), loader: 'tsx' },
  bundle: true, format: 'esm', write: false, platform: 'node', jsx: 'automatic',
  alias: { '@deepseek-ai/dsh-client-ui-primitives': stub }, loader: { '.css': 'text' }, external: ['react', 'react-dom'],
})
const file = fileURLToPath(new URL('./.dsh-extensions.bundle.mjs', import.meta.url))
const { writeFileSync, rmSync } = await import('node:fs')
writeFileSync(file, out.outputFiles[0].text)
try {
  const mod = await import(file)
  const order = { action: 'place', coin: 'BTC', isBuy: true, sz: 0.001, type: 'limit', px: 81200, decisionId: 'x', reason: '回踩支撑做多' }
  assert.deepEqual(mod.describeHyperCall('hyper_order', order), { title: '下单', summary: '买入 0.001 BTC @ 81,200' })
  assert.equal(mod.describeHyperCall('hyper_decide', { coin: 'ETH', isBuy: false, sz: 2, type: 'market' }).summary, '卖出 2 ETH 市价')
  assert.equal(mod.describeHyperCall('hyper_market', { action: 'indicators', coin: 'BTC', interval: '15m' }).summary, '技术指标 · BTC · 15m')
  assert.equal(mod.describeHyperCall('hyper_order', { action: 'leverage', coin: 'BTC', leverage: 3 }).summary, 'BTC · 3x')

  // Capture the registered components through a fake slots service.
  const captured = {}
  const slots = { inject: (_k, cb) => cb(), register: (o, c) => { captured[o.key ?? o.name] = { o, c }; return () => {} } }
  mod.registerDshExtensions({ effect: (fn) => fn() }, slots)
  assert.equal(captured['conversation.approval.detail'].o.priority, -1, 'shadows the shipped detail instead of colliding with it')
  const { React, renderToStaticMarkup } = mod
  const disclosure = () => ({ expanded: true, toggle() {}, setExpanded() {} })
  const settled = renderToStaticMarkup(React.createElement(captured.hyper_decide.c, { phase: 'result', toolName: 'hyper_decide', useDisclosure: disclosure,
    block: { call: { name: 'hyper_decide', argsRaw: JSON.stringify({ coin: 'BTC', isBuy: true, sz: 0.001, type: 'limit', px: 81200 }) }, isError: false, content: [{ type: 'text', text: '交易预检通过：买入 BTC，价格=81200\n详细' }] } }))
  assert.match(settled, /交易预检 · 买入 0.001 BTC @ 81,200/)
  assert.match(settled, /交易预检通过：买入 BTC/)
  assert.match(settled, /data-running="false"/)
  const running = renderToStaticMarkup(React.createElement(captured.hyper_order.c, { phase: 'start', toolName: 'hyper_order', useDisclosure: disclosure, block: { argsRaw: JSON.stringify(order) } }))
  assert.match(running, /data-running="true"/)

  const chat = (name, args) => (selector) => selector({ nodes: new Map([['n', { kind: 'tool-call', data: { root: { callId: 'c1', phase: 'start', name, argsRaw: JSON.stringify(args) } } }]]) })
  const card = renderToStaticMarkup(React.createElement(captured['conversation.approval.detail'].c, { callId: 'c1', useChat: chat('hyper_order', order) }))
  for (const text of ['买入', '81,200', '81.20 USD', '回踩支撑做多']) assert.ok(card.includes(text), `approval card shows ${text}`)
  const bash = renderToStaticMarkup(React.createElement(captured['conversation.approval.detail'].c, { callId: 'c1', useChat: chat('bash', { command: 'ls -la' }) }))
  assert.equal(bash, 'ls -la', 'other tools keep the shipped command detail')
  console.log('hyper_* 工具卡片与审批订单详情渲染通过')
} finally { rmSync(file, { force: true }) }
