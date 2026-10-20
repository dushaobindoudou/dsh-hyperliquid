/** Per-tool default style ("templates"): saved per browser, applied to new drawings of that kind. */
import type { DrawingKind } from '../../lib/chart-drawings.js'

export interface StyleTemplate { color?: string; lineWidth?: number; lineStyle?: 'solid' | 'dashed' | 'dotted' }
const key = (kind: DrawingKind) => `dsh-hyperliquid.draw.style.${kind}`

export function loadStyleTemplate(kind: DrawingKind): StyleTemplate {
  try {
    const value = JSON.parse(localStorage.getItem(key(kind)) ?? 'null')
    if (!value || typeof value !== 'object') return {}
    const out: StyleTemplate = {}
    if (typeof value.color === 'string' && /^#[0-9a-f]{6}$/i.test(value.color)) out.color = value.color
    if ([1, 2, 3, 4].includes(value.lineWidth)) out.lineWidth = value.lineWidth
    if (['solid', 'dashed', 'dotted'].includes(value.lineStyle)) out.lineStyle = value.lineStyle
    return out
  } catch { return {} }
}

export function saveStyleTemplate(kind: DrawingKind, style: StyleTemplate): void {
  const clean = Object.fromEntries(Object.entries(style).filter(([, value]) => value != null))
  try { localStorage.setItem(key(kind), JSON.stringify(clean)) } catch { /* storage unavailable */ }
}
