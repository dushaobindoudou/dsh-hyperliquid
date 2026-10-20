# Hyperliquid research — official logo + trade page feature layout
*Research date: 2026-10-13. All URLs below were actually fetched or seen in fetched HTML. Sources: hyperliquid.xyz HTML, app.hyperliquid.xyz HTML, app JS bundles (index-BBe39C6L.js, config-BCWVmVrl.js, en-US-DnLiZHkM.js locale chunk), manifest.json, downloaded icon assets. web_search was unavailable (API balance error); everything came from direct fetches.*

---

## A. Official Hyperliquid logo

### A1. What it looks like
- **Mark**: an abstract mint-green "metaball" / liquid blob — two rounded lobes joined by a smooth pinched waist, reading like a soft horizontal dumbbell (many people describe it as a stylized liquid "H"). The **left lobe is smaller (~40% width, egg-shaped, tilted)**, the **right lobe is larger (~60%, bigger teardrop tilted the other way)**, the neck between them dips both above and below (an hourglass waist). No outline, no gradient, no lettering inside the mark.
- **Color (exact, pixel-sampled from official PNGs)**: `#97FCE4` = `rgb(151,252,228)` — a mint/turquoise green. Dominant antialiased shade on the largest-count pixels across apple-touch-icon.png and favicon-32x32.png: `151,252,228`. Flat fill, single color.
- **Backgrounds in use**:
  - Favicons/app icons: mark on **transparent** background.
  - GitHub org avatar + X profile avatar: mint mark on a **very dark green/near-black** disc (approx #12241C–#1B2C24).
  - og:image (1200×630): dark **green gradient** backdrop (near-black #0A1F14 → mid green ~#245B3C), mint mark left, white wordmark right.
- **Wordmark lockup (og:image)**: "Hyper" in a clean geometric sans + "liquid" in an **italic serif**, white, next to the mark; tagline "Infrastructure to House All Finance"; small `hyperliquid.xyz` pill bottom-right. Site title: "Hyperliquid – Infrastructure to House All Finance".

### A2. Verified asset URLs (all fetched during this research)
| Asset | URL | Notes |
|---|---|---|
| Highest-res official icon | https://app.hyperliquid.xyz/android-chrome-512x512.png | 512×512 PNG, mark on transparent bg — best raster to trace/vectorize |
| App icon (PWA) | https://app.hyperliquid.xyz/android-chrome-192x192.png | declared in /manifest.json |
| Apple touch icon (both hosts) | https://app.hyperliquid.xyz/apple-touch-icon.png and https://hyperliquid.xyz/apple-touch-icon.png | 180×180 PNG, byte-identical size (7469 B) |
| Favicon 32 | https://hyperliquid.xyz/favicon-32x32.png (also on app host) | 32×32 |
| Favicon 16 | https://hyperliquid.xyz/favicon-16x16.png (also on app host) | 16×16 |
| og:image (full lockup art) | https://hyperliquid.xyz/assets/files/ymnmM5v8VPDDFotHL3j3j4VNHlc.png | served as WebP, 1200×630 |
| GitHub org avatar | https://avatars.githubusercontent.com/u/129421375?v=4 | fetched, 270×270 (org: hyperliquid-dex, id 129421375) |
| X profile avatar | https://pbs.twimg.com/profile_images/2001260078352285697/f5cl2Syx_400x400.jpg | fetched, 400×400 JPG (handle HyperliquidX; URL resolved via https://unavatar.io/twitter/HyperliquidX?json) |

**HTML evidence (fetched):**
- https://hyperliquid.xyz head contains:
  `<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">`,
  `<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">`,
  `<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">`,
  `<meta property="og:image" content="/assets/files/ymnmM5v8VPDDFotHL3j3j4VNHlc.png">` (+ twitter:image same).
- https://app.hyperliquid.xyz head contains the same three icon links (relative), plus `<link rel="manifest" href="/manifest.json">`; manifest.json has icons android-chrome-192/512, `"theme_color": "#000000"`, `"background_color": "#000000"`, description "Trade crypto, commodities, indices, and more on Hyperliquid: 300+ perpetual and spot markets, fully onchain, non-custodial, 24/7."
- **No official SVG on the marketing/app hosts**: `/logo.svg`, `/favicon.svg`, `/logo_dark.svg`, `/favicon.ico` on both hosts return the 6831-byte `index.html` fallback (soft-404). The three SVGs on the marketing site (`/assets/images/GkLP8pOEqpWqFPF3CXQWTdNvjBk.__q-c9942b6097e9.svg`, `k2TCRAAcgmStd9ft8j0j9ARCl4.__q-fcc96c8f79bd.svg`, `pECAEg3xNjNM9wBfzgcfmn83h0.__q-f623e9773574.svg`) are partner/integration logos (orange H tile, yellow-K tile, blue shield) — NOT the Hyperliquid mark. No logo in hyperliquid-dex repo READMEs.
- **SVG path (UPDATE 2026-10-13, later same day)**: an official vector DOES exist — in the **brand kit** at https://hyperliquid.gitbook.io/hyperliquid-docs/brand-kit ("Hyperliquid SVG format.zip", 14 KB, uploaded 2026-07-15). The page is JS-rendered: fetch with `curl` + a browser UA and grep the gitbook-x-prod.appspot.com file URL; that URL serves JSON metadata unless you append `?alt=media&token=<downloadTokens>` from the metadata. The zip contains 7 clean single-fill SVGs:
  - `Hyperliquid_Blob_Green.svg` (viewBox 0 0 200 200) — the metaball mark in **#97fce4**. This is the authoritative mark; it replaced our hand-traced 64×64 path.
  - `Hyperliquid_Blob_Dark.svg` — same mark in **#011916** (for light backgrounds); `Hyperliquid_Blob_Light.svg` — same mark in **#fff** (for dark backgrounds).
  - `Hyperliquid_Dark.svg` / `Hyperliquid_Light.svg` (856×200) — full lockup (mark + wordmark): Dark = mint mark + #011916 type on light bg, Light = mint mark + #fff type on dark bg.
  - `Hyperliquid_Type_Dark.svg` / `Hyperliquid_Type_Light.svg` (664×200) — wordmark only.
  - The kit also ships "Hyperliquid PNG format.zip" (1 MB) and Hypurr mascot zips — **we deliberately consume only the SVG kit; no PNG enters this repo.**
  - Adopted 2026-10-13: `icon.svg` (official blob on the official #011916 brand-dark plate) and the client `BrandMark` (official blob path, viewBox 200×200).
- **Brand usage rules** (from the kit page): use the supplied files as-is; never retype the wordmark or rebuild the mark; never recolor, stretch, rotate, outline, or add effects; keep clear space equal to the mark height on all sides.

### A3. Brand color summary
- Logo mint: **#97FCE4**
- App dark background: body `background-color: #303030` pre-hydration, `color-scheme: dark`, manifest theme #000000; trading UI is dark charcoal (gray_50 tokens) with **green_300/green_600 for bids/buys** and **red_600/red_900 for asks/sells** (token names read from bundle).
- og art greens: near-black → mid-green gradient (sampled visually, not exact hex).

---

## B. app.hyperliquid.xyz/trade — current feature layout
Method note: the page is a React SPA; layout below was reconstructed from the shipped bundles (entry `index-BBe39C6L.js`, shared `config-BCWVmVrl.js`, strings chunk `en-US-DnLiZHkM.js`) — i.e., from the actual production code, plus fetched HTML.

### 0. Tech & shell
- SPA shell HTML (6.8 KB) loads `/assets/index-BBe39C6L.js` + ~60 preloads; status page widget `hyperliquid.statuspage.io`; Privy embedded-wallet SDK; routes include `/trade/:coin?/:spotQuote?` (spot pair route), plus /portfolio, /leaderboard, /outcomes, /vaults, /explorer, /staking, /builderCodes, /api, /fundingComparison, /twapHistory, /chasehistory etc.
- API: `https://api.hyperliquid.xyz/info` + `/exchange`; stats via `https://stats-data.hyperliquid.xyz/`; docs links point to `https://hyperliquid.gitbook.io/hyperliquid-docs`.

### 1. Top header bar (asset stats row)
Built from live assetCtx; item order in code: **Price (last)** → **24h Change** → **24h Volume** → **Mark** → **Oracle** → **Open Interest** → **Funding / Countdown** (+ "More info" where applicable).
- Price: last price; tooltip "Mid price if it exists, otherwise the mark price".
- 24h Change vs prev day price (`prevDayPx`), colored green/red.
- 24h Volume (tooltip shows base-asset amount).
- Mark and Oracle shown separately; **merged into "Mark / Oracle"** on narrow widths (both variants coded).
- Open Interest: $ notional, tooltip with coin amount.
- Funding / Countdown: current funding rate %, tooltip "Annualized: {value}%" (rate ×24×365), countdown to next funding.
- Same row: coin selector (favorites/star, "CoinSelector.provider" chunk), and on prediction markets the stats swap to Price/% chance/Countdown + "live outcomes".
- Below header: **chart-area tabs "Chart" / "Funding"** (funding-rate history chart view, cumulative funding line) — a real tab toggle in code; prediction markets get "Candles / Outcomes" instead.

### 2. Chart area
- **TradingView Charting Library, self-hosted v28.5**: `/charting_library_v28.5/charting_library/charting_library.js?bust=v8` (script tag in HTML head — verified).
- Widget config seen in bundle: `locale` from browser, `interval: '60'` default, favorites `['D','H','5']`, autosize, local timezone.
- Standard TV toolbar/drawing tools (library-provided). Custom integration: user's open orders/TP-SL drawn as order lines on the chart (`createOrderLine`, labels "TP"/"SL", trigger conditions "above >" / "below <"); orders can be **modified by dragging on the chart** ([TvChart] code); fills posted as marks (`userFillsByTime` aggregated).

### 3. Order book panel
- Columns per level: **Price | Size | Total** (grid 20%/40%/40%); hover shows cumulative size/notional; toggle between notional and size ("cumNtl"/"cumSz", `isNtl`).
- **Side-view selector: Both / Asks / Bids** (message ids `order.book.side.view.both/asks/bids`) — including a split "side view" mode.
- Depth bars: ask bars **red** (`red_600` active/red_900 idle), bid bars **green** (`green_300`/`green_600`), bar height 5px styling tokens.
- Settings: **"Animate Order Book"** toggle, **"Set Order Book Size on Click"** (clicking a level also sets order size), **"Aggregate"** tick-size grouping selector (aggregation levels from szDecimals).
- Click behavior in code: clicking asks/bids sets the limit price; **if current form type is Market it switches to Limit; if Stop Market it switches to Stop Limit**.

### 4. Trades tape
- "Trades" panel: **Time | Price | Size** (+ Total), buys green / sells red, newest on top (standard HL tape; strings and column set confirmed in bundle).

### 5. Order form (right panel) — documented only, not copied
- Order types (strings + code): **Market, Limit, Scale, TWAP, Stop Market, Stop Limit, Take Profit Market/Limit, Trailing Stop Market, Chase** (+ "Limit Close", "Market Close", "Limit Close at Mid Price" quick actions).
  - **Scale**: ladder order builder (trailing/`retracement` params in code).
  - **TWAP**: submittable TWAP orders (min value enforced; running TWAPs have a bottom-tab view).
  - **Chase** (recent, notable): client-side order that **"Reprices a limit to the top of the book until filled"**; runs only in the browser, terminates on tab close/refresh/disconnect, then degrades to a normal limit order. Has its own history page `/chasehistory`.
  - Trailing Stop: "trailing starts when the mark price reaches [activation]; retracement by your set distance places a {side} Stop Market order."
- TP/SL: simple market TP/SL on entry ("Places simple market TP/SL orders…"); full TP/SL editable per position ("TP/SL for Position"); `tp.sl` column in open orders.
- Reduce Only; **Post-only** ("Order will exist only as a limit order on the book. Also known as post-only." → ALO); **Max Slippage** setting for market orders (closing positions 8%, market TP/SL 10% defaults).
- Leverage: **Adjust Leverage** modal + **Margin Tiers**; margin mode **Cross / Isolated** (per-asset; isolated-only assets exist).
- Position mode: Hyperliquid is one-way per asset (long/short net). Strings "One-Way" and "Hedge" exist in the locale, but no hedge-mode UI/logic surfaced in the bundles I inspected — do not assume hedge mode exists.
- Buy/Short buttons: **"Buy / Long"** (green) and "Sell / Short"; Account Equity / Available Balance / order value + fee summary rows.
- Portfolio Margin: separate mode ("Portfolio Margin Enabled", LTV-based, auto supply/borrow of quote assets); **Unified Account** ("Spot and Perps balances are merged… cross margin on all available assets; all USDC becomes cross collateral").

### 6. Bottom table tabs (code switch, trade page)
Tabs: **Positions · Open Orders · TWAP · Chase · Trade History · Funding History · Order History (historicalOrders) · Borrow/Lend Interest · Deposits/Withdrawals** (vault context adds Followers; profile pages add Account Value/Ledger/Staking views). Expand-all/collapse-all and per-tab filters ("Balances ({count})" etc.).
**Positions table columns** (from row renderer): Coin, Side, Size, Position Value, Entry Price, Mark Price, Liq. Price, Margin, **PNL (ROE %)**, TP/SL, Funding, Contract (+ "Close" per row and **"Close All"**; mobile shows expandable cards with the same fields).

### 7. Recently added / notable features
- **HIP-3 builder-deployed perp markets**: deployer disclaimer modal ("permissionless markets deployed by this deployer…"), "HIP-3 perp fees are configured by the deployer, and fees and rebates can be up to 90% lower than the base rate", "Always Allow HIP-3 Cross Margin" setting, HIP-3 Liquidator Deposit/Withdrawal ops, funding reference price "See the HIP-3 deployer's docs". Multi-DEX support: open orders queried with `dex: ALL_DEXS`; "All DEXs have separate balances and cross margin applies separately within each DEX" (automation-oriented setting).
- **HIP-4** deployer disclaimer (prediction/resolution markets) — outcomes pages, resolution "settled to {result} by the deployer".
- **Unified Account** (merged spot+perps balances, cross margin everywhere) and **Portfolio Margin** (LTV, auto supply/borrow).
- **hyperp**: pre-launch token perps (e.g. {coin}-USD) on low leverage/isolated margin.
- **TradFi markets**: "Trade crypto, commodities, indices, and more" — gold (XAUT0), stocks/forex ("tradfi" string, "stocks", Gm markets).
- **Prediction markets** ("outcomes") with live outcome side + % chance stats.
- Spot/perp toggle via coin selector & `/trade/:coin?/:spotQuote?` route; funding comparison page `/fundingComparison` ("Funding rate differences across exchanges"); leaderboard; borrow/lend integrated; sub-accounts; builder codes approval page.

### Caveats
- web_search API was down (402 balance) — findings are from primary-source fetches only, which is arguably better here.
- Layout left/right ordering (book left of form etc.) is from the grid/gridTemplate code + common HL layout, not a screenshot; every feature/column/string above is from production bundles.
- B: no hedge mode confirmed; "One-Way"/"Hedge" strings exist but their UI placement wasn't located.
