import assert from 'node:assert/strict'
import { Signature, Wallet, verifyTypedData } from 'ethers'
import { HyperliquidClient } from '../lib/hl.js'
import { buildL1TypedData } from '../lib/signing.js'

const pk = '0x' + '01'.repeat(32)
const client = new HyperliquidClient({ network: 'testnet', privateKey: pk })
const sent = []
const originalFetch = globalThis.fetch
globalThis.fetch = async (_url, opts) => {
  sent.push(JSON.parse(opts.body))
  return { ok: true, json: async () => ({ status: 'ok', response: { type: 'default' } }) }
}
try {
  const action = { type: 'cancel', cancels: [{ a: 0, o: 123 }] }
  await Promise.all([client.exchange(action), client.exchange(action)])
  assert.equal(sent.length, 2)
  assert.notEqual(sent[0].nonce, sent[1].nonce)
  for (const envelope of sent) {
    const typed = await buildL1TypedData(action, envelope.nonce, { isMainnet: false })
    const signer = verifyTypedData(typed.domain, typed.types, typed.value, Signature.from(envelope.signature).serialized)
    assert.equal(signer.toLowerCase(), new Wallet(pk).address.toLowerCase())
  }
  console.log('testnet 签名与并发 nonce 通过')
} finally {
  globalThis.fetch = originalFetch
}
