/** Evidence over a bounded history window; missing fields remain unknown. No balance inference. */
const numeric = (value) => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value)
const key = (row) => row?.oid == null || !row.coin ? null : `${row.coin}:${String(row.oid)}`
const core = (coin) => typeof coin === 'string' && coin.trim().length > 0 && !coin.startsWith('#') && !coin.includes(':') && !coin.startsWith('@') && !coin.includes('/')
export async function fundingWindow(client, address, startTime, endTime) {
  const rows = [], seen = new Set(); let cursor = startTime, partial = false
  for (let page = 0; page < 12; page++) {
    const result = await client.info('userFunding', { user: address, startTime: cursor, endTime })
    if (!Array.isArray(result)) throw Error('资金费历史响应无效')
    const valid = result.filter((row) => Number.isFinite(Number(row.time)) && Number(row.time) >= cursor && Number(row.time) <= endTime && row.delta?.type === 'funding')
    if (valid.length !== result.length) partial = true
    for (const row of valid) {
      const id = `${row.time}:${row.hash ?? ''}:${row.delta.coin}:${row.delta.usdc}`
      if (!seen.has(id)) { seen.add(id); rows.push(row) }
    }
    if (result.length < 500) return { rows, status: partial ? 'partial' : 'complete', pages: page + 1 }
    const last = Math.max(...valid.map((row) => Number(row.time)))
    if (!Number.isFinite(last) || last <= cursor) return { rows, status: 'partial', pages: page + 1 }
    // Inclusive boundary: repeat the final timestamp and deduplicate, avoiding lost peers.
    cursor = last
  }
  return { rows, status: 'partial', pages: 12 }
}
export function reviewLedger(payload, coin = '') {
  const orders = (payload.orders ?? []).filter((row) => !coin || row.coin === coin)
  const allFills = (payload.fills ?? []).filter((row) => !coin || row.coin === coin)
  const byOrder = new Map(orders.filter((row) => key(row)).map((row) => [key(row), row]))
  const seen = new Set(), records = []; let duplicates = 0
  for (const [index, fill] of allFills.entries()) {
    const id = fill.tid != null ? `${fill.coin}:${fill.tid}` : payload.mode === 'paper' && fill.oid ? `${fill.coin}:${fill.oid}` : `unidentified:${index}`
    if (seen.has(id)) { duplicates++; continue } seen.add(id)
    const order = byOrder.get(key(fill)), pnl = numeric(fill.closedPnl ?? fill.realized), fee = numeric(fill.fee)
    const feeToken = String(fill.feeToken ?? '').trim()
    const px = numeric(fill.px), size = numeric(fill.sz), buy = typeof fill.isBuy === 'boolean' ? fill.isBuy : fill.side === 'B' ? true : fill.side === 'A' ? false : null
    const reference = numeric(fill.referencePx ?? order?.referencePx)
    const reason = fill.reason || order?.reason || ''
    const closed = numeric(fill.closedSize) ?? (buy != null && numeric(fill.startPosition) != null && Math.sign(Number(fill.startPosition)) !== (buy ? 1 : -1) ? Math.min(Math.abs(Number(fill.startPosition)), size ?? 0) : /^Close/.test(fill.dir ?? '') ? size : null)
    const eligible = core(fill.coin) && feeToken === 'USDC'
    const net = eligible && pnl != null && fee != null ? pnl - fee : null
    const flags = []
    if (!order) flags.push('unmatched-order')
    if (px == null || px <= 0) flags.push('missing-price')
    if (size == null || size <= 0) flags.push('missing-size')
    if (numeric(fill.time) == null) flags.push('missing-time')
    if (buy == null) flags.push('missing-side')
    if (!reason || /^(session:|tool$|chat$|order$)/.test(reason)) flags.push('missing-reason')
    if (fee == null || !feeToken) flags.push('missing-fee')
    if (pnl == null) flags.push('missing-pnl')
    if (fill.tid == null && payload.mode !== 'paper') flags.push('missing-trade-id')
    records.push({ id, coin: fill.coin, oid: fill.oid ?? null, time: numeric(fill.time), px, size, isBuy: buy, gross: pnl, fee, feeToken, net,
      reference, slippageBps: reference && reference > 0 && px && buy != null ? (buy ? px - reference : reference - px) / reference * 10_000 : null,
      closedSize: closed, reason: flags.includes('missing-reason') ? '' : reason, sessionId: fill.sessionId ?? order?.sessionId ?? null, flags, source: payload.mode })
  }
  const reconciled = orders.map((order) => {
    const fills = records.filter((row) => key(row) && key(row) === key(order))
    const filled = fills.reduce((sum, row) => sum + (row.size ?? 0), 0)
    const expected = numeric(order.origSz ?? order.sz), tolerance = Math.max(1e-8, (expected ?? 0) * 1e-6)
    const status = fills.some((row) => row.flags.includes('missing-size')) ? 'missing-size' : /filled/i.test(order.status ?? '') && expected != null && Math.abs(filled - expected) > tolerance ? 'size-gap'
      : expected != null && filled > expected + tolerance ? 'excess-fill' : fills.length ? 'matched' : 'no-fill-in-window'
    return { coin: order.coin, oid: order.oid ?? null, status, filled, expected, exchangeStatus: order.status ?? 'unknown', reason: order.reason ?? '' }
  })
  const supported = records.filter((row) => core(row.coin))
  const fees = {}; for (const row of records) if (row.fee != null && row.feeToken) fees[row.feeToken] = (fees[row.feeToken] ?? 0) + row.fee
  const supportedScope = !coin || core(coin)
  const gross = supportedScope ? supported.reduce((sum, row) => sum + (row.gross ?? 0), 0) : null
  const tradingNet = !supportedScope || supported.some((row) => row.net == null) ? null : supported.reduce((sum, row) => sum + row.net, 0)
  const fundingRows = (payload.funding ?? []).filter((row) => core(row.delta?.coin) && (!coin || row.delta.coin === coin))
  const funding = supportedScope && payload.coverage?.fundingStatus === 'complete' && fundingRows.every((row) => numeric(row.delta.usdc) != null)
    ? fundingRows.reduce((sum, row) => sum + Number(row.delta.usdc), 0) : null
  const closes = supported.filter((row) => row.closedSize > 0)
  return { records, orders: reconciled, duplicates, fees, gross, tradingNet, funding,
    net: tradingNet != null && funding != null ? tradingNet + funding : null,
    closeCount: closes.length,
    missingReasons: records.filter((row) => row.flags.includes('missing-reason')).length,
    unmatched: records.filter((row) => row.flags.includes('unmatched-order')).length,
    gaps: reconciled.filter((row) => ['size-gap', 'excess-fill'].includes(row.status)).length,
    unsupported: records.length - supported.length,
  }
}
