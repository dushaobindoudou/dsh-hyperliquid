# dsh-hyperliquid

[![npm](https://img.shields.io/npm/v/dsh-hyperliquid.svg)](https://www.npmjs.com/package/dsh-hyperliquid)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](#license)

[中文](README.zh-CN.md) · [npm](https://www.npmjs.com/package/dsh-hyperliquid) · [Changelog](CHANGELOG.md)

A Hyperliquid trading desk that runs inside [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) as a peer-level main-panel app:

- **Left column · trading sessions**: each session is a real DSH session that remembers its own coin, interval, indicators, drawings and layout.
- **Middle column · market workbench**: contract stats, candles (TradingView Lightweight Charts), funding history, order book & trades, positions / open orders / history.
- **Right column · native conversation**: the DSH native chat is embedded directly. Market analysis, risk checks and order placement all go through the agent's `hyper_*` tools; the trade ticket only hands structured intent into the conversation.

> ⚠️ **The plugin connects to Hyperliquid mainnet and runs in live mode by default — real funds.** Switch to testnet or paper mode in the top-right trading settings before your first run, and review the trading limits below.

## Requirements

- DSH **0.2 or newer** (the embedded native conversation needs session references and the Conversation Factory interface)
- Node.js 22.12+ (the DSH host runtime)
- Live trading needs a signing wallet: the [dsh-web3](https://www.npmjs.com/package/dsh-web3) vault (recommended) or a plugin-local private key

## Install

```bash
dsh plugin --profile web add dsh-hyperliquid
```

The package is a dsh bundle (`dsh.bundle.patch` + `dsh.client`). After installing, open "Hyperliquid 交易台" in the sidebar. Restart the DSH host after changing plugin config.

## Quick start: configure a live wallet

dsh-web3 signing is recommended: the private key never leaves your local encrypted vault, and every signature passes the wallet's signing policy and approvals.

```bash
dsh plugin --profile web add dsh-web3
```

Create or import an account under DSH Settings → Web3 Wallet, then configure this plugin in the profile's `cordis.patch.yml`:

```yaml
- id: hyperliquid
  config:
    network: mainnet          # or testnet
    tradingMode: live         # or paper
    signer: web3
    web3Account: hyper-agent  # a dsh-web3 account id or name
    tradingAddress: '0x your Hyperliquid main account address'
    allowedCoins: BTC,ETH
    maxOrderUsd: 100
    maxDailyUsd: 500
    maxPositionUsd: 500
    maxLeverage: 2
```

Create a dedicated Hyperliquid **API wallet** (agent wallet) for the desk and put the funded main account into `tradingAddress`; positions and open orders are always queried against the main account.

## Usage

- **Trading settings**: the top-right gear switches mainnet / testnet and live / paper, moves the order book / trades panel, and edits the allowed coins, per-order / daily / position limits and max leverage. Limits apply to paper and live immediately and survive restarts; "restore plugin config" clears UI overrides. Network and mode switches live only inside the current host process and revert on restart; switching to mainnet live requires confirmation.
- **Wallet & PnL**: the top-bar wallet shows address, balances, equity and PnL. Live PnL curves come from Hyperliquid's official portfolio data; paper mode shows local realized and unrealized PnL.
- **Candles**: all 14 exchange intervals, plus volume, SMA20, MA60, EMA20/50, Bollinger bands, RSI, MACD, ATR14 and a UTC intraday VWAP. Chart type switches between candles, bars, line, area and Heikin-Ashi per session (Heikin-Ashi changes display only — all price references use raw OHLC). Dragging left loads older history up to the exchange's last 5000 bars. Clicking a candle, volume bar or indicator line inserts a reference tag into the input (e.g. `BTC 15m 10-15 13:45 · C 81397`); sending expands it into full OHLC/volume/indicator data for that bar. The "indicators" menu can also overlay up to 8 configurable moving averages: SMA / EMA / SMMA (smoothed MA, TradingView's RMA) / WMA, periods 1–500, price sources close / open / high / low / hl2 / hlc3 / ohlc4, with optional smoothing (dashed), matching TradingView Pine; the agent can draw MAs onto the chart with `hyper_chart`.
- **Navigation & export**: below the chart — last 1/5/30 days, fit all loaded data, jump to a local-time date, or back to the latest bar; missing history is fetched automatically with a notice at the data boundary. The export menu saves a PNG with drawings and indicators, or a CSV of the loaded OHLCV (UTC). Indicator legends and volume follow the crosshair; VWAP uses the HLC3 volume-weighted price reset daily at UTC and hides incomplete first days.
- **Drawing tools**: the toolbar "draw" menu offers 78 TradingView-style tools (searchable at the top) — lines: trend, ray, extended, info (change / bars / duration / angle), trend angle, horizontal, horizontal ray, crossline, vertical; channels: parallel, Andrew's pitchfork, Schiff & modified Schiff, regression (least squares ±2σ), fixed-range volume profile (POC and value area VAH/VAL, adjustable rows and value-area ratio; Fibonacci retracement / extension / channel levels are editable on a floating toolbar; estimated from candles, auto-loads older history when needed); Fibonacci & Gann: retracement, trend-based fib extension, fib channel, fib time zones, Gann box, Gann square, Gann fan; patterns: Elliott impulse (0-5) and correction (A-B-C), XABCD harmonic & ABCD (ratios auto-labeled), head & shoulders (with neckline); shapes: rectangle, circle, triangle, brush; annotations: text, callout, price label, arrow, icon; measurement & positions: price range, date range, date & price range, long / short position (TP defaults to 2R, R:R shown). Recent additions: flat top/bottom channels, disjoint channels, fib speed-resistance fans / circles / arcs / wedges / trend-based time, Cypher, three drives, triangles, Elliott triangle & WXY combos, cycles, sine, ellipse, rotated rectangle, arc, curve, note, price note, signpost, forecast, anchored VWAP, anchored volume profile (0.5.0); highlighter, path (click-by-click, double-click or Enter to finish), polyline, pin, fib spiral, bars pattern (0.5.1); projection (fan), ghost feed (0.5.2); anchored text, table (0.5.3); fixed Gann square (0.5.4); inside pitchfork (0.5.5). Live preview while drawing, Esc to cancel, Shift constrains to horizontal / 45°; magnet snapping (off / weak / strong) to candle OHLC.
- **Editing & managing drawings**: drag anchors to reshape, drag the body to move; the floating toolbar edits anchor time, price and name precisely, color, width, style, duplicates, sets the tool's default style, locks or deletes. Shift or Ctrl/Cmd-click multi-selects for group move / recolor / hide / lock / delete (one-step undo). Shortcuts: Alt+T trend, Alt+H horizontal, Alt+J h-ray, Alt+V vertical, Alt+C crossline, Alt+F fib retracement, Alt+Shift+R rectangle; hold Ctrl/Cmd while drawing to temporarily invert magnet snapping; Esc exits layer by layer. Delete removes, Ctrl/Cmd+C/V copy-pastes, Ctrl/Cmd+Z / Shift+Ctrl/Cmd+Z undo-redo (create, edit, delete and bulk delete are all undoable). The drawing list below the chart locates, hides, locks or deletes each drawing; the menu adds continuous drawing, lock-all and delete-all. Star up to 12 favorite tools — they appear in a quick bar above the chart (stored per browser). Drawings anchor to time & price, stay glued to candles across pan / zoom / interval switches / history loads, and can extend into empty space right of the latest bar. Drawings are stored per session and coin, survive restarts, and agent-added/edited drawings appear on open charts within the next host event poll (~1s).
- **Alerts & stickers**: a drawing belongs to the session that drew it; no other session sees it, globally shared ones included. Horizontal lines / rays, trend lines, rays and extended lines support **price alerts** — the host watches the mid price and pops a desk alert on cross (fires once, then turns off, can be re-armed). The icon tool ships a sticker library: 18 built-in icons and ~60 stickers across trading / emoji / symbol categories, plus any pasted emoji. Up to 100 drawings per chart (session + coin, across intervals).
- **Fills & decision reasons**: every fill is dotted on the chart at its price (green buys, red sells); fills with an AI decision reason get a ring — click to see direction, size, price, time and the reason at entry; "show → fill reasons" renders the labels directly on the chart. "Back to the deciding session" switches to the session that made the call and drops the fill + reason into its input as a review reference.
- **Strategy framework**: the chart toolbar provides trend-following, range-breakout and volatility-band-reversion observation cards that use closed candles only, marking condition-met / watching / insufficient-data / stale; "ask the agent to verify" has the session check higher timeframes, the book, funding and account risk — it never places orders by itself. Parameters are analysis defaults; profitability on any market or interval is not implied.
- **Trade actions in chat**: every `hyper_*` call renders as one readable line, e.g. "trade pre-check · buy 0.001 BTC @ 81,200"; the conclusion appears when it finishes and the full return expands.
- **A proactive trading assistant**: on first meeting, the agent delivers value first (a trade review if you have fills, otherwise one scanned opportunity drawn on the chart) and then asks about your preferences once. Price alerts wake the session agent: with the autonomy switch on (below) it runs the full watch loop on its own; otherwise it reviews and reports back (at most once per session per 5 minutes; disable via the `wakeAgentOnAlert` config). Chat-column quick actions: trade review, today's opportunities, watch my position, turn chart drawings into a strategy.
- **Autonomous watch-loop & permission boundary**: once **Watch** (盯盘) is on for a session — off by default; the user turns it on with the eye button on a session row, or asks the agent in chat (`hyper_session action=watch`), but an automatic round can never turn it on, each closed bar of the session's watch interval wakes it (`[交易台盯盘]` message) and price alerts wake it too (`[交易台事件]`); unwatched sessions are never woken and a restart never replays a wake. The interval follows the shortest entry timeframe of the session's active strategies (5m–4h, 15m without one) — this is the desk's main loop, no schedule needed. Each round runs a closed loop: **gather (context / account / multi-timeframe indicators) → assess (one-line market state + check every strategy trigger and invalidation) → adjust (cancel stale orders, update plans and chart alerts) → execute (decide → order, reconcile afterwards) → report (only when something happened)**. Watch is the autonomy grant: a watched session's automatic rounds may open with a stop loss, cancel, change leverage and limits, and transfer (in semi-custody each order still waits for the user's approval); withdrawal is never implemented by this plugin. All live agent opens without `stopLossPx` are rejected. In an unwatched session, automatic rounds may only reduce risk or cancel orders. Risk limits and journal discipline still apply. After an open, the agent must verify the actual position and stop order; a partially filled parent order may leave exposure unprotected.
- **Custody modes**: top-right settings choose "semi-custody" (default) or "full custody". Semi-custody: every live order, cancel, leverage change and transfer needs your approval; allowed coins and limits can only be changed by you in "trading limits & signing rules". Full custody: the agent executes within limits, may adjust allowed coins and limits itself, and may transfer USDC between spot / main perp / HIP-3 exchanges — every adjustment is explained in the session. Enabling full custody on live requires confirmation and the top bar shows a "全托管" badge. In both modes the dsh-web3 wallet's own signing policy still applies.
- **Live approvals**: when an agent order, cancel or leverage change needs your approval, the DSH approval panel shows an order card: direction, size, price, estimated notional, TP/SL, current network and mode, limit usage, and the agent's stated thesis.
- **Market picker**: click a contract name or press `/` to open the market picker with search, categories, sorting and favorites. Core perps and USDC-margined HIP-3 perps (e.g. `xyz:XYZ100` Nasdaq-100, stocks and commodities) are tradeable; spot and outcome markets are read-only for now. HIP-3 margin is per exchange: transfer USDC to that exchange on Hyperliquid first, or enable unified account; also add the market name (e.g. `xyz:XYZ100`) to the allowed coins.
- **Layout**: all three columns collapse; dividers drag to resize; double-click restores default widths.
- **Background recovery**: switching the tab to the background pauses polling and the host releases idle market subscriptions while keeping the Hyperliquid connection. Returning re-subscribes and backfills automatically; the top bar shows "同步中" meanwhile.

## Trading limits & wallet signing

Orders pass through two **independent** rule sets. Current values and today's usage are visible in "trading settings → trading limits & signing rules". Saved limits go to `risk-settings.json` in the plugin data directory and take precedence over plugin config at startup; restoring plugin config deletes the override file.

**1. Trading limits**: enforced for paper and live, with separate daily ledgers; reduce-only orders are never limited.

| Field | Default | Description |
|---|---|---|
| `allowedCoins` | `BTC,ETH` | Perp coins allowed for new positions, comma-separated (`*` = all tradable markets) |
| `maxOrderUsd` | `100` | Max notional per order (USD) |
| `maxDailyUsd` | `500` | Max cumulative new-position notional per UTC day (USD) |
| `maxPositionUsd` | `500` | Max position notional per coin (USD) |
| `maxLeverage` | `2` | Max leverage |

**2. Wallet signing (dsh-web3, live orders with `signer: web3` only)**: the wallet's signing policy decides whether a signature passes automatically, needs approval, or is refused. It does not check the trading limits above; the policy is managed in DSH Settings → Web3 Wallet.

Two agent-side switches live on top:

- `autonomousLive: false` (default) — when false, every agent live order, cancel and leverage change pops a DSH approval.
- `agentAutoTradeTestnet` — deprecated and ignored; autonomy is the per-session Watch switch described above.

## All config options

| Field | Default | Description |
|---|---|---|
| `dataDir` | `~/.dsh-hyperliquid` | Session registry, session workbenches, paper ledger and audit records |
| `network` | `mainnet` | `mainnet` / `testnet` |
| `tradingMode` | `live` | `live` signs and sends real orders; `paper` matches locally |
| `signer` | `local` | `local` signs with a plugin-local private key; `web3` signs via the dsh-web3 vault |
| `privateKey` | — | Private key for `signer: local`, or env `HYPERLIQUID_PRIVATE_KEY`. Use an API wallet key, never your main wallet's |
| `web3Account` | `main` | dsh-web3 account id or name for `signer: web3` |
| `tradingAddress` | — | Hyperliquid funded main account address; required when signing with an API wallet |
| `autonomousLive` | `false` | Let the agent execute live operations within the trading limits; requires `signer: web3` |
| `agentAutoTradeTestnet` | `false` | Deprecated and ignored: wakes and autonomous trading follow each session's Watch switch |
| `wakeAgentOnAlert` | `true` | Wake the session agent when a price alert fires (at most once per session per 5 minutes) |
| `allowedCoins` … `maxLeverage` | see above | Trading limits |

## Agent tools

Each trading session must hold its own filled position without a separate enable switch. Profiles, strategies, journals, chart drawings, trade markers and orders are private by default. “Share session” offers exactly two modes: Independent (the default, the session's own rules and profile) and Global (every Global session uses one rule set and profile; switching back keeps a copy of the current rules). Either way, chart drawings, order and fill markers, open orders, filled allocations and performance belong to that session and never appear on another session's chart. Archiving pauses automatic entry; restoring resumes checks.

The exchange still maintains one net position per account and contract. Same-direction strategies can own separate allocations; cross-session closes, cancels and opposing opens are rejected. Independent opposing strategies require different trading accounts. Margin and account risk caps remain shared. Session performance uses its own fill cost basis without allocating funding. Existing global journals are retained; only records with known session ownership migrate automatically.

| Tool | Description |
|---|---|
| `hyper_context` | One call for the session's coin, book, candles, account equity, positions and risk limits |
| `hyper_market` | Market data: overview / book / candles / trades / catalog / indicators (SMA, EMA, RSI, MACD, Bollinger, ATR, Stochastic, ADX/DMI, OBV, support & resistance, plus on-chart or specified MA values) |
| `hyper_chart` | Add, edit (geometry / color / width / style / lock / hide) or remove drawings (78 kinds incl. fixed-range volume profile, Fibonacci, Gann, pitchforks, regression, Elliott & harmonic patterns, annotations, long/short positions; price alerts) and moving averages (SMA / EMA / SMMA / WMA with optional smoothing); `action=view` switches the chart interval and toggles RSI, MACD and other sub-panes |
| `hyper_account` | Account: state / orders / fills / orderStatus (oid or cloid) / review (window evidence, costs, order reconciliation) |
| `hyper_decide` | Live pre-check: submit a trade intent with its thesis, get a one-time `decisionId` valid for 30 seconds |
| `hyper_order` | place / cancel / leverage; live orders must carry a matching `decisionId` and may attach TP/SL on testnet or mainnet; verify the actual stop after submission |
| `hyper_session` | status / bind, syncing the coin the user is currently viewing |
| `hyper_account` custody actions | `action=limits` (full custody: the agent adjusts allowed coins and caps) and `action=transfer` (`from`/`to` = spot, perp or a HIP-3 exchange name; USDC moves between any two of your own accounts: spot ↔ main perp via `usdClassTransfer`, main perp ↔ HIP-3 via `sendAsset` in one step, spot ↔ HIP-3 and HIP-3 ↔ HIP-3 route through the main perp in two steps with a single approval; main-wallet signed; unified accounts need no spot ↔ perp transfer) |
| Trade review & market radar | `hyper_account action=analyze`: full round-trip stats for the last 7/30/90 days — win rate, payoff, expectancy, hold time, performance by coin / session / weekday, fees and funding, habit problems ranked by cost with suggested rules (no conclusions under 10 round trips); `hyper_market action=scan`: scans the ~20 most liquid tradeable perps for range approaches / breaks, funding extremes, 24h moves and premiums |
| `hyper_journal` | Trader journal (survives sessions): trader profile (risk appetite, holding period, interruption preference…), strategy library (versions with revision reasons, per-paper/live stats for count, win rate, expectancy R), plan / result / review / lesson entries; summaries flow into every session's system prompt |

The plugin also registers the bundled [`hyperliquid-trading` skill](skills/hyperliquid-trading/SKILL.md), teaching the agent to verify data freshness, account and risk before separating analysis from execution, and to reconcile before retrying after any receipt anomaly.

## Multi-timeframe research & review

The chart supports 2-up / 4-up research layouts with linked time and crosshairs; the indicator menu covers RSI/MACD/BOLL/Stochastic/ADX parameters, cross-session indicator templates and the data window. The bottom "trade review" panel reconciles fills, orders, reasons and fees, shows data-coverage gaps, and can export evidence or hand it to the AI. Details in the [research & review notes](docs/research-review-2026-10-16.md) (Chinese).

## Security design

- Live orders are two-step: `hyper_decide` pre-check first, then `hyper_order`. At execution the host re-reads market and account data and refuses when price drifted more than 1% from the pre-check.
- Every live order carries a 128-bit `cloid` and is written to the local audit log. After a network timeout, quota is conservatively retained until the exchange state is reconciled by `cloid`.
- Network or trading-mode switches clear all market caches and unconsumed pre-check decisions and are refused while a trade is executing.
- The trade ticket pauses submission when market or host data is stale.
- The signing implementation replicates the official Python SDK `signing.py` byte-for-byte and is verified against the official test vectors; local and web3 signing paths produce identical results.

## Known limitations

- Paper fees and adverse slippage are configurable in the trading limits settings (defaults 4.5 / 5 bps) and are actually charged on new fills with the assumptions of that moment. Paper does not simulate order-book depth, funding or liquidations, and paper PnL does not translate to live performance. Paper TP/SL bracket orders are simulated locally (trigger execution, OCO pairing, restart dedupe).
- Grouped TP/SL orders (`normalTpsl`) can be submitted on testnet and mainnet. Protection orders only rest after the parent fills completely; after execution reconcile the real position and the protection orders.
- Non-USDC assets in Portfolio Margin accounts do not count toward risk-check equity and may cause conservative rejections.

## Development

```bash
npm install
npm run build      # src/client → client.js (build artifact, do not hand-edit)
npm run typecheck
npm test
npm run smoke:chart     # base chart: types / coordinate editing / indicator crosshair / date nav / PNG & CSV export / restore
npm run smoke:drawing   # real DSH host + Chrome: drawing interaction, restart persistence, all tools, fill dots, pan performance
```

- Source layout: `index.js` and `lib/*.js` are host-side pure-ESM code with no build step; `src/client/` is the client (React + TSX) bundled to `client.js` by esbuild.
- Architecture notes in [docs/architecture.md](docs/architecture.md) (Chinese).
- Restart the DSH host after changing host-side code; `npm run build` only updates the client. Run `npm test` (37 files) before every commit — the suite must be green.

## License

MIT — see [LICENSE](LICENSE). Third-party notices in [NOTICE](NOTICE).
