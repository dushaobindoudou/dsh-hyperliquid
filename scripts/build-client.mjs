/**
 * dsh-hyperliquid — client build.
 *
 * esbuild bundles src/client (React TSX + the real lightweight-charts npm
 * package) into a single CJS module, then wraps it in the dsh shell's
 * `window.__ModuleLoader__.load({ id, factory })` IIFE — the exact artifact
 * shape dsh-bots ships. Only `react` stays external (the shell's static
 * module map provides it); everything else must be bundled, because the
 * client module graph resolves shell builtins ONLY.
 *
 *   node scripts/build-client.mjs        # build once
 *   node scripts/build-client.mjs --watch
 *
 * Output: <repo>/client.js  (build artifact — never hand-edit; edit src/)
 */

import { build } from 'esbuild'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(root, 'src/client/index.tsx')
const out = join(root, 'client.js')
const watch = process.argv.includes('--watch')

/** esbuild flags shared by build and watch. */
const options = {
  entryPoints: [entry],
  bundle: true,
  format: 'cjs',
  target: 'es2022',
  platform: 'browser',
  jsx: 'transform',
  // Resolve the `development` export condition so bundled libraries ship
  // UNMINIFIED (lightweight-charts: dist/*.development.mjs) — the artifact
  // stays debuggable and greppable. Trade-off: ~2.5x artifact size, which
  // is irrelevant for a localhost-served dsh client. Flip to 'production'
  // here if size ever matters.
  conditions: ['browser', 'import', 'development'],
  // The shell module map — everything else MUST be bundled in.
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  loader: { '.css': 'text' },
  outfile: out,
  logLevel: 'info',
  banner: {
    js: '/* eslint-disable */\n/**\n * dsh-hyperliquid — client half (web). BUILD ARTIFACT — do not edit.\n * Source of truth: src/client/ (React TSX). Rebuild: npm run build.\n * Bundles TradingView Lightweight Charts (Apache-2.0, lightweight-charts pkg,\n * development condition — unminified, greppable).\n */',
  },
}

/** Wrap the CJS bundle in the shell's loader IIFE (dsh-bots artifact shape). */
function wrapLoader(cjs) {
  return [
    'window.__ModuleLoader__.load({',
    "  id: 'dsh-hyperliquid',",
    '  factory(__shellRequire) {',
    '    const module = { exports: {} }',
    '    const exports = module.exports',
    "    const require = (id) => __shellRequire(id)",
    '    /* ── esbuild bundle (react external) ───────────────────────── */',
    cjs.trimEnd(),
    '    /* ── end bundle ────────────────────────────────────────────── */',
    '    return module.exports',
    '  },',
    '})',
    '',
  ].join('\n')
}

if (watch) {
  const ctx = await esbuildContext()
  await ctx.watch()
  console.log('[build-client] watching src/client → client.js')
} else {
  const result = await build({ ...options, write: false, metafile: true })
  const js = result.outputFiles[0].text
  writeFileSync(out, wrapLoader(js), 'utf8')
  const meta = result.metafile
  const inputs = Object.keys(meta.inputs)
  const lwc = inputs.filter((i) => i.includes('lightweight-charts'))
  const kb = (n) => `${(n / 1024).toFixed(1)}KB`
  console.log(`[build-client] client.js ${kb(Buffer.byteLength(js))} (bundle inputs: ${inputs.length}, lightweight-charts files: ${lwc.length})`)
  console.log(`[build-client] wrote ${out}`)
}

async function esbuildContext() {
  const { context } = await import('esbuild')
  return context({ ...options, plugins: [wrapPlugin()] })
}

/** Re-wrap the file after every incremental rebuild. */
function wrapPlugin() {
  return {
    name: 'wrap-loader',
    setup(build) {
      build.onEnd(async (result) => {
        if (result.errors.length > 0) return
        const js = result.outputFiles[0].text
        writeFileSync(out, wrapLoader(js), 'utf8')
        console.log(`[build-client] rebuilt ${out}`)
      })
    },
  }
}
