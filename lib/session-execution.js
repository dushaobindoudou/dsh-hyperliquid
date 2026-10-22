/** Attribute real fills to chats; the exchange still has one net position per contract. */
export function orderOwnership({ orders = [], records = {}, decisions = {}, network, address }) {
  const byCloid = new Map(), byOid = new Map(), byTrigger = new Map()
  for (const [cloid, row] of Object.entries(records)) {
    const preview = decisions[row.decisionId]?.preview
    if ((row.network ?? preview?.network) !== network || String(row.address ?? preview?.address).toLowerCase() !== String(address).toLowerCase()) continue
    byCloid.set(cloid, row)
    const ids = row.orderIds ?? (row.response?.response?.data?.statuses ?? []).map((status) => status.resting?.oid ?? status.filled?.oid).filter((id) => id != null)
    for (const id of ids) byOid.set(String(id), row)
    for (const child of row.childCloids ?? []) byCloid.set(child, row)
    // Hyperliquid echoes no cloid on trigger (TPSL) children and returns no child oid in the
    // submit receipt, so a normalTpsl bracket can only be attributed by its own protective
    // prices. Keep coin+size+triggerPx and refuse ambiguous matches (two sessions, same bracket).
    const sz = Number(row.sz)
    for (const px of [row.protection?.stopLossPx, row.protection?.takeProfitPx]) {
      const triggerPx = Number(px)
      if (!row.coin || !Number.isFinite(sz) || !Number.isFinite(triggerPx) || triggerPx <= 0) continue
      const key = `${row.coin}|${sz}|${triggerPx}`
      if (!byTrigger.has(key)) byTrigger.set(key, new Set())
      byTrigger.get(key).add(row.sessionId)
    }
  }
  const triggerOwner = (order) => {
    if (!order?.isTrigger || !order.reduceOnly) return null
    const key = `${order.coin}|${Number(order.sz ?? order.origSz)}|${Number(order.triggerPx ?? order.limitPx)}`
    const owners = byTrigger.get(key)
    return owners && owners.size === 1 ? [...owners][0] : null
  }
  for (const entry of orders) {
    const order = entry.order ?? entry, owner = byCloid.get(order.cloid)
    if (order.oid == null) continue
    if (owner) byOid.set(String(order.oid), owner)
    else if (!byOid.has(String(order.oid))) {
      const sessionId = triggerOwner(order)
      if (sessionId) byOid.set(String(order.oid), { sessionId })
    }
  }
  const ownerOf = (fill) => (!address ? fill.sessionId : null) ?? byCloid.get(fill.cloid)?.sessionId ?? byOid.get(String(fill.oid))?.sessionId ?? null
  return { ownerOf, orderOwners: Object.fromEntries([...byOid].map(([id, row]) => [id, row.sessionId])) }
}

const fillDelta = (fill) => (fill.side === 'B' || fill.isBuy === true ? 1 : -1) * Number(fill.sz)
const PATH_EPS = 1e-10

/**
 * Hyperliquid can return fills of several orders that fired in the same millisecond
 * in an arbitrary order (tid is not monotonic), e.g. two stop losses of one position
 * filling together. Replaying them in arrival order invents a position path that never
 * existed, so rebuild each same-coin same-millisecond group from `startPosition`, the
 * exchange's own "position before this fill", by following that chain. Ambiguous
 * groups (duplicate or missing startPosition) fall back to the group's net direction.
 */
export function positionPath(fills) {
  const groups = new Map()
  for (const fill of [...fills].sort((a, b) => Number(a.time) - Number(b.time))) {
    const key = `${fill.coin ?? ''}|${fill.time ?? ''}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(fill)
  }
  const out = []
  for (const group of groups.values()) {
    if (group.length < 2 || group.some((fill) => !Number.isFinite(Number(fill.startPosition)))) { out.push(...group); continue }
    const rest = [...group], ordered = []
    const starts = rest.filter((fill) => !rest.some((other) => other !== fill &&
      Math.abs(Number(other.startPosition) + fillDelta(other) - Number(fill.startPosition)) < PATH_EPS))
    if (starts.length === 1) {
      let position = Number(starts[0].startPosition)
      while (rest.length) {
        const index = rest.findIndex((fill) => Math.abs(Number(fill.startPosition) - position) < PATH_EPS)
        if (index < 0) { ordered.length = 0; break }
        const [fill] = rest.splice(index, 1)
        ordered.push(fill)
        position += fillDelta(fill)
      }
    }
    if (ordered.length === group.length) out.push(...ordered)
    else {
      const net = group.reduce((sum, fill) => sum + fillDelta(fill), 0)
      out.push(...[...group].sort((a, b) => net < 0
        ? Number(b.startPosition) - Number(a.startPosition) : Number(a.startPosition) - Number(b.startPosition)))
    }
  }
  return out
}

export function sessionExposure({ sessionId, coin, size, fills = [], fillsLimited = false, ...ownership }) {
  const { ownerOf, orderOwners } = orderOwnership(ownership)
  const owners = new Map(), seen = new Set()
  let uncertain = false, baselineKnown = !fillsLimited
  for (const fill of positionPath(fills.filter((row) => row.coin === coin))) {
    const key = fill.tid ?? `${fill.oid}:${fill.time}:${fill.side}:${fill.sz}`
    if (seen.has(key)) continue
    seen.add(key)
    const signed = (fill.side === 'B' || fill.isBuy === true ? 1 : -1) * Number(fill.sz)
    const owner = ownerOf(fill)
    if (Number(fill.startPosition) === 0) baselineKnown = true
    if (!Number.isFinite(signed)) { uncertain = true; continue }
    if (owner) owners.set(owner, (owners.get(owner) ?? 0) + signed)
    else if (Number(fill.startPosition) * signed < 0 && [...owners.values()].some((value) => Math.abs(value) > 1e-10)) uncertain = true
    // A known flat exchange position closes every allocation, including historical unowned fills.
    if (Number.isFinite(Number(fill.startPosition)) && Math.abs(Number(fill.startPosition) + signed) < 1e-10) { owners.clear(); uncertain = false; baselineKnown = true }
  }
  if (Math.abs(size) < 1e-10) { owners.clear(); uncertain = false }
  const allocated = [...owners.values()].reduce((sum, value) => sum + value, 0)
  const known = !uncertain && Number.isFinite(size) && Math.abs(allocated) <= Math.abs(size) + 1e-10 &&
    [...owners.values()].every((value) => Math.abs(value) < 1e-10 || Math.sign(value) === Math.sign(size)) && (baselineKnown || size === 0)
  return { sessionId, coin, accountSize: size, sessionSize: known ? owners.get(sessionId) ?? 0 : null,
    ownershipConfirmed: known, unassignedSize: known ? size - allocated : null,
    owners: known ? Object.fromEntries(owners) : {},
    orderOwners }
}

export function assertSessionIntent(view, order, pending = []) {
  if (!view.ownershipConfirmed) throw new Error('会话仓位归属未确认，请先对账；不能把账户净仓当成本会话仓位')
  const signed = (order.isBuy ? 1 : -1) * order.sz
  if (order.reduceOnly) {
    if (!view.sessionSize || Math.sign(signed) === Math.sign(view.sessionSize) || order.sz > Math.abs(view.sessionSize) + 1e-10) throw new Error('只能减持本会话归属的仓位，不能平掉其他会话仓位')
    if ((view.pendingExits ?? []).some((exit) => exit.sessionId === view.sessionId) || pending.some((exit) => exit.coin === order.coin && exit.sessionId === view.sessionId)) throw new Error('本会话已有在途离场单、开仓单或止盈止损；先撤销并核对，再减仓，避免重复平掉其他会话份额')
  } else if (view.accountSize && Math.sign(signed) !== Math.sign(view.accountSize)) {
    throw new Error('同账户同合约存在反向仓位冲突；请先用 reduceOnly 平掉自己的份额，其他会话的仓位不能抵消，独立反向策略需不同交易账户')
  }
  if (!order.reduceOnly && (view.pendingExits ?? []).some((exit) => !exit.sessionId || !view.owners[exit.sessionId])) throw new Error('存在归属未知或仓位已平的遗留离场单，先核对并撤销，不能带入新仓')
  if (pending.some((row) => row.sessionId !== view.sessionId && row.coin === order.coin && !row.reduceOnly &&
    !['rejected', 'canceled', 'filled'].includes(row.status) && row.isBuy !== order.isBuy)) throw new Error('其他会话有反向在途订单，先对账解决冲突')
}

/** Cost-basis attribution for one chat; exchange closedPnl uses the shared account average. */
export function sessionFills(fills, sessionId, ownerOf) {
  const positions = new Map(), result = []
  for (const fill of positionPath(fills)) {
    const signed = (fill.side === 'B' || fill.isBuy === true ? 1 : -1) * Number(fill.sz)
    const accountFlat = Number.isFinite(Number(fill.startPosition)) && Math.abs(Number(fill.startPosition) + signed) < 1e-10
    if (ownerOf(fill) !== sessionId) { if (accountFlat) positions.delete(fill.coin); continue }
    const position = positions.get(fill.coin) ?? { size: 0, entry: 0 }
    const px = Number(fill.px)
    const incomplete = position.incomplete || (!positions.has(fill.coin) && (/close/i.test(fill.dir ?? '') || Number(fill.closedSize) > 0))
    if (!Number.isFinite(px) || !Number.isFinite(signed)) continue
    const closing = position.size * signed < 0
    const closedPnl = closing ? (px - position.entry) * Math.min(Math.abs(position.size), Math.abs(signed)) * Math.sign(position.size) : 0
    const next = position.size + signed
    const entry = !position.size || (next && Math.sign(next) !== Math.sign(position.size)) ? px
      : closing ? position.entry : (Math.abs(position.size) * position.entry + Math.abs(signed) * px) / Math.abs(next)
    result.push({ ...fill, exchangeClosedPnl: fill.closedPnl, closedPnl, startPosition: position.size, sessionEntryPx: entry, sessionId, attributionIncomplete: Boolean(incomplete) })
    if (accountFlat) positions.delete(fill.coin)
    else positions.set(fill.coin, { size: next, entry, incomplete })
  }
  return result.reverse()
}
