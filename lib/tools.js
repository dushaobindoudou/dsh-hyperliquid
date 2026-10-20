/**
 * dsh-hyperliquid — agent tools. Every trading operation the desk exposes to
 * the model routes through the SAME HyperRemote methods the UI would use
 * (one operation, two callers — the UI simply chooses not to render manual
 * controls), so "所有下单操作都是 dsh 会话进行" holds by construction.
 * @module lib/tools.js
 */

import { closedCandles, computeIndicators } from './indicators.js'
import { MA_KINDS, MA_SOURCES, maLabel, maLatest, normalizeMaLine, normalizeMaLines } from './moving-average.js'
import { INDICATOR_IDS, computeStudies, normalizeIndicatorSettings, studyDefinitions } from './studies.js'
import { reviewLedger } from './review.js'
import { DRAWING_KINDS, DRAWING_POINTS, TEXT_KINDS, drawingStyle, volumeProfile } from './chart-drawings.js'

const DRAWING_NAMES = { insidepitchfork: '内部叉子线', gannfixed: '固定江恩方格', anchoredtext: '锚定文本', table: '表格', projection: '投影', ghostfeed: '幽灵 K 线', highlighter: '荧光笔', path: '路径', polyline: '折线', pin: '图钉', fibspiral: '斐波那契螺旋', barspattern: 'K 线形态', flatchannel: '平顶/平底通道', disjoint: '分离通道', fibfan: '斐波那契速度阻力扇', fibcircles: '斐波那契圆', fibarcs: '斐波那契弧', fibwedge: '斐波那契楔形', fibtrendtime: '基于趋势的斐波那契时间',
  cypher: 'Cypher 形态', threedrives: '三驱形态', tripattern: '三角形态', elliotttri: '艾略特三角浪', elliottwxy: '艾略特双重组合', elliottwxyxz: '艾略特三重组合', cycles: '周期线', sine: '正弦线',
  ellipse: '椭圆', rotrect: '旋转矩形', arc: '弧线', curve: '曲线', note: '便签', pricenote: '价格便签', signpost: '路标', avwap: '锚定 VWAP', avprofile: '锚定成交量分布', forecast: '预测', vprofile: '固定范围成交量分布', level: '水平线', hray: '水平射线', vline: '垂直线', text: '文本', trend: '趋势线', ray: '射线', extended: '延长线', channel: '平行通道', fib: '斐波那契回撤', rect: '矩形', measure: '价格区间', long: '多头头寸', short: '空头头寸', fibext: '斐波那契扩展', fibchannel: '斐波那契通道', fibtime: '斐波那契时间周期', gannfan: '江恩扇形', pitchfork: '安德鲁叉子线', regression: '回归趋势', arrow: '箭头', callout: '标注气泡', circle: '圆形', triangle: '三角形', brush: '画笔', crossline: '十字线', pricelabel: '价格标签', infoline: '信息线', trendangle: '趋势角度', pricerange: '价格区间', daterange: '日期区间', elliott: '艾略特推动浪', elliottabc: '艾略特调整浪', xabcd: 'XABCD 谐波', abcd: 'ABCD 形态', headshoulders: '头肩形态', gannbox: '江恩箱', gannsquare: '江恩方格', schiff: 'Schiff 叉子线', modschiff: '改良 Schiff 叉子线', icon: '图标' }
import { canonicalMarketCoin } from './market-symbol.js'
import { addEntry, journalDigest, removeStrategy, updateProfile, upsertStrategy } from './journal.js'
import { analyzeTrading, checkupText } from './analysis.js'
import { scanMarkets, scanText } from './scan.js'

/** Resolve the calling session id from a tool run context. */
function sessionIdOf(exec) {
  const agent = exec?.agent
  return agent?.id ?? agent?.session?.id ?? null
}

const INTERVAL_MS = { '1m': 60e3, '3m': 180e3, '5m': 300e3, '15m': 900e3, '30m': 1800e3, '1h': 3600e3, '2h': 7200e3, '4h': 14400e3, '8h': 28800e3, '12h': 43200e3, '1d': 86400e3, '3d': 259200e3, '1w': 604800e3, '1M': 2592000e3 }

function fmt(n, d = 2) {
  if (n == null) return '—'
  const v = Number(n)
  return Number.isFinite(v) ? v.toLocaleString('en-US', { maximumFractionDigits: d }) : '—'
}

function shortSide(isBuy) { return isBuy ? 'BUY/LONG' : 'SELL/SHORT' }

/**
 * DSH requires tool output to be lossless JSON: no undefined fields, no NaN / Infinity.
 * Every hyper_* result is normalized here so a stray field can never fail a tool call.
 */
export function losslessJson(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'number' && !Number.isFinite(item) ? null : item))
}

export function buildToolDefinitions(remote, authorize = () => {}) {
  return buildTools(remote).map((tool) => ({ ...tool, async execute(...args) { authorize(tool.name, args[0], args[1]); return losslessJson(await tool.execute(...args)) } }))
}

function buildTools(remote) {
  return [
    {
      name: 'hyper_context',
      description: '一次读取本会话交易上下文：当前币对/周期、价格、盘口和成交、资金费、K 线、账户权益与仓位/挂单、数据时间和风险限额。做交易判断前优先调用。',
      parameters: { type: 'object', properties: { coin: { type: 'string', description: '可选；默认本会话绑定币对或当前交易台币对' } }, additionalProperties: false },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: v.text }] },
      timeoutMs: 20_000,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        const row = sessionId ? remote.store.getSession(sessionId) : null
        const coin = canonicalMarketCoin(args?.coin ?? row?.coin ?? remote.desk?.coin)
        if (!coin) throw new Error('无法确定会话币对，请提供 coin')
        const workspace = row ? remote.store.getSessionWorkspace?.(sessionId) ?? null : null
        const interval = workspace?.interval ?? remote.desk?.interval ?? '15m'
        const [markets, snap, account, candleResult, status] = await Promise.all([
          remote.markets(), remote.snapshot({ coin }), remote.account({ coin }), remote.candles({ coin, interval }), remote.status(),
        ])
        const coreMarket = markets.universe.find((m) => m.name === coin)
        const detail = coreMarket ? null : await remote.marketDetail({ coin })
        const market = coreMarket ?? detail?.market
        if (!market) throw new Error(`未知市场 ${coin}`)
        const bid = snap.book?.levels?.[0]?.[0]
        const ask = snap.book?.levels?.[1]?.[0]
        const candles = candleResult.candles.slice(-24)
        // Core perps and USDC-collateral HIP-3 perps are tradable; spot and outcomes stay view only.
        const tradable = Boolean(coreMarket) || (detail?.market?.kind === 'hip3' && detail.market.tradable === true)
        const position = account.positions.find((p) => p.coin === coin) ?? null
        // HIP-3 mids are not in the core allMids snapshot: read the market's own dex.
        const dexMid = tradable && !coreMarket ? await remote.midOf(coin).then((value) => ({ value, at: Date.now() }), () => null) : null
        const mid = dexMid ? dexMid.value : Number(snap.mids?.mids?.[coin] ?? snap.mids?.[coin])
        const midsAt = dexMid ? dexMid.at : snap.observedAt?.mids
        const midFresh = tradable && midsAt && Date.now() - midsAt < 10_000 && Number.isFinite(mid) && mid > 0
        const mark = market.ctx?.markPx != null ? Number(market.ctx.markPx) : null
        const change24hPct = Number(market.ctx?.prevDayPx) > 0 && mark != null ? (mark / Number(market.ctx.prevDayPx) - 1) * 100 : null
        const context = {
          workspace: workspace ? { interval: workspace.interval, bookGrouping: workspace.bookGrouping,
            chartTab: workspace.chartTab, chartType: workspace.chartType ?? 'candles', indicators: workspace.indicators, indicatorSettings: normalizeIndicatorSettings(workspace.indicatorSettings), research: workspace.research ?? null, priceScale: workspace.priceScale } : null,
          sessionId, coin, interval, marketKind: detail?.market?.kind ?? 'perp', tradable, network: markets.network, mode: account.mode,
          mark, mid: midFresh ? mid : null, change24hPct, funding1h: market.ctx?.funding != null ? Number(market.ctx.funding) : null,
          volume24hUsd: market.ctx?.dayNtlVlm != null ? Number(market.ctx.dayNtlVlm) : null,
          bid: bid ? { px: Number(bid.px), sz: Number(bid.sz) } : null,
          ask: ask ? { px: Number(ask.px), sz: Number(ask.sz) } : null,
          accountMode: account.accountMode ?? null,
          balanceSource: account.balanceSource ?? null,
          accountDex: account.accountDex ?? '',
          positionsCoverage: account.positionsCoverage ?? null,
          accountValue: account.mode === 'paper' ? account.equity : account.balanceSource === 'spot' ? account.usdcBalance : Number(account.marginSummary?.accountValue),
          available: account.mode === 'paper' ? account.availableMargin : account.balanceSource === 'spot'
            ? account.tradeCapacity?.coin === coin ? Math.min(...account.tradeCapacity.availableToTrade.map(Number)) : null
            : account.withdrawable,
          position, positions: account.positions, openOrders: (account.openOrders ?? []).slice(0, 20), candles,
          recentTrades: (Array.isArray(snap.trades) ? snap.trades : []).slice(0, 10),
          bookDepth: { bids: (snap.book?.levels?.[0] ?? []).slice(0, 5), asks: (snap.book?.levels?.[1] ?? []).slice(0, 5) },
          riskLimits: status.riskLimits, autonomousLive: status.autonomousLive, custody: status.custody, walletConfigured: status.walletConfigured,
          observedAt: { ...snap.observedAt, ...(dexMid ? { mids: dexMid.at } : {}), market: detail?.observedAt ?? markets.observedAt ?? null }, ws: snap.ws, assembledAt: Date.now(),
        }
        const bookAge = context.observedAt?.book ? Math.round((context.assembledAt - context.observedAt.book) / 1000) : null
        const midsAge = context.observedAt?.mids ? Math.round((context.assembledAt - context.observedAt.mids) / 1000) : null
        const marketAge = context.observedAt?.market ? Math.round((context.assembledAt - context.observedAt.market) / 1000) : null
        const freshness = tradable
          ? bookAge == null || midsAge == null || bookAge > 10 || midsAge > 10 ? '数据过期/缺失，停止交易并重新读取' : '数据新鲜'
          : bookAge == null || marketAge == null || bookAge > 10 || marketAge > 60 ? '只读行情过期/缺失' : '只读行情可用'
        const text = [
          `${coin} ${interval} · ${detail?.market?.kind ?? 'perp'}${tradable ? '' : '（只读市场）'} · ${account.mode}/${markets.network} · 读取 ${new Date(context.assembledAt).toISOString()} · 盘口 ${bookAge ?? '?'}s / ${tradable ? 'mid ' + (midsAge ?? '?') : '市场上下文 ' + (marketAge ?? '?')}s · ${freshness}`,
          workspace ? `会话图表：${workspace.chartTab}/${workspace.chartType ?? 'candles'} · 指标=${workspace.indicators.join(',') || '无'} · 刻度=${workspace.priceScale} · 盘口精度=${workspace.bookGrouping}` : '',
          `mark=${fmt(mark)} mid=${fmt(context.mid)} 24h=${change24hPct == null ? '?' : fmt(change24hPct) + '%'} 资金费=${context.funding1h == null ? '不适用' : fmt(context.funding1h * 100, 4) + '%/h'} 24h成交=${fmt(context.volume24hUsd, 0)} USD`,
          `bid=${fmt(context.bid?.px)} ask=${fmt(context.ask?.px)} ${context.balanceSource === 'spot' ? 'USDC余额' : context.accountDex ? `${context.accountDex} DEX 抵押额` : '权益'}=${fmt(context.accountValue)} ${context.balanceSource === 'spot' ? '交易所可交易名义额' : '可用'}=${fmt(context.available)} ${context.accountDex && context.balanceSource !== 'spot' ? '抵押币单位' : 'USD'} · 挂单=${context.openOrders.length}${context.accountMode ? ` · 账户模式=${context.accountMode}` : ''}`,
          !tradable ? account.mode === 'paper'
            ? '当前账户数据不代表该只读市场的余额、仓位或可交易额度。'
            : `当前市场仅可分析；${context.positionsCoverage === 'all-dexs' ? '仓位来自全部永续 DEX 快照' : '账户仓位仅覆盖所选 DEX'}${position ? `；当前仓位=${fmt(position.size, 6)} ${coin}` : ''}，不能据此在该市场下单。`
            : position ? `仓位 ${position.size > 0 ? 'LONG' : 'SHORT'} ${fmt(Math.abs(position.size), 6)} ${coin} entry=${fmt(position.entryPx)} uPnL=${fmt(position.uPnl)}` : '当前币对无持仓',
          `风险：允许币对=${(context.riskLimits?.allowedCoins ?? []).includes('*') ? '全部' : (context.riskLimits?.allowedCoins ?? []).join(',')} 单笔≤${fmt(context.riskLimits?.maxOrderUsd)} USD 每日≤${fmt(context.riskLimits?.maxDailyUsd)} USD 杠杆≤${fmt(context.riskLimits?.maxLeverage, 0)}x · 托管模式=${context.custody === 'managed' ? '全托管（可自主执行、调整限额与划转）' : '半托管（实盘与划转需用户批准，限额由用户修改）'}${account.mode === 'paper' ? ' · 模拟盘配置的滑点与手续费，未模拟盘口深度、资金费或强平' : ''}`,
          `近 ${candles.length} 根 K 线价格（末根可能未收盘）: ${candles.map((c) => fmt(c.c)).join(', ')}`,
        ].join('\n')
        return { text, context }
      },
    },
    {
      name: 'hyper_market',
      description:
        '查询 Hyperliquid 核心永续、HIP-3、现货与 Outcome 行情。action=scan 市场雷达：扫描约 20 个可交易永续（成交额最大的核心永续 + 前 5 个 HIP-3），给出贴近/突破区间、资金费极值、24h 涨跌、溢价的前几名（用户问“今天有什么机会”时先用它）；action=overview 列出核心永续的 24h 涨跌/成交/资金费；action=book 查盘口；' +
        'action=catalog 搜索所有市场，支持官方 perpCategories 分类；action=candles 查 K 线（支持 Hyperliquid 官方 1m 至 1M 的 14 种周期）；action=indicators 计算 SMA/EMA/RSI/MACD/布林带/ATR/Stochastic/ADX/OBV/支撑阻力，遵循当前会话指标参数；action=trades 查最近成交。核心永续与 USDC 保证金的 HIP-3 永续（如 xyz:XYZ100）可交易，现货与 Outcome 目前只读；HIP-3 每个 dex 保证金独立，需要该 dex 有 USDC 或开启统一账户。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['overview', 'scan', 'catalog', 'book', 'candles', 'indicators', 'trades'], description: '行情查询类型' },
          ma: { type: 'array', description: 'action=indicators 可选：额外计算的均线，最多 8 条；省略时返回当前会话图表上已叠加的均线', items: { type: 'object', properties: { kind: { type: 'string', enum: MA_KINDS }, period: { type: 'number' }, source: { type: 'string', enum: MA_SOURCES }, smoothing: { type: 'object', properties: { kind: { type: 'string', enum: MA_KINDS }, period: { type: 'number' } } } }, required: ['kind', 'period'] } },
          coin: { type: 'string', description: '官方合约名，以 action=catalog 返回的 name 为准，如 BTC 或 xyz:XYZ100；overview 时可省略' },
          kind: { type: 'string', enum: ['perp', 'hip3', 'spot', 'outcome'], description: 'catalog 市场类型过滤' },
          category: { type: 'string', description: 'catalog 官方分类过滤，如 crypto、stocks、commodities、indices、fx、rates、preipo；tradfi 聚合这些传统金融标签' },
          query: { type: 'string', description: 'catalog 名称搜索' },
          interval: { type: 'string', description: 'K 线周期，默认 1h' },
          limit: { type: 'number', description: 'candles/trades 返回条数上限，默认 48，candles 最多 200' },
          endMs: { type: 'number', description: 'action=candles 可选：返回这一时刻（epoch 毫秒）之前的 K 线，用于往前翻页取历史；交易所每个周期只保留最近约 5000 根' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: v.text }] },
      timeoutMs: 15_000,
      async execute(args, exec) {
        const action = args?.action ?? 'overview'
        if (action === 'overview') {
          const { universe } = await remote.markets()
          const scored = universe
            .filter((u) => u.ctx)
            .sort((a, b) => Number(b.ctx.dayNtlVlm ?? 0) - Number(a.ctx.dayNtlVlm ?? 0))
            .slice(0, 20)
            .map((u) => ({
              coin: u.name,
              mark: Number(u.ctx.markPx),
              change24hPct: Number(u.ctx.prevDayPx) ? ((Number(u.ctx.markPx) - Number(u.ctx.prevDayPx)) / Number(u.ctx.prevDayPx)) * 100 : 0,
              vol24hUsd: Number(u.ctx.dayNtlVlm),
              fundingPct1h: Number(u.ctx.funding) * 100,
              openInterestUsd: Number(u.ctx.openInterest) * Number(u.ctx.markPx),
              maxLeverage: u.maxLeverage,
            }))
          return { text: scored.map((s) => `${s.coin} mark=${fmt(s.mark)} 24h=${s.change24hPct.toFixed(2)}% vol=${fmt(s.vol24hUsd, 0)} funding=${s.fundingPct1h.toFixed(4)}%/h OI=${fmt(s.openInterestUsd, 0)} maxLev=${s.maxLeverage}x`).join('\n'), coins: scored }
        }
        if (action === 'scan') {
          const result = await scanMarkets(remote)
          return { text: scanText(result), ...result }
        }
        if (action === 'catalog') {
          const result = await remote.marketCatalog()
          const query = String(args?.query ?? '').trim().toLowerCase()
          const category = String(args?.category ?? '').trim().toLowerCase()
          const tradfiTags = new Set(['stocks', 'stock', 'equities', 'equity', 'commodities', 'indices', 'fx', 'rates', 'preipo'])
          const limit = Math.max(1, Math.min(Number(args?.limit) || 30, 100))
          const list = result.markets.filter((row) => (!args?.kind || row.kind === args.kind)
            && (!category || (category === 'tradfi' ? tradfiTags.has(String(row.category ?? '').toLowerCase()) : String(row.category ?? '').toLowerCase() === category))
            && (!query || `${row.name} ${row.label} ${row.venue} ${row.category ?? ''}`.toLowerCase().includes(query)))
            .sort((a, b) => Number(b.ctx?.dayNtlVlm ?? 0) - Number(a.ctx?.dayNtlVlm ?? 0)).slice(0, limit)
          return { text: list.map((row) => `${row.label} [${row.kind}${row.category ? ',' + row.category : ''}${row.tradable ? '' : ',只读'}] mark=${row.ctx?.markPx ?? '?'} 24h量=${row.ctx?.dayNtlVlm ?? '?'}`).join('\n') || '没有匹配市场', markets: list, observedAt: result.ctxObservedAt ?? result.observedAt }
        }
        const coin = canonicalMarketCoin(args?.coin)
        if (!coin) throw new Error(`action=${action} 需要 coin`)
        if (action === 'book') {
          const snap = await remote.snapshot({ coin })
          const levels = (side) => (snap.book?.levels?.[side] ?? []).slice(0, 10).map((l) => ({ px: Number(l.px), sz: Number(l.sz) }))
          return { text: `${coin} 盘口\nbids: ${levels(0).map((l) => `${l.px}×${l.sz}`).join(' | ')}\nasks: ${levels(1).map((l) => `${l.px}×${l.sz}`).join(' | ')}`, book: snap.book }
        }
        if (action === 'candles') {
          const limit = Math.max(1, Math.min(Number(args?.limit) || 48, 200))
          const iv = args?.interval ?? '1h'
          // Paging back: ask for exactly the window that ends at endMs.
          const endMs = Number(args?.endMs) > 0 ? Number(args.endMs) : null
          const { candles } = await remote.candles(endMs ? { coin, interval: iv, endMs, startMs: endMs - (INTERVAL_MS[iv] ?? 3600e3) * (limit + 1) } : { coin, interval: iv })
          const tail = candles.filter((c) => !endMs || c.t < endMs).slice(-limit)
          return { text: tail.map((c) => new Date(c.t).toISOString().slice(5, 16) + ` O=${fmt(c.o)} H=${fmt(c.h)} L=${fmt(c.l)} C=${fmt(c.c)} V=${fmt(c.v, 3)}`).join('\n'), coin, interval: args?.interval ?? '1h', candles: tail }
        }
        if (action === 'indicators') {
          const interval = args?.interval ?? '1h'
          const { candles } = await remote.candles({ coin, interval })
          let session = null
          try { session = sessionIdOf(exec) } catch { /* not a trading session */ }
          const workspace = session && remote.store.getSession?.(session) ? remote.store.getSessionWorkspace(session) : null
          const settings = normalizeIndicatorSettings(workspace?.indicatorSettings)
          const closedWindow = closedCandles(candles, { interval })
          const closed = closedWindow.rows
          const studies = computeStudies(closed, settings)
          const configured = { settings, values: Object.fromEntries(Object.entries(studies).map(([key, rows]) => [key, rows.at(-1)?.time === Math.floor((closed.at(-1)?.t ?? 0) / 1000) ? rows.at(-1).value : null])), candlesUsed: closed.length, observedAt: closed.length ? closedWindow.closeTime(closed.at(-1)) : null }
          const indicators = computeIndicators(candles, { interval })
          if (!indicators.ready) return { text: `${coin} ${interval} 指标数据不足：${indicators.reason}；已排除 ${indicators.excludedOpen} 根未收盘 K 线`, indicators, configured }
          const ageMin = Math.max(0, Math.round((Date.now() - indicators.observedAt) / 60_000))
          const text = [
            `${coin} ${interval} · ${indicators.candlesUsed} 根已收盘 K 线 · 最新收盘 ${new Date(indicators.observedAt).toISOString()}（${ageMin} 分钟前） · 排除 ${indicators.excludedOpen} 根形成中 K 线`,
            `收盘=${fmt(indicators.close)} SMA20=${fmt(indicators.sma20)} EMA20=${fmt(indicators.ema20)} EMA50=${fmt(indicators.ema50)}`,
            '会话参数（已收盘）：' + studyDefinitions(settings).filter(([id]) => ['rsi14', 'macd', 'bollinger20', 'stochastic', 'adx', 'obv'].includes(id)).map(([, key, label]) => `${label}=${configured.values[key] == null ? '数据不足' : fmt(configured.values[key], 4)}`).join(' · '),
            `ATR14=${fmt(indicators.atr14)} 量比20=${fmt(indicators.volumeRatio20, 2)}`,
            `邻近支撑=${fmt(indicators.support.price)}（${new Date(indicators.support.time).toISOString()}） 阻力=${fmt(indicators.resistance.price)}（${new Date(indicators.resistance.time).toISOString()}）`,
          ]
          const requested = Array.isArray(args?.ma) ? normalizeMaLines(args.ma) : (session && remote.store.getSession?.(session) ? remote.store.getSessionWorkspace(session).maLines ?? [] : [])
          const ma = requested.length ? maLatest(closedCandles(candles, { interval }).rows, requested) : []
          if (ma.length) text.push('均线（最新已收盘）：' + ma.map((row) => `${row.label}=${row.value == null ? '数据不足' : fmt(row.value)}${row.line.smoothing ? `→平滑${fmt(row.smoothed)}` : ''}`).join('  '))
          text.push('指标是历史 K 线的派生值；需要结合最新盘口、账户风险和数据时效验证，不能单独当作下单信号。')
          return { text: text.join('\n'), configured, indicators: { ...indicators, rsi14: configured.values.rsi14, macd: { line: configured.values.macd, signal: configured.values.signal, histogram: configured.values.histogram }, bollinger20: { lower: configured.values.lower, middle: configured.values.basis, upper: configured.values.upper }, parameterSettings: settings }, ma, interval, coin }
        }
        if (action === 'trades') {
          const snap = await remote.snapshot({ coin })
          const list = (Array.isArray(snap.trades) ? snap.trades : []).slice(0, Math.max(1, Math.min(Number(args?.limit) || 20, 50)))
          return { text: list.map((t) => `${new Date(t.time).toISOString().slice(11, 19)} ${t.side} ${fmt(t.sz, 4)} @ ${fmt(t.px)}`).join('\n'), trades: list }
        }
        throw new Error(`未知 action: ${action}`)
      },
    },
    {
      name: 'hyper_chart',
      description: '在当前 DSH 交易会话的行情图上画或管理供人查看的水平支撑/阻力线、趋势线与均线，并切换图表周期与副图指标。action=view 设置周期(interval)并用 show/hide 开关指标（rsi14、macd、bollinger20、volume、atr14、vwap、stochastic、adx、obv 等，图上实时计算，不要自己算数值再画线）。kind=ma 在图上叠加一条按 K 线实时计算的均线：maType 支持 sma/ema/smma(平滑均线，即 RMA/Wilder)/wma，period 1-500，source 默认 close，可选 smoothingType+smoothingPeriod 再对均线做一次平滑（同 TradingView 均线指标的 Smoothing）；均线按会话保存，随周期切换重算，最多 8 条，add 会返回最新已收盘值。画线工具：level 水平线(price)、trend 趋势线(fromTime/fromPrice/toTime/toPrice)，其余用 points=[{time,price}]：hray 水平射线/vline 垂直线 1 点，ray 射线/extended 延长线/fib 斐波那契回撤(第 1 点=1、第 2 点=0)/rect 矩形/measure 价格区间 2 点，vprofile 固定范围成交量分布 2 点（只取两点的时间区间，返回 POC 与 70% 价值区 VAH/VAL），channel 平行通道 3 点（第 3 点定通道宽度），text 文本 1 点（label 为文本，最多 200 字），long/short 多空头寸 3 点 [入场, 止损, 止盈]（第 2 点时间为右边界）；fibext 斐波那契扩展 3 点(A→B 波段，自 C 投射)、fibchannel 斐波那契通道 3 点、fibtime 斐波那契时间周期 2 点、gannfan 江恩扇形 2 点(第 2 点定 1×1)、pitchfork 安德鲁叉子线 3 点、regression 回归趋势 2 点(时间区间)、arrow 箭头 2 点、callout 标注气泡 2 点(锚点+文本框位置，label 为文本)、circle 圆形 2 点(圆心+边缘)、triangle 三角形 3 点、brush 画笔 2-500 点；crossline 十字线、pricelabel 价格标签 1 点；infoline 信息线、trendangle 趋势角度、pricerange 价格区间、daterange 日期区间 2 点；elliott 推动浪 6 点(0-5)、elliottabc 调整浪 4 点(0-A-B-C)、xabcd 谐波 5 点、abcd 4 点、headshoulders 头肩 7 点(左底-左肩-颈1-头-颈2-右肩-右底)、gannbox/gannsquare 2 点对角、schiff/modschiff 叉子线 3 点、icon 图标 1 点(label 为 flag/star/up/down/warning/check/cross/fire/target/bell，或贴图库 emoji:📈/🚀/🐂/🐻/⚠️ 等)。update 按 id 修改 points/price/label 或样式 color/lineWidth(1-4)/lineStyle(solid/dashed/dotted)/locked。画线按会话和标的保存，在该标的所有周期显示。先用 hyper_market candles/indicators 验证价格和时间；标注仅用于解释，不是自动订单或交易信号。',
      parameters: {
        type: 'object', properties: {
          action: { type: 'string', enum: ['add', 'list', 'update', 'remove', 'view'], description: 'view：切换图表周期与副图指标' },
          show: { type: 'array', items: { type: 'string', enum: INDICATOR_IDS }, description: 'action=view：要显示的指标' },
          hide: { type: 'array', items: { type: 'string', enum: INDICATOR_IDS }, description: 'action=view：要隐藏的指标' },
          coin: { type: 'string', description: '默认会话绑定币对' },
          interval: { type: 'string', description: '默认当前交易台周期' },
          kind: { type: 'string', enum: [...DRAWING_KINDS, 'ma'], description: 'add 必填：画线类型或 ma 均线' },
          points: { type: 'array', description: `除 level（price）、trend（fromTime…toPrice）外各类型的锚点，按点击顺序。点数：${Object.entries(DRAWING_POINTS).filter(([kind]) => kind !== 'level' && kind !== 'trend').map(([kind, n]) => `${kind}=${n || (kind === 'path' || kind === 'polyline' || kind === 'ghostfeed' ? '2-50' : '2-500')}`).join(' ')}。long/short=[入场,止损,止盈]；${TEXT_KINDS.join('/')} 的文字放 label；avwap/avprofile 的唯一锚点是起算 K 线；barspattern=[源区间起点, 源区间终点, 粘贴位置（首根开盘价对齐此价）]；table 的 label 用 | 分隔单元格、; 或换行分隔行`, items: { type: 'object', properties: { time: { type: 'number', description: 'K 线时间 epoch ms' }, price: { type: 'number' } }, required: ['time', 'price'] } },
          maType: { type: 'string', enum: MA_KINDS, description: 'kind=ma：均线类型；smma 即平滑均线（RMA）' },
          period: { type: 'number', description: 'kind=ma：周期，1-500 的整数' },
          source: { type: 'string', enum: MA_SOURCES, description: 'kind=ma：价格源，默认 close' },
          smoothingType: { type: 'string', enum: MA_KINDS, description: 'kind=ma 可选：对均线再做一次平滑的类型' },
          smoothingPeriod: { type: 'number', description: 'kind=ma 可选：平滑周期' },
          color: { type: 'string', description: '可选 #RRGGBB 颜色（画线或均线）' },
          lineWidth: { type: 'number', description: '画线线宽 1-4' },
          visibleIntervals: { type: 'array', items: { type: 'string' }, description: '只在这些周期显示（如 ["4h","1d"]）；省略=所有周期' },
          fontSize: { type: 'number', description: 'kind=text/callout：字号 10-32' },
          screenX: { type: 'number', description: 'kind=anchoredtext/table：固定在屏幕的横向位置 0-1（与 screenY 同时给）' }, screenY: { type: 'number', description: '固定在屏幕的纵向位置 0-1' },
          unpin: { type: 'boolean', description: 'action=update：true 取消固定到屏幕，画线回到它保存的 points 时间与价格' },
          extendLeft: { type: 'boolean', description: 'kind=trend：向左延长' }, extendRight: { type: 'boolean', description: 'kind=trend：向右延长' },
          bold: { type: 'boolean', description: 'kind=text/callout：粗体' }, italic: { type: 'boolean', description: 'kind=text/callout：斜体' },
          fillOpacity: { type: 'number', description: '矩形/圆/三角形/通道/斐波那契/区间等的背景填充透明度 0-0.6（0=无填充）' },
          levels: { type: 'array', items: { type: 'number' }, description: 'kind=fib/fibext/fibchannel：自定义斐波那契层级，如 [0,0.382,0.5,0.618,1,1.618]' },
          rows: { type: 'number', description: 'kind=vprofile：价格行数 6-200，默认 48' },
          valueArea: { type: 'number', description: 'kind=vprofile：价值区成交量占比 0.5-0.95，默认 0.7' },
          lineStyle: { type: 'string', enum: ['solid', 'dashed', 'dotted'], description: '画线线型' },
          locked: { type: 'boolean', description: 'update：锁定后用户不能误拖动' },
          hidden: { type: 'boolean', description: 'update：在图上隐藏（保留在画线列表中）' },
          shared: { type: 'boolean', description: '同步到该币种的所有交易会话' },
          alert: { type: 'boolean', description: '价格穿越提醒（level/hray/trend/ray/extended），触发一次后自动关闭' },
          role: { type: 'string', enum: ['support', 'resistance', 'neutral'], description: '视觉语义' },
          label: { type: 'string', description: '图上展示的短标签，1-60 字' },
          price: { type: 'number', description: '水平线价格' },
          fromTime: { type: 'number', description: '趋势线起点 K 线时间，epoch ms' },
          fromPrice: { type: 'number', description: '趋势线起点价格' },
          toTime: { type: 'number', description: '趋势线终点 K 线时间，epoch ms' },
          toPrice: { type: 'number', description: '趋势线终点价格' },
          id: { type: 'string', description: 'remove 时使用 list 返回的标注或均线 ID' },
        }, required: ['action'], additionalProperties: false,
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: v.text }] },
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        remote.requireTradingSession(sessionId)
        const coin = canonicalMarketCoin(args?.coin ?? remote.store.getSession(sessionId)?.coin ?? remote.desk.coin)
        const interval = args?.interval ?? remote.store.getSessionWorkspace?.(sessionId)?.interval ?? remote.desk.interval
        const maLines = () => remote.store.getSessionWorkspace?.(sessionId)?.maLines ?? []
        const maValues = async (lines) => {
          if (!lines.length) return []
          const { candles } = await remote.candles({ coin, interval })
          return maLatest(closedCandles(candles, { interval }).rows, lines)
        }
        const maText = (row) => `${row.id} ${row.label} = ${row.value == null ? '数据不足' : fmt(row.value)}${row.line.smoothing ? `，平滑 = ${row.smoothed == null ? '数据不足' : fmt(row.smoothed)}` : ''}`
        if (args?.action === 'list') {
          const result = await remote.chartMarks({ sessionId, coin, allIntervals: true })
          const ma = await maValues(maLines())
          const lines = [...result.marks.map((mark) => `${mark.id} ${mark.interval} ${mark.kind} ${mark.role} ${mark.label}`), ...ma.map((row) => `${maText(row)}（${coin} ${interval} 最新已收盘）`)]
          return { text: lines.length ? lines.join('\n') : '当前标的没有标注或均线', ...result, maLines: ma }
        }
        if (args?.action === 'view') {
          const view = remote.setSessionChartView(sessionId, { interval: args?.interval, show: args?.show ?? [], hide: args?.hide ?? [] })
          return { text: `图表周期 ${view.interval}，显示指标：${view.indicators.join(', ') || '无'}`, interval: view.interval, indicators: view.indicators }
        }
        if (args?.action === 'add' && args?.kind === 'ma') {
          const line = normalizeMaLine({ kind: args.maType, period: args.period, source: args.source, color: args.color,
            smoothing: args.smoothingType != null || args.smoothingPeriod != null ? { kind: args.smoothingType, period: args.smoothingPeriod } : null })
          const next = remote.setSessionMaLines(sessionId, [...maLines().filter((row) => row.id !== line.id), line])
          const [row] = await maValues([next.find((item) => item.id === line.id)])
          return { text: `已在 ${coin} 图表叠加均线 ${maText(row)}（${interval} 最新已收盘），切换周期会自动重算。`, line: row.line, value: row.value, smoothed: row.smoothed }
        }
        if (args?.action === 'remove' && maLines().some((row) => row.id === args?.id)) {
          const removed = maLines().find((row) => row.id === args.id)
          remote.setSessionMaLines(sessionId, maLines().filter((row) => row.id !== args.id))
          return { text: `已移除均线：${maLabel(removed)}（${removed.id}）`, line: removed }
        }
        if (args?.action === 'update') {
          const patch = Object.fromEntries(['points', 'price', 'fromTime', 'fromPrice', 'toTime', 'toPrice', 'label', 'color', 'lineWidth', 'lineStyle', 'locked', 'hidden', 'shared', 'alert', 'rows', 'valueArea', 'levels', 'visibleIntervals', 'fontSize', 'fillOpacity', 'bold', 'italic', 'extendLeft', 'extendRight', 'screenX', 'screenY'].filter((key) => args?.[key] != null).map((key) => [key, args[key]]))
          if (args?.unpin === true) { patch.screenX = null; patch.screenY = null }
          const mark = remote.editChartMark(args?.id, patch, sessionId)
          return { text: `已更新${DRAWING_NAMES[mark.kind] ?? mark.kind}：${mark.label}（${mark.id}）`, mark }
        }
        if (args?.action === 'add') {
          // Fetch the range first: a failed market request must not leave a saved drawing behind.
          let summary = null
          if (args?.kind === 'vprofile') {
            // Validate rows / valueArea before they size any computation.
            drawingStyle({ kind: 'vprofile', rows: args?.rows, valueArea: args?.valueArea })
            const times = (Array.isArray(args?.points) ? args.points : []).map((point) => Number(point?.time)).filter(Number.isFinite).sort((x, y) => x - y)
            if (times.length === 2) {
              const { candles } = await remote.candles({ coin, interval, startMs: times[0], endMs: times[1] + 1 })
              const inRange = candles.filter((c) => c.t >= times[0] && c.t <= times[1])
              const profile = volumeProfile(inRange.map((c) => ({ open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v })), { rows: Number(args?.rows) || 48, valueArea: Number(args?.valueArea) || 0.7 })
              const step = INTERVAL_MS[interval] ?? (inRange.length > 1 ? inRange[1].t - inRange[0].t : 0)
              const partial = !inRange.length || (step > 0 && inRange[0].t - times[0] >= step)
              summary = { profile, partial, bars: inRange.length, from: inRange[0]?.t ?? null }
            }
          }
          const mark = remote.addChartMark({ ...args, coin, interval }, sessionId)
          const text = `已在 ${coin} ${interval} 图表添加${DRAWING_NAMES[mark.kind] ?? mark.kind}：${mark.label}（${mark.id}）`
          if (!summary) return { text, mark }
          if (!summary.profile) return { text: `${text}；区间内没有成交量数据，无法统计成交量分布`, mark }
          const { profile } = summary
          const note = `按 ${summary.bars} 根 ${interval} K 线估算（每根成交量均匀分摊到其高低区间）${summary.partial ? `；交易所只返回 ${new Date(summary.from).toISOString().slice(0, 16)} 之后的 K 线，区间前段缺失` : ''}`
          return { text: `${text}；POC=${fmt(profile.poc)} 价值区 VAH=${fmt(profile.vah)} VAL=${fmt(profile.val)}（${Math.round((Number(args?.valueArea) || 0.7) * 100)}% 成交量）；${note}`, mark, profile: { poc: profile.poc, vah: profile.vah, val: profile.val, bars: summary.bars, partial: summary.partial } }
        }
        if (args?.action === 'remove') {
          const mark = remote.removeChartMark(args?.id, sessionId)
          return { text: `已删除图表标注：${mark.label}（${mark.id}）`, mark }
        }
        throw new Error(`未知 action: ${args?.action}`)
      },
    },
    {
      name: 'hyper_account',
      description: '查询交易账户。action=state 返回权益/持仓；orders 返回挂单；fills 返回成交；orderStatus 用 oid 或 cloid 核对某笔 live 订单，尤其在网络超时后。review 返回最近 7/30/90 天成交复盘、订单数量核对、费用和资金费覆盖缺口；不是完整账户收益率。' +
        'action=analyze 交易体检（默认 90 天）：按完整往返统计胜率、盈亏比、期望、持仓时长、按币种/时段/星期的表现、手续费与资金费，并给出按金额排序的习惯问题和建议规则——第一次见面或用户问“我做得怎么样”时用它，不要自己从成交里手算。' +
        'action=limits 修改允许币对（addCoins/removeCoins；addCoins ["*"] 表示允许全部币对）与单笔/每日/仓位/杠杆上限——仅全托管模式可用，半托管时由用户在 设置 → 交易限额与签名规则 修改。' +
        'action=transfer 在自己的任意两个账户之间划转 USDC：from / to 取 spot（现货）、perp（主永续）或 HIP-3 交易所名（如 xyz），amount 为数量；spot↔perp、perp↔HIP-3 一步完成，spot↔HIP-3 与 HIP-3↔HIP-3 自动经 perp 两步完成（只需批准一次）。下单前永续保证金不足而现货有 USDC 时，先 spot→perp。统一账户 / 组合保证金模式无需 spot↔perp 划转。全托管直接执行，半托管每次需用户批准；仅 live，需交易主钱包签名。旧参数 dex + direction（in/out）仍可用。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['state', 'orders', 'fills', 'orderStatus', 'review', 'analyze', 'limits', 'transfer'], description: '账户动作，默认 state' },
          addCoins: { type: 'array', items: { type: 'string' }, description: 'action=limits：加入允许币对，如 ["xyz:XYZ100"]' },
          removeCoins: { type: 'array', items: { type: 'string' }, description: 'action=limits：移出允许币对' },
          maxOrderUsd: { type: 'number' }, maxDailyUsd: { type: 'number' }, maxPositionUsd: { type: 'number' }, maxLeverage: { type: 'number' },
          from: { type: 'string', description: 'action=transfer：转出账户，spot / perp / HIP-3 交易所名' },
          to: { type: 'string', description: 'action=transfer：转入账户，spot / perp / HIP-3 交易所名' },
          dex: { type: 'string', description: 'action=transfer（旧写法）：HIP-3 交易所名，配合 direction' },
          amount: { type: 'number', description: 'action=transfer：USDC 数量' },
          direction: { type: 'string', enum: ['in', 'out'], description: 'action=transfer（旧写法）：in=主永续转入 dex（默认），out=转回主永续' },
          oid: { type: 'string', description: 'orderStatus 必填；交易所 oid 或 0x 开头 128 位 cloid' },
          days: { type: 'number', enum: [7, 30, 90], description: 'review 窗口，默认 30 天' },
          coin: { type: 'string', description: 'review 可选，仅核对该标的；省略为全部' },
        },
        additionalProperties: false,
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: v.text }] },
      timeoutMs: 60_000,
      async execute(args, exec) {
        const action = args?.action ?? 'state'
        if (action === 'analyze') {
          const days = args?.days ?? 90
          if (![7, 30, 90].includes(days)) throw Error('交易体检支持最近 7/30/90 天')
          const evidence = await remote.tradeHistory({ includeFunding: true, days })
          const fills = args?.coin ? (evidence.fills ?? []).filter((row) => row.coin === canonicalMarketCoin(args.coin)) : evidence.fills
          const funding = evidence.coverage?.fundingStatus === 'complete' ? evidence.funding : null
          const result = analyzeTrading(fills, { funding, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai' })
          const limited = evidence.coverage?.fillsLimited ? '（交易所只返回最近 2000 笔成交，更早的未计入）' : ''
          return { text: checkupText(result, { days, mode: `${evidence.mode}/${evidence.network}` }) + limited, ...result, coverage: { ...result.coverage, ...evidence.coverage } }
        }
        if (action === 'limits') {
          const { before, after } = remote.agentUpdateRiskSettings(args)
          const diff = Object.keys(after).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
          return { text: diff.length ? `已更新交易限额：${diff.map((key) => `${key} ${JSON.stringify(before[key])} → ${JSON.stringify(after[key])}`).join('；')}` : '交易限额未变化', before, after }
        }
        if (action === 'transfer') {
          const res = await remote.transferCollateral(args, exec)
          const name = (value) => value === 'spot' ? '现货账户' : value === 'perp' ? '主永续账户' : value
          return { text: `已划转 ${res.amount} USDC：${[res.from, ...res.legs.map((leg) => leg.to)].map(name).join(' → ')}${res.legs.length > 1 ? '（两步）' : ''}`, ...res }
        }
        if (action === 'state') {
          const a = await remote.account({ coin: remote.desk?.coin })
          const lines = [`mode=${a.mode}${a.address ? ' ' + a.address : ''}${a.accountDex ? ` DEX=${a.accountDex}` : ''}${a.positionsCoverage ? ` positions=${a.positionsCoverage}` : ''}`]
          if (a.mode === 'paper') lines.push(`现金=${fmt(a.usd)} 权益=${fmt(a.equity)} 已用保证金=${fmt(a.marginUsed)} 可用保证金=${fmt(a.availableMargin)} uPnL=${fmt(a.uPnl)}；${a.simulation}`)
          else if (a.balanceSource === 'spot') lines.push(`账户模式=${a.accountMode} USDC余额=${fmt(a.usdcBalance)} 未占用=${fmt(a.unheldUsdc)}${a.tradeCapacity ? ` ${a.tradeCapacity.coin}可交易名义额=${fmt(Math.min(...a.tradeCapacity.availableToTrade.map(Number)))}` : ''}`)
          else if (a.marginSummary) lines.push(`账户模式=${a.accountMode} 账户价值=${fmt(a.marginSummary.accountValue)} 可用=${fmt(a.withdrawable)}`)
          for (const p of a.positions) {
            const leverage = typeof p.leverage === 'number' ? p.leverage : Number(p.leverage?.value ?? p.leverage?.leverage)
            lines.push(`${p.coin} ${p.size > 0 ? 'LONG' : 'SHORT'} sz=${fmt(Math.abs(p.size), 4)} entry=${fmt(p.entryPx)} mark=${fmt(p.markPx)} uPnL=${fmt(p.uPnl)}` +
              `${Number.isFinite(leverage) && leverage > 0 ? ` lev=${leverage}x` : ''}` +
              `${p.returnOnEquity == null ? '' : ` ROE=${fmt(Number(p.returnOnEquity) * 100)}%`}` +
              `${p.liquidationPx == null ? '' : ` liq=${fmt(p.liquidationPx)}`}` +
              `${p.marginUsed == null ? '' : ` margin=${fmt(p.marginUsed)}`}`)
          }
          if (a.positions.length === 0) lines.push('（无持仓）')
          return { text: lines.join('\n'), account: a }
        }
        if (action === 'orders') {
          const o = await remote.orders()
          const rows = o.orders ?? []
          return { text: rows.length ? rows.map((r) => `${r.coin} ${r.side ?? ''} ${fmt(r.origSz ?? r.sz, 4)} @ ${fmt(r.limitPx ?? r.px)} oid=${r.oid}`).join('\n') : '（无挂单）', orders: rows }
        }
        if (action === 'fills') {
          const f = await remote.fills()
          const rows = f.fills ?? []
          return { text: rows.length ? rows.slice(0, 20).map((r) => `${new Date(r.time ?? r.filledTime ?? Date.now()).toISOString().slice(5, 19)} ${r.coin} ${r.side ?? ''} ${fmt(r.sz ?? r.filledSz, 4)} @ ${fmt(r.px ?? r.filledPx)}`).join('\n') : '（无成交）', fills: rows.slice(0, 50) }
        }
        if (action === 'review') {
          const days = args?.days ?? 30
          if (![7, 30, 90].includes(days)) throw Error('复盘支持最近 7/30/90 天')
          const evidence = await remote.tradeHistory({ includeFunding: true, days })
          const review = reviewLedger(evidence, args?.coin ? canonicalMarketCoin(args.coin) : '')
          return { text: `窗口复盘（不是账户收益率）：${JSON.stringify({ coverage: evidence.coverage, mode: evidence.mode, network: evidence.network, ...review })}`, evidence, review }
        }
        if (action === 'orderStatus') {
          const result = await remote.orderStatus({ oid: args?.oid })
          return { text: JSON.stringify(result), ...result }
        }
        throw new Error(`未知 action: ${action}`)
      },
    },
    {
      name: 'hyper_decide',
      description: '对一个 live 交易意图做服务端预检：读取实时价格、账户权益和仓位，执行币对/单笔/每日/仓位/杠杆硬限制，并生成 30 秒、仅本会话可用的一次性 decisionId。可选 takeProfitPx/stopLossPx 会随主单作为 normalTpsl 分组保护单提交（目前仅 testnet；mainnet 传入会被拒绝）；父单未完全成交时保护单尚未挂出，部分成交后撤销父单会撤销子单，必须核对真实仓位与保护挂单。paper 暂不支持触发单。先独立分析行情与风险，再提交方向、数量和依据；预检通过不等于交易所已成交。',
      parameters: {
        type: 'object',
        properties: {
          coin: { type: 'string' }, isBuy: { type: 'boolean' }, sz: { type: 'number' },
          type: { type: 'string', enum: ['market', 'limit'] }, px: { type: 'number' },
          tif: { type: 'string', enum: ['Gtc', 'Alo'] }, reduceOnly: { type: 'boolean' },
          takeProfitPx: { type: 'number', description: '可选止盈触发价；与 hyper_order 完全一致' },
          stopLossPx: { type: 'number', description: '可选止损触发价；与 hyper_order 完全一致' },
          thesis: { type: 'string', description: '交易依据、反证条件与风险，10-1000 字' },
        },
        required: ['coin', 'isBuy', 'sz', 'thesis'], additionalProperties: false,
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: v.text }] },
      timeoutMs: 20_000,
      async execute(args, exec) {
        const result = await remote.prepareOrder(args, sessionIdOf(exec))
        return { text: `交易预检通过：${result.side} ${result.coin}，价格=${fmt(result.mid)}，风险估值=${fmt(result.notionalUsd)} USD，当前仓位=${fmt(result.positionSize, 6)}，执行后仓位=${fmt(result.nextSize, 6)}。decisionId=${result.decisionId}（30 秒内一次性使用）。`, ...result }
      },
    },
    {
      name: 'hyper_order',
      description:
        '交易下单/撤单/杠杆。action=place：paper 直接执行；live 必须先调用 hyper_decide 并提供同一订单的一次性 decisionId。live 可带 takeProfitPx/stopLossPx（目前仅 testnet），必须与预检完全一致，作为 normalTpsl 分组保护单提交；父单未完全成交时保护单尚未挂出，部分成交后撤销父单会撤销子单，提交后须核对仓位与实际保护挂单。全托管模式下 live 直接执行（仍受钱包策略约束），半托管触发人工审批。' +
        'action=cancel 撤单（oid）；action=leverage 设置杠杆（1-50）。半托管时 live 下单、撤单和杠杆变更需人工审批；全托管时直接执行，但仍受 dsh-web3 钱包策略约束。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['place', 'cancel', 'leverage'], description: '交易动作' },
          coin: { type: 'string', description: '合约名，如 BTC' },
          isBuy: { type: 'boolean', description: 'true=买入/做多，false=卖出/做空（place 必填）' },
          sz: { type: 'number', description: '数量（币本位，如 0.5 BTC）（place 必填）' },
          type: { type: 'string', enum: ['market', 'limit'], description: '订单类型，默认 market' },
          px: { type: 'number', description: '限价单价格（type=limit 必填）' },
          tif: { type: 'string', enum: ['Gtc', 'Alo'], description: '限价单时效，默认 Gtc' },
          reduceOnly: { type: 'boolean', description: '只减仓，默认 false' },
          takeProfitPx: { type: 'number', description: '可选止盈触发价；paper 不支持' },
          stopLossPx: { type: 'number', description: '可选止损触发价；paper 不支持' },
          decisionId: { type: 'string', description: 'hyper_decide 返回的本会话一次性决策 ID（live 必填）' },
          reason: { type: 'string', description: 'paper 下单原因，10-1000 字；live 使用 hyper_decide.thesis' },
          oid: { type: 'number', description: '撤单的订单 id（cancel 必填）' },
          leverage: { type: 'number', description: '杠杆倍数 1-50（leverage 必填）' },
          marginMode: { type: 'string', enum: ['cross', 'isolated'], description: '保证金模式，默认 cross' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: v.text }] },
      timeoutMs: 30_000,
      async execute(args, exec) {
        const action = args?.action
        const sessionId = sessionIdOf(exec)
        if (action === 'place') {
          const coin = canonicalMarketCoin(args?.coin)
          if (!coin) throw new Error('place 需要 coin')
          if (typeof args?.isBuy !== 'boolean') throw new Error('place 需要明确的 isBuy')
          const isBuy = args.isBuy
          const sz = Number(args?.sz)
          const type = args?.type === 'limit' ? 'limit' : 'market'
          const reason = String(args?.reason ?? '').trim()
          if (remote.cfg.tradingMode === 'paper' && (reason.length < 10 || reason.length > 1000)) throw new Error('paper 下单需要 10-1000 字的原因')
          const summary = `${shortSide(isBuy)} ${fmt(sz, 6)} ${coin} @ ${type === 'limit' ? fmt(args?.px) + ' (limit)' : '市价'}${args?.reduceOnly ? ' [只减仓]' : ''} · 会话=${sessionId ?? '未知'}`
          const res = await remote.executeToolOrder({
            coin, isBuy, sz, type, px: args?.px, tif: args?.tif, reduceOnly: args?.reduceOnly,
            takeProfitPx: args?.takeProfitPx, stopLossPx: args?.stopLossPx, decisionId: args?.decisionId,
            reason,
          }, exec, sessionId)
          if (res.mode === 'paper') {
            const f = res.fill
            return {
              text: `✅ paper 成交 ${shortSide(f.isBuy)} ${fmt(f.sz, 6)} ${f.coin} @ ${fmt(f.px)}（名义=${fmt(f.notional)}，实现盈亏=${fmt(f.realized)}）。中间台已同步。`,
              fill: f,
            }
          }
          const statuses = res.response?.response?.data?.statuses ?? []
          const protectionNote = res.protectionState === 'parent-not-fully-filled'
            ? '\n⚠ 父单未确认完全成交，止盈止损尚不能视为生效；立即核对实际仓位和保护挂单。'
            : res.protectionState === 'verify-active'
              ? '\n止盈止损已随完整成交父单提交；仍需核对实际保护挂单。' : ''
          return { text: `live 订单已提交：${summary}\n交易所回执: ${JSON.stringify(statuses).slice(0, 400)}${protectionNote}`, response: res.response, cloid: res.cloid, protectionState: res.protectionState }
        }
        if (action === 'cancel') {
          const res = await remote.executeToolCancel({ coin: args?.coin, oid: args?.oid }, exec)
          return { text: `撤单已提交（${args?.coin} oid=${args?.oid}）: ${JSON.stringify(res.response).slice(0, 300)}` }
        }
        if (action === 'leverage') {
          const res = await remote.executeToolLeverage({ coin: args?.coin, leverage: args?.leverage, marginMode: args?.marginMode }, exec)
          return { text: `杠杆设置已提交：${args?.coin} = ${args?.leverage}x (${args?.marginMode ?? 'cross'})${res.mode === 'paper' ? '（paper 本地生效）' : ''}`, response: res.response ?? null }
        }
        throw new Error(`未知 action: ${action}`)
      },
    },
    {
      name: 'hyper_session',
      description:
        '交易会话上下文。action=status 返回本会话绑定的币对与当前交易台显示状态（用户正在看什么）；action=bind 把用户在中间台选中的币对与本会话绑定。' +
        '对话中引用"当前界面/当前币"时先调它同步视角。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'bind'], description: '会话动作，默认 status' },
          coin: { type: 'string', description: 'action=bind 时绑定 action=catalog 返回的官方合约名，如 xyz:XYZ100' },
        },
        additionalProperties: false,
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: v.text }] },
      timeoutMs: 10_000,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        const action = args?.action ?? 'status'
        if (action === 'bind') {
          const coin = canonicalMarketCoin(args?.coin)
          if (!coin) throw new Error('bind 需要 coin')
          // The desk follows the agent's bind: one desk, one focus.
          await remote.deskState({ coin }).catch(() => {})
          const row = sessionId
            ? remote.store.registerSession(sessionId, { coin })
            : { coin }
          return { text: `本会话交易视角已绑定到 ${coin}${sessionId ? '（交易台已跟随）' : ''}`, session: row }
        }
        const row = sessionId ? remote.store.getSession(sessionId) : null
        const st = await remote.status()
        const desk = st.desk ?? remote.desk ?? {}
        const lines = [`mode=${st.tradingMode} network=${st.network}${st.address ? ' ' + st.address : ''}`]
        if (desk.coin) lines.push(`交易台当前焦点: ${desk.coin} · K线 ${desk.interval ?? '15m'}`)
        if (row) lines.push(`本会话绑定币对: ${row.coin}`)
        else lines.push('本会话尚未绑定币对（可用 action=bind 绑定，或让用户在中间台选择）')
        return { text: lines.join('\n'), session: row, status: st }
      },
    },
    {
      name: 'hyper_journal',
      description:
        '交易员日志（跨会话、重启保留，摘要会自动出现在每个会话的系统提示里）。action=read 读取交易员档案、策略库（含按 paper/live 分开统计的笔数、胜率、期望 R）、最近教训与记录；' +
        'action=profile 用 fields 更新档案（如 {"风险偏好":"单笔最多亏 1%","持仓周期":"日内到 3 天","打扰偏好":"只在需要决策时提醒"}，null 删除字段）；' +
        'action=strategy 新建或修订策略（不传 id 为新建，至少 name+thesis；修订必须传 why 说明改动原因，版本号自动递增），action=removeStrategy 删除；' +
        'action=log 追加记录：type=plan 交易计划 / trade 已平仓结果（必须 resultR=盈亏÷计划风险）/ review 复盘 / lesson 可复用的教训 / note 其他，可关联 strategyId 与 coin。' +
        '用户表达偏好、纠正你、或一笔交易结束时就写入，不要等用户要求。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['read', 'profile', 'strategy', 'removeStrategy', 'log'], description: '默认 read' },
          fields: { type: 'object', additionalProperties: true, description: 'action=profile：{字段: 内容 | null}' },
          id: { type: 'string', description: 'strategy 修订 / removeStrategy 的策略 id' },
          name: { type: 'string' }, markets: { type: 'string', description: '适用市场，如 BTC,ETH,xyz:XYZ100' }, timeframe: { type: 'string', description: '周期，如 4h 结构 + 15m 入场' },
          thesis: { type: 'string', description: '为什么能赚钱：市场行为与优势来源' }, entry: { type: 'string', description: '入场条件（可核对的）' },
          exit: { type: 'string', description: '止盈与离场规则' }, invalidation: { type: 'string', description: '止损与作废条件' },
          sizing: { type: 'string', description: '仓位与风险规则，如 单笔风险 0.5% 权益' }, notes: { type: 'string' },
          status: { type: 'string', enum: ['idea', 'testing', 'active', 'paused', 'retired'] },
          why: { type: 'string', description: '修订策略时必填：依据哪些交易或复盘做了什么改动' },
          type: { type: 'string', enum: ['plan', 'trade', 'review', 'lesson', 'note'], description: 'action=log 的记录类型' },
          text: { type: 'string', description: 'action=log 的内容' }, coin: { type: 'string' }, strategyId: { type: 'string' },
          strategyVersion: { type: 'integer', minimum: 1, description: 'action=log：默认当前策略版本；修订前的交易平仓时填原版本，战绩按版本分别统计' },
          resultR: { type: 'number', description: 'type=trade：结果的 R 倍数（亏损为负）' }, pnlUsd: { type: 'number', description: 'type=trade：可选，实际盈亏 USD' },
        },
        additionalProperties: false,
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: v.text }] },
      timeoutMs: 10_000,
      async execute(args, exec) {
        const action = args?.action ?? 'read'
        let sessionId = null
        try { sessionId = sessionIdOf(exec) } catch { /* journal is not bound to a trading session */ }
        let journal = remote.store.journal()
        if (action === 'read') {
          const digest = journalDigest(journal)
          const text = [
            Object.keys(digest.profile).length ? '档案：' + Object.entries(digest.profile).map(([k, v]) => `${k}=${v}`).join('；') : '档案：空（与用户交流时逐步记录偏好）',
            digest.strategies.length ? '策略：\n' + digest.strategies.map((row) => `[${row.id}] ${row.name} ${row.status} v${row.version} ${row.markets ?? ''} ${row.timeframe ?? ''}\n  依据：${row.thesis}${row.entry ? `\n  入场：${row.entry}` : ''}${row.exit ? `\n  离场：${row.exit}` : ''}${row.invalidation ? `\n  作废：${row.invalidation}` : ''}${row.sizing ? `\n  仓位：${row.sizing}` : ''}\n  战绩：${Object.entries(row.stats).map(([mode, s]) => `${mode} ${s.trades}笔 胜率${Math.round(s.winRate * 100)}% 期望${fmt(s.expectancyR, 2)}R 最差${fmt(s.worstR, 2)}R`).join('；') || '暂无已平仓记录'}`).join('\n') : '策略：空',
            digest.lessons.length ? '教训：' + digest.lessons.map((entry) => entry.text).join('；') : '',
            digest.recent.length ? '最近记录：\n' + digest.recent.map((entry) => `${new Date(entry.at).toISOString().slice(0, 16)} ${entry.type}${entry.coin ? ' ' + entry.coin : ''}${entry.strategyId ? ' [' + entry.strategyId + ']' : ''}${entry.resultR != null ? ' ' + fmt(entry.resultR, 2) + 'R' : ''} ${entry.text.slice(0, 160)}`).join('\n') : '',
          ].filter(Boolean).join('\n')
          return { text, ...digest }
        }
        if (action === 'profile') {
          journal = remote.store.saveJournal(updateProfile(journal, args?.fields))
          return { text: `已更新交易员档案：${Object.keys(args?.fields ?? {}).join('、')}`, profile: journalDigest(journal).profile }
        }
        if (action === 'strategy') {
          const result = upsertStrategy(journal, args)
          remote.store.saveJournal(result.journal)
          return { text: `${result.strategy.version === 1 ? '已新建' : '已修订'}策略 [${result.strategy.id}] ${result.strategy.name}（${result.strategy.status}，v${result.strategy.version}）`, strategy: result.strategy }
        }
        if (action === 'removeStrategy') {
          remote.store.saveJournal(removeStrategy(journal, String(args?.id ?? '')))
          return { text: `已删除策略 ${args?.id}` }
        }
        if (action === 'log') {
          const result = addEntry(journal, args, { mode: remote.cfg.tradingMode, network: remote.cfg.network, sessionId: sessionId ?? undefined })
          remote.store.saveJournal(result.journal)
          return { text: `已记录 ${result.entry.type}${result.entry.resultR != null ? ` ${fmt(result.entry.resultR, 2)}R` : ''}`, entry: result.entry }
        }
        throw new Error(`未知 action: ${action}`)
      },
    },
  ]
}
