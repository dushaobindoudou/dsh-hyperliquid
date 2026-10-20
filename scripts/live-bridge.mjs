/**
 * dsh-hyperliquid — REAL-DATA bridge for out-of-host verification.
 *
 * The plugin's host half (HyperRemote) normally runs inside the dsh CLI.
 * When the sandbox blocks `dsh web`, this bridge instantiates the REAL
 * HyperRemote (real Hyperliquid testnet REST + WS via @nktkas/hyperliquid,
 * real paper matching in HyperStore) and exposes the `hyper` namespace over
 * a tiny local HTTP server. The browser harness then polls the bridge the
 * same way it would poll the host — same methods, same payloads.
 *
 * Usage:  node scripts/live-bridge.mjs [port]     (default 8791)
 * Smoke:  curl -s localhost:8791/status | head
 * @module scripts/live-bridge
 */

import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { HyperRemote } from '../lib/remote.js'

const PORT = Number(process.argv[2]) || 8791

// TypertRemoteService extends cordis Service — it needs a REAL context
// (reflect.provide / logger / get). A bare Context satisfies all of it;
// optional services (wallet/tools/approval) resolve to undefined.
const ctx = new Context()

const remote = new HyperRemote(ctx, {
  network: 'testnet',
  tradingMode: 'paper',
  // Isolated data dir so the bridge never touches the user's real registry.
  dataDir: join(tmpdir(), 'dsh-hyperliquid-bridge'),
})

// Seed one demo trading session so the desk has something to open.
const DEMO_SESSION = 'bridge-demo-btc'
await remote.registerSession({ sessionId: DEMO_SESSION, coin: 'BTC', title: null })
console.log(`[bridge] seeded session ${DEMO_SESSION}`)

const METHODS = new Set([
  'status', 'markets', 'snapshot', 'candles', 'account', 'orders', 'fills',
  'sessions', 'registerSession', 'removeSession', 'bindCoin', 'deskState',
  'eventsSince',
])

let callCount = 0
const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'content-type')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  const method = decodeURIComponent(new URL(req.url, 'http://x').pathname.slice(1))
  if (req.method !== 'POST' || !METHODS.has(method)) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: `unknown method ${method}` }))
    return
  }
  let body = ''
  for await (const chunk of req) body += chunk
  let request = null
  try { request = body ? JSON.parse(body) : null } catch { /* keep null */ }
  callCount += 1
  const t0 = Date.now()
  try {
    const out = await remote[method](request)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(out ?? null))
    if (callCount % 50 === 0) {
      console.log(`[bridge] ${method} ok ${Date.now() - t0}ms (total ${callCount} calls)`)
    }
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: String(err?.message ?? err) }))
    console.warn(`[bridge] ${method} FAILED: ${err?.message ?? err}`)
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[bridge] REAL Hyperliquid testnet data on http://127.0.0.1:${PORT}`)
  console.log('[bridge] open the harness with ?bridge=http://127.0.0.1:' + PORT)
})

const shutdown = () => {
  console.log('[bridge] shutting down…')
  try { remote.stopWs() } catch { /* already closed */ }
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1500)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
