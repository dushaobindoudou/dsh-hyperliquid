/**
 * dsh-hyperliquid — chart drawing kinds shared by the host (validation, the
 * hyper_chart tool) and the browser chart (tools menu, rendering).
 *
 * level / trend keep their original flat fields (price; fromTime…toPrice);
 * every other kind stores `points: [{ time, price }]` in click order.
 * @module lib/chart-drawings
 */

/** kind → number of anchor points (level: a price only). */
export const DRAWING_POINTS = {
  level: 1, hray: 1, vline: 1, text: 1, trend: 2, ray: 2, extended: 2, fib: 2, rect: 2, measure: 2, channel: 3,
  // Positions store [entry, stop, target]; the desk creates them with 2 clicks (target defaults to 2R).
  long: 3, short: 3,
  // Fibonacci family, Gann, pitchfork, regression.
  fibext: 3, fibchannel: 3, fibtime: 2, gannfan: 2, pitchfork: 3, regression: 2,
  // Fixed range volume profile: the two points only set the time range.
  vprofile: 2,
  // Annotation and shapes. brush is freehand: 0 = variable (BRUSH_MIN..BRUSH_MAX points).
  arrow: 2, callout: 2, circle: 2, triangle: 3, brush: 0,
  // More lines and measures: cross line, price label, info line, trend angle, price-only and date-only ranges.
  crossline: 1, pricelabel: 1, infoline: 2, trendangle: 2, pricerange: 2, daterange: 2,
  // Advanced: Elliott waves, harmonic / chart patterns, Gann box & square, pitchfork variants, icons.
  elliott: 6, elliottabc: 4, xabcd: 5, abcd: 4, headshoulders: 7,
  gannbox: 2, gannsquare: 2, schiff: 3, modschiff: 3, icon: 1,
  // TradingView's remaining common tools (0.5.0).
  flatchannel: 3, disjoint: 3,
  fibfan: 2, fibcircles: 2, fibarcs: 2, fibwedge: 3, fibtrendtime: 3,
  cypher: 5, threedrives: 6, tripattern: 4, elliotttri: 6, elliottwxy: 4, elliottwxyxz: 6, cycles: 2, sine: 2,
  ellipse: 2, rotrect: 3, arc: 3, curve: 3,
  note: 1, pricenote: 2, signpost: 1,
  avwap: 1, avprofile: 1, forecast: 2,
  // Freehand highlighter (0 = variable, like brush); path / polyline take clicks until a double-click or Enter.
  highlighter: 0, path: 0, polyline: 0, pin: 1, fibspiral: 2, barspattern: 3,
  // Projection (TradingView's sector: origin, a future point, an estimated price); ghost feed is drawn like a path.
  projection: 3, ghostfeed: 0,
  // Screen-anchored text (TradingView's anchored text) and a table (cells split by |, rows by ; or a new line).
  anchoredtext: 1, table: 1,
  // Gann square fixed: always square on screen, 5×5 units (TradingView Charting Library defaults).
  gannfixed: 2,
  // Inside pitchfork, per TradingView's help: the median starts halfway (time and price) between the first two points.
  insidepitchfork: 3,
}
/** Kinds that can be pinned to a screen position (screenX / screenY, 0-1 of the plot). */
export const SCREEN_KINDS = ['anchoredtext', 'table']
/** Freehand kinds drawn by dragging. */
export const FREEHAND_KINDS = ['brush', 'highlighter']
/** Kinds drawn click by click until a double-click or Enter. */
export const MULTI_KINDS = ['path', 'polyline', 'ghostfeed']
export const PATH_MAX = 50
/** Icon stickers (the drawing's label holds the icon name). */
export const ICON_NAMES = ['flag', 'star', 'up', 'down', 'warning', 'check', 'cross', 'fire', 'target', 'bell', 'pin', 'clock', 'dollar', 'shield', 'bolt', 'heart', 'question', 'info']
/** Sticker library (TradingView's emoji stickers): category → emoji. An icon label is a name or `emoji:<char>`. */
export const STICKERS = {
  trading: ['📈', '📉', '💰', '💸', '🚀', '🎯', '🔥', '💎', '🐂', '🐻', '🐋', '🚨', '🔔', '⏰', '📌', '🧭', '🛑', '🏦', '⚖️', '🪙'],
  faces: ['😀', '😂', '😎', '🤔', '😱', '😭', '😡', '🥳', '🤯', '🙏', '👍', '👎', '👀', '💪', '🫡', '🤝'],
  symbols: ['⭐', '❗', '❓', '💡', '🔒', '🔓', '⛔', '🟢', '🔴', '🟡', '⬆️', '⬇️', '↗️', '↘️', '🏁', '🎉', '✅', '❌', '⚠️', '♻️', '⏸️', '▶️'],
}
const STICKER_SET = new Set(Object.values(STICKERS).flat())
/** Whether an icon drawing's label names a built-in icon or a library sticker. */
export function isIconLabel(label) {
  if (ICON_NAMES.includes(label)) return true
  if (typeof label !== 'string' || !label.startsWith('emoji:')) return false
  const emoji = label.slice(6)
  return STICKER_SET.has(emoji) || isSingleEmoji(emoji)
}

/** Any one emoji (a single grapheme that is pictographic, or a regional-indicator flag), so the whole emoji set works as stickers. */
export function isSingleEmoji(value) {
  if (typeof value !== 'string' || !value || value.length > 32 || !/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(value)) return false
  return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].length === 1
}
/**
 * Fixed range volume profile (TradingView FRVP): each bar's volume is spread evenly over its high–low
 * range into `rows` price rows, split by bar direction. POC is the heaviest row; the value area grows
 * from the POC toward the heavier neighbour until it holds `valueArea` of the volume.
 * @param {Array<{ open: number, high: number, low: number, close: number, volume: number }>} bars
 */
/** Chart intervals a drawing can be limited to (same set as the desk). */
export const INTERVALS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d', '3d', '1w', '1M']
/** Text drawings whose font size can be set. */
export const FONT_KINDS = ['text', 'callout', 'note', 'pricenote', 'signpost', 'anchoredtext', 'table']
/** Drawings with a background fill whose opacity can be set. */
export const FILL_KINDS = ['rect', 'circle', 'triangle', 'channel', 'fib', 'regression', 'gannbox', 'pricerange', 'daterange', 'measure', 'flatchannel', 'disjoint', 'ellipse', 'rotrect']
/** Fibonacci drawings whose levels can be customised. */
export const FIB_LEVEL_KINDS = ['fib', 'fibext', 'fibchannel']
export const PROFILE_ROWS_MIN = 6
export const PROFILE_ROWS_MAX = 200
export function volumeProfile(bars, { rows = 48, valueArea = 0.7 } = {}) {
  const valid = bars.filter((bar) => [bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite) && bar.high >= bar.low && bar.volume >= 0)
  if (!valid.length) return null
  const low = Math.min(...valid.map((bar) => bar.low)), high = Math.max(...valid.map((bar) => bar.high))
  // A flat range is one row at that exact price, not a row of invented width above it.
  const count = high > low ? rows : 1
  const step = high > low ? (high - low) / count : 0
  const out = Array.from({ length: count }, (_, index) => ({ low: low + index * step, high: count === 1 ? high : low + (index + 1) * step, up: 0, down: 0 }))
  for (const bar of valid) {
    const side = bar.close >= bar.open ? 'up' : 'down'
    if (count === 1) { out[0][side] += bar.volume; continue }
    if (bar.high === bar.low) { out[Math.min(count - 1, Math.floor((bar.low - low) / step))][side] += bar.volume; continue }
    const first = Math.max(0, Math.floor((bar.low - low) / step)), last = Math.min(count - 1, Math.floor((bar.high - low) / step))
    for (let index = first; index <= last; index += 1) {
      const overlap = Math.min(bar.high, out[index].high) - Math.max(bar.low, out[index].low)
      if (overlap > 0) out[index][side] += bar.volume * overlap / (bar.high - bar.low)
    }
  }
  const total = out.reduce((sum, row) => sum + row.up + row.down, 0)
  if (!(total > 0)) return null
  const size = (index) => index >= 0 && index < count ? out[index].up + out[index].down : -1
  let poc = 0
  for (let index = 1; index < count; index += 1) if (size(index) > size(poc)) poc = index
  let lo = poc, hi = poc, held = size(poc)
  while (held < total * valueArea && (lo > 0 || hi < count - 1)) {
    if (size(hi + 1) >= size(lo - 1)) { hi += 1; held += size(hi) } else { lo -= 1; held += size(lo) }
  }
  return { rows: out, total, poc: (out[poc].low + out[poc].high) / 2, pocIndex: poc, vah: out[hi].high, val: out[lo].low, valueLow: lo, valueHigh: hi }
}

/** Gann box divisions on both axes (TradingView defaults). */
export const GANN_BOX_LEVELS = [0, 0.25, 0.382, 0.5, 0.618, 0.75, 1]
/** Drawings a price can cross: alerts fire when the mid price crosses them (once, like TradingView). */
export const ALERT_KINDS = ['level', 'hray', 'trend', 'ray', 'extended']

/** The line's price at `time`, or null when the drawing does not exist at that time. */
export function linePriceAt(mark, time) {
  if (mark.kind === 'level') return Number(mark.price)
  const [a, b] = mark.kind === 'trend'
    ? [{ time: mark.fromTime, price: mark.fromPrice }, { time: mark.toTime, price: mark.toPrice }]
    : mark.points ?? []
  if (!a) return null
  if (mark.kind === 'hray') return time >= a.time ? a.price : null
  if (!b || b.time === a.time) return null
  // A trend line can be extended left and/or right (TradingView's per-line extend option).
  if (mark.kind === 'trend' && ((!mark.extendLeft && time < Math.min(a.time, b.time)) || (!mark.extendRight && time > Math.max(a.time, b.time)))) return null
  if (mark.kind === 'ray' && (time - a.time) * (b.time - a.time) < 0) return null
  return a.price + (b.price - a.price) * (time - a.time) / (b.time - a.time)
}

export const BRUSH_MIN = 2
export const BRUSH_MAX = 500
/** Kinds whose label is free text shown on the chart (up to 200 characters). */
export const TEXT_KINDS = ['text', 'callout', 'note', 'pricenote', 'signpost', 'pin', 'anchoredtext', 'table']
/** Clicks that create a drawing when they differ from its stored anchor count. */
export const DRAWING_CLICKS = { ...Object.fromEntries(Object.entries(DRAWING_POINTS)), long: 2, short: 2 }
export const DRAWING_KINDS = Object.keys(DRAWING_POINTS)
/** Fibonacci retracement levels (0 = second point, 1 = first point, as in TradingView). */
export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]
/** Trend-based Fibonacci extension levels (projected from the third point, TradingView defaults). */
export const FIB_EXT_LEVELS = [0, 0.382, 0.618, 1, 1.272, 1.618, 2, 2.618]
/** Fibonacci time zones: bar multiples of the first two points' spacing. */
export const FIB_TIME_SERIES = [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89]
/** Gann fan angles as price/time ratios relative to the 1×1 line. */
export const GANN_RATIOS = [[1, 8], [1, 4], [1, 3], [1, 2], [1, 1], [2, 1], [3, 1], [4, 1], [8, 1]]

const OLDEST = Date.UTC(2015, 0, 1)

/**
 * Validate the geometry of one drawing request (throws on invalid input).
 * @returns the geometry fields to persist for that kind.
 */
export function drawingGeometry(kind, request, now = Date.now()) {
  if (!DRAWING_KINDS.includes(kind)) throw new Error(`画线类型必须为 ${DRAWING_KINDS.join('/')}`)
  const latest = now + 365 * 86_400_000
  const point = (time, price, label) => {
    const t = Number(time), p = Number(price)
    if (!Number.isFinite(t) || t < OLDEST || t > latest) throw new Error(`${label}时间必须为 2015 年至今后一年内的毫秒时间戳`)
    if (!Number.isFinite(p) || p <= 0) throw new Error(`${label}价格必须为正数`)
    return { time: t, price: p }
  }
  if (kind === 'level') {
    const price = Number(request?.price)
    if (!Number.isFinite(price) || price <= 0) throw new Error('水平线 price 必须为正数')
    return { price }
  }
  if (kind === 'trend') {
    const from = point(request?.fromTime, request?.fromPrice, '趋势线起点')
    const to = point(request?.toTime, request?.toPrice, '趋势线终点')
    if (to.time <= from.time) throw new Error('趋势线终点时间必须晚于起点')
    return { fromTime: from.time, fromPrice: from.price, toTime: to.time, toPrice: to.price }
  }
  const need = DRAWING_POINTS[kind]
  const raw = request?.points
  if (FREEHAND_KINDS.includes(kind)) {
    if (!Array.isArray(raw) || raw.length < BRUSH_MIN || raw.length > BRUSH_MAX) throw new Error(`${kind} 需要 ${BRUSH_MIN}-${BRUSH_MAX} 个 points`)
  } else if (MULTI_KINDS.includes(kind)) {
    if (!Array.isArray(raw) || raw.length < 2 || raw.length > PATH_MAX) throw new Error(`${kind} 需要 2-${PATH_MAX} 个 points`)
  } else if (!Array.isArray(raw) || raw.length !== need) throw new Error(`${kind} 需要 ${need} 个 points（{ time, price }）`)
  const points = raw.map((item, index) => point(item?.time, item?.price, `第 ${index + 1} 个点`))
  if (['trend', 'ray', 'extended', 'channel', 'fibchannel', 'gannfan', 'regression', 'fibtime', 'infoline', 'trendangle', 'flatchannel', 'disjoint', 'fibfan', 'fibtrendtime', 'cycles', 'sine', 'forecast'].includes(kind) && points[0].time === points[1].time) throw new Error('前两个点的时间不能相同')
  if ((kind === 'cycles' || kind === 'sine' || kind === 'fibtrendtime') && points[1].time < points[0].time) throw new Error('第二个点必须晚于第一个点')
  if (kind === 'barspattern' && points[1].time <= points[0].time) throw new Error('K 线形态的源区间终点必须晚于起点')
  if (kind === 'projection' && points[1].time <= points[0].time) throw new Error('投影的第二个点必须在起点之后（未来方向）')
  if (kind === 'ghostfeed' && points.some((point, index) => index > 0 && point.time <= points[index - 1].time)) throw new Error('幽灵 K 线的点必须按时间从左到右')
  if (kind === 'vprofile') {
    if (points[0].time === points[1].time) throw new Error('成交量分布需要一个时间区间')
    // Only the time range matters, so either drawing direction is fine.
    if (points[1].time < points[0].time) points.reverse()
  }
  if ((kind === 'regression' || kind === 'fibtime' || kind === 'gannfan') && points[1].time < points[0].time) throw new Error('第二个点必须晚于第一个点')
  if (kind === 'long' || kind === 'short') {
    const [entry, stop, target] = points.map((item) => item.price)
    const ok = kind === 'long' ? stop < entry && entry < target : target < entry && entry < stop
    if (!ok) throw new Error(kind === 'long' ? '多头头寸需要 止损 < 入场 < 止盈' : '空头头寸需要 止盈 < 入场 < 止损')
    if (points[1].time <= points[0].time) throw new Error('头寸右边界时间必须晚于入场时间')
  }
  return { points }
}

const COLOR = /^#[0-9a-fA-F]{6}$/
export const LINE_STYLES = ['solid', 'dashed', 'dotted']

/** Validate optional appearance fields; absent keys are left untouched. */
export function drawingStyle(request) {
  const style = {}
  if (request?.color != null) {
    if (typeof request.color !== 'string' || !COLOR.test(request.color)) throw new Error('画线颜色必须为 #RRGGBB')
    style.color = request.color.toLowerCase()
  }
  if (request?.lineWidth != null) {
    const width = Number(request.lineWidth)
    if (!Number.isInteger(width) || width < 1 || width > 4) throw new Error('线宽必须为 1-4 的整数')
    style.lineWidth = width
  }
  if (request?.lineStyle != null) {
    if (!LINE_STYLES.includes(request.lineStyle)) throw new Error(`线型必须为 ${LINE_STYLES.join('/')}`)
    style.lineStyle = request.lineStyle
  }
  // TradingView object properties: visibility per interval, text size, background fill.
  if (request?.visibleIntervals != null) {
    const list = Array.isArray(request.visibleIntervals) ? [...new Set(request.visibleIntervals.map(String))] : []
    if (!list.length || list.some((iv) => !INTERVALS.includes(iv))) throw new Error(`visibleIntervals 需要 1 个以上周期：${INTERVALS.join('/')}`)
    style.visibleIntervals = list
  }
  if (request?.fontSize != null) {
    if (request?.kind != null && !FONT_KINDS.includes(request.kind)) throw new Error(`fontSize 只适用于 ${FONT_KINDS.join('/')}`)
    const size = Number(request.fontSize)
    if (!Number.isInteger(size) || size < 10 || size > 32) throw new Error('字号必须为 10-32 的整数')
    style.fontSize = size
  }
  // Pinned to the screen: both fractions together, or null (via update) to unpin.
  if (request?.screenX != null || request?.screenY != null) {
    if (request?.kind != null && !SCREEN_KINDS.includes(request.kind)) throw new Error(`screenX/screenY 只适用于 ${SCREEN_KINDS.join('/')}`)
    // Both must be real numbers (Number(null) would read as 0); unpinning passes both as null.
    const x = request.screenX == null ? NaN : Number(request.screenX), y = request.screenY == null ? NaN : Number(request.screenY)
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) throw new Error('screenX/screenY 必须同时提供，且在 0-1 之间（图表宽高的比例）')
    style.screenX = x; style.screenY = y
  }
  for (const flag of ['extendLeft', 'extendRight']) {
    if (request?.[flag] == null) continue
    if (request?.kind != null && request.kind !== 'trend') throw new Error(`${flag} 只适用于 trend`)
    if (typeof request[flag] !== 'boolean') throw new Error(`${flag} 必须为布尔值`)
    style[flag] = request[flag]
  }
  for (const flag of ['bold', 'italic']) {
    if (request?.[flag] == null) continue
    if (request?.kind != null && !FONT_KINDS.includes(request.kind)) throw new Error(`${flag} 只适用于 ${FONT_KINDS.join('/')}`)
    if (typeof request[flag] !== 'boolean') throw new Error(`${flag} 必须为布尔值`)
    style[flag] = request[flag]
  }
  if (request?.fillOpacity != null) {
    if (request?.kind != null && !FILL_KINDS.includes(request.kind)) throw new Error(`fillOpacity 只适用于 ${FILL_KINDS.join('/')}`)
    const opacity = Number(request.fillOpacity)
    if (!Number.isFinite(opacity) || opacity < 0 || opacity > 0.6) throw new Error('填充透明度必须在 0-0.6 之间')
    style.fillOpacity = opacity
  }
  // Custom Fibonacci levels (TradingView lets each fib drawing choose its own).
  if (request?.levels != null) {
    if (request?.kind != null && !FIB_LEVEL_KINDS.includes(request.kind)) throw new Error(`levels 只适用于 ${FIB_LEVEL_KINDS.join('/')}`)
    const levels = Array.isArray(request.levels) ? [...new Set(request.levels.map(Number))].sort((a, b) => a - b) : []
    if (levels.length < 1 || levels.length > 24 || levels.some((level) => !Number.isFinite(level) || level < -5 || level > 10)) throw new Error('斐波那契层级需要 1-24 个 -5 到 10 之间的数字')
    style.levels = levels
  }
  // Volume profile settings (TradingView "Rows" and "Value Area Volume").
  if (request?.rows != null) {
    if (request?.kind != null && request.kind !== 'vprofile') throw new Error('rows 只适用于固定范围成交量分布')
    const rows = Number(request.rows)
    if (!Number.isInteger(rows) || rows < PROFILE_ROWS_MIN || rows > PROFILE_ROWS_MAX) throw new Error(`成交量分布行数必须为 ${PROFILE_ROWS_MIN}-${PROFILE_ROWS_MAX} 的整数`)
    style.rows = rows
  }
  if (request?.valueArea != null) {
    if (request?.kind != null && request.kind !== 'vprofile') throw new Error('valueArea 只适用于固定范围成交量分布')
    const share = Number(request.valueArea)
    if (!Number.isFinite(share) || share < 0.5 || share > 0.95) throw new Error('价值区比例必须在 0.5-0.95 之间')
    style.valueArea = share
  }
  for (const flag of ['shared', 'alert']) {
    if (request?.[flag] == null) continue
    if (typeof request[flag] !== 'boolean') throw new Error(`${flag} 必须为布尔值`)
    style[flag] = request[flag]
  }
  if (style.alert && request?.kind != null && !ALERT_KINDS.includes(request.kind)) throw new Error(`只有 ${ALERT_KINDS.join('/')} 支持价格提醒`)
  if (request?.hidden != null) {
    if (typeof request.hidden !== 'boolean') throw new Error('hidden 必须为布尔值')
    style.hidden = request.hidden
  }
  if (request?.locked != null) {
    if (typeof request.locked !== 'boolean') throw new Error('locked 必须为布尔值')
    style.locked = request.locked
  }
  return style
}
