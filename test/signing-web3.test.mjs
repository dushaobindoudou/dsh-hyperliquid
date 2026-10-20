/**
 * dsh-web3 path cross-validation.
 *
 * signer=web3 routes the L1 action through dsh-web3's `signTypedData` —
 * i.e. a STANDARD ethers-style EIP-712 signer — instead of our in-plugin
 * @noble digest signer. This test proves the two paths are byte-identical:
 * for every official SDK vector, `ethers.Wallet.signTypedData(
 * buildL1TypedData(action, nonce))` must reproduce the exact r/s/v the
 * official hyperliquid-python-sdk produced.
 *
 * Run: node test/signing-web3.test.mjs   (exit 0 = paths equivalent)
 * @module test/signing-web3.test.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Wallet } from 'ethers'
import { buildL1TypedData, signL1Action, splitSignature } from '../lib/signing.js'

const here = dirname(fileURLToPath(import.meta.url))
const vec = JSON.parse(readFileSync(join(here, 'signing-vectors.json'), 'utf8'))

const norm = (h) => '0x' + h.replace(/^0x/, '').replace(/^0+/, '')
const PK = '0x' + '01'.repeat(32)
const VAULT = '0x1234567890abcdef1234567890abcdef12345678'
const wallet = new Wallet(PK)

const cases = [
  ['case1', { type: 'order', orders: [{ a: 0, b: true, p: '82534', s: '0.01', r: false, t: { limit: { tif: 'Ioc' } } }], grouping: 'na' }, 1700000000000, null, true],
  ['case2', { type: 'cancel', cancels: [{ a: 1, o: 12345 }] }, 1700000000001, VAULT, false],
  ['case3', { type: 'updateLeverage', asset: 3, isCross: true, leverage: 5 }, 1700000000002, null, true],
]

let fail = 0
for (const [label, action, nonce, vault, mainnet] of cases) {
  const want = vec[label]
  // Path A (validated): in-plugin digest signer vs official vector.
  const local = await signL1Action(PK, action, vault, nonce, mainnet)
  const okLocal = norm(local.r) === norm(want.r) && norm(local.s) === norm(want.s) && local.v === want.v
  // Path B (dsh-web3): ethers signs the typed-data payload; vaultAddress is
  // hashed into the actionHash pre-image (buildL1TypedData), not the domain.
  const typed = await buildL1TypedData(action, nonce, { vaultAddress: vault, isMainnet: mainnet })
  const hex = await wallet.signTypedData(typed.domain, typed.types, typed.value)
  const web3 = splitSignature(hex)
  const okWeb3 = norm(web3.r) === norm(want.r) && norm(web3.s) === norm(want.s) && web3.v === want.v
  // Paths must also agree with each other.
  const okSame = norm(local.r) === norm(web3.r) && norm(local.s) === norm(web3.s) && local.v === web3.v
  const ok = okLocal && okWeb3 && okSame
  if (!ok) fail += 1
  console.log(ok ? 'PASS' : 'FAIL', label,
    okWeb3 ? 'ethers typed-data == 官方向量' : JSON.stringify({ web3, want: { r: want.r, s: want.s, v: want.v } }))
}

// splitSignature unit checks: 65-byte hex → wire form; v normalization 0/1 → 27/28.
const sig = wallet.signingKey.sign('0x' + '11'.repeat(32))
const split = splitSignature(sig.serialized)
const okSplit = split.r === '0x' + sig.r.slice(2).padStart(64, '0')
  && split.s === '0x' + sig.s.slice(2).padStart(64, '0')
  && (split.v === sig.v || split.v === sig.v + 27)
console.log(okSplit ? 'PASS' : 'FAIL', 'splitSignature 归一化', okSplit ? '' : JSON.stringify(split))
if (!okSplit) fail += 1

console.log(fail ? `${fail} 项 FAILED` : 'local 与 web3 两条签名路径等价，且均与官方向量逐字节一致')
process.exit(fail ? 1 : 0)
