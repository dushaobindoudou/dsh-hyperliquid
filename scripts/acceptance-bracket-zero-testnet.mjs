/** Real testnet protocol probe for a normalTpsl batch from a fresh, unfunded signer.
 * The ephemeral address has no account or balance, so success is a clear error.
 * No private key or reusable wallet state is written to disk.
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { HyperliquidClient, sigFigs } from '../lib/hl.js'

const client = new HyperliquidClient({ network: 'testnet', privateKey: '0x' + randomBytes(32).toString('hex') })
try {
  const [meta, mids] = await Promise.all([client.meta(), client.allMids()])
  const asset = meta.universe.findIndex((row) => row.name === 'BTC')
  assert.ok(asset >= 0, 'BTC market missing from testnet')
  const mid = Number(mids?.mids?.BTC ?? mids?.BTC)
  assert.ok(mid > 0, 'BTC mid unavailable')
  const digits = Math.max(0, 6 - meta.universe[asset].szDecimals)
  const parentPx = sigFigs(mid * 0.8, 5, digits)
  const tpPx = sigFigs(mid * 1.2, 5, digits)
  const slPx = sigFigs(mid * 0.6, 5, digits)
  const action = { type: 'order', grouping: 'normalTpsl', orders: [
    { a: asset, b: true, p: parentPx, s: '0.001', r: false, t: { limit: { tif: 'Gtc' } }, c: '0x' + randomBytes(16).toString('hex') },
    { a: asset, b: false, p: tpPx, s: '0.001', r: true, t: { trigger: { isMarket: true, triggerPx: tpPx, tpsl: 'tp' } } },
    { a: asset, b: false, p: slPx, s: '0.001', r: true, t: { trigger: { isMarket: true, triggerPx: slPx, tpsl: 'sl' } } },
  ] }
  const response = await client.exchange(action)
  const detail = typeof response?.response === 'string' ? response.response : JSON.stringify(response?.response)
  assert.equal(response?.status, 'err', 'unfunded ephemeral signer unexpectedly accepted an order')
  assert.match(detail, /does not exist|user or api wallet|account not found/i)
  console.log(JSON.stringify({ network: 'testnet', action: 'normalTpsl', result: 'signed grouped order reached exchange; rejected as expected for unfunded ephemeral account', status: response.status }))
} finally {
  client.close()
}
