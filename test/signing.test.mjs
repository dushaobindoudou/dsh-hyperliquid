/**
 * Signing cross-validation against the official Python SDK.
 *
 * Golden vectors in ./signing-vectors.json are generated with the official
 * hyperliquid-python-sdk (see ./signing-vector.py; regenerate with:
 *   uv venv /tmp/hl-venv --python 3.12
 *   uv pip install --python /tmp/hl-venv/bin/python hyperliquid-python-sdk
 *   /tmp/hl-venv/bin/python test/signing-vector.py > test/signing-vectors.json
 * ).
 *
 * Run: node test/signing.test.mjs   (exit 0 = all vectors match)
 *
 * Note on comparison: the SDK's to_hex emits MINIMAL hex (no leading zeros),
 * our signer emits fixed-width 64 — compare zero-padding-normalized.
 * @module test/signing.test.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { signL1Action } from '../lib/signing.js'

const here = dirname(fileURLToPath(import.meta.url))
const vec = JSON.parse(readFileSync(join(here, 'signing-vectors.json'), 'utf8'))

const norm = (h) => '0x' + h.replace(/^0x/, '').replace(/^0+/, '')
const PK = '0x' + '01'.repeat(32)
const VAULT = '0x1234567890abcdef1234567890abcdef12345678'

const cases = [
  ['case1', { type: 'order', orders: [{ a: 0, b: true, p: '82534', s: '0.01', r: false, t: { limit: { tif: 'Ioc' } } }], grouping: 'na' }, 1700000000000, null, true],
  ['case2', { type: 'cancel', cancels: [{ a: 1, o: 12345 }] }, 1700000000001, VAULT, false],
  ['case3', { type: 'updateLeverage', asset: 3, isCross: true, leverage: 5 }, 1700000000002, null, true],
  ['case4', { type: 'order', orders: [
    { a: 0, b: true, p: '80000', s: '0.001', r: false, t: { limit: { tif: 'Gtc' } }, c: '0x11111111111111111111111111111111' },
    { a: 0, b: false, p: '90000', s: '0.001', r: true, t: { trigger: { isMarket: true, triggerPx: '90000', tpsl: 'tp' } } },
    { a: 0, b: false, p: '70000', s: '0.001', r: true, t: { trigger: { isMarket: true, triggerPx: '70000', tpsl: 'sl' } } },
  ], grouping: 'normalTpsl' }, 1700000000003, null, false],
]

let fail = 0
for (const [label, action, nonce, vault, mainnet] of cases) {
  const got = await signL1Action(PK, action, vault, nonce, mainnet)
  const want = vec[label]
  const ok = norm(got.r) === norm(want.r) && norm(got.s) === norm(want.s) && got.v === want.v
  if (!ok) fail += 1
  console.log(ok ? 'PASS' : 'FAIL', label, ok ? '' : JSON.stringify({ got, want: { r: want.r, s: want.s, v: want.v } }))
}
const shuffledOrder = {
  grouping: 'na',
  orders: [{ s: '0.01', t: { limit: { tif: 'Ioc' } }, a: 0, b: true, p: '82534', r: false }],
  type: 'order',
}
const reordered = await signL1Action(PK, shuffledOrder, null, 1700000000000, true)
const orderVector = vec.case1
const canonicalOrder = norm(reordered.r) === norm(orderVector.r)
  && norm(reordered.s) === norm(orderVector.s) && reordered.v === orderVector.v
if (!canonicalOrder) fail += 1
console.log(canonicalOrder ? 'PASS' : 'FAIL', 'order 字段顺序归一化')
console.log(fail ? `${fail} vector(s) FAILED` : '全部向量与官方 SDK 逐字节一致')
process.exit(fail ? 1 : 0)
