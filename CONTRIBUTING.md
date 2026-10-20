# Contributing to dsh-hyperliquid

Thanks for looking into the code. This is the Hyperliquid trading desk plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

## Setup

```bash
npm install
npm run build        # bundles src/client → client.js (esbuild; do not hand-edit client.js)
npm run typecheck    # client TypeScript
npm test             # 37 test files, must be fully green
```

- Host-side code (`index.js`, `lib/*.js`) is plain ESM with no build step. Restart the running DSH host after changing it.
- Client code (`src/client/*.tsx`, React + TypeScript) needs `npm run build` and only updates the client bundle.
- For development against a live profile, the package directory can be symlinked into `~/.dsh/profiles/<profile>/node_modules/`.

## Before you commit

- Run `npm test` and make sure every file passes; a red suite blocks the release chain.
- Keep the plugin's safety invariants: two-step live orders (`hyper_decide` → `hyper_order`), the 128-bit `cloid` audit trail, trading-limit checks on every order, and withdrawal is never implemented.
- Document user-visible behavior changes in `CHANGELOG.md` (Chinese, one section per version).
- Bump `package.json` version and tag the release when publishing: `npm publish`.

## Scope

Bug fixes, tests and docs are welcome. Trading behavior changes (limits, permissions, the autonomy switch) should keep the documented defaults for fresh installs.
