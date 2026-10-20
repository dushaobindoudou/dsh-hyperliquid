/**
 * Whether a press → release on the chart is still a click (a quote or a
 * drawing anchor) rather than a pan or zoom.
 *
 * The pointer drag itself is caught by movement distance. This guard only
 * looks at how the visible logical range changed while the button was down:
 * a live candle that lands mid-click shifts the range by one slot without
 * changing its width, and must NOT cancel the click (the old rule compared
 * the range exactly, so a click at the moment a new bar arrived was dropped).
 * @module src/client/click-guard
 */

export interface LogicalRange { from: number; to: number }

/** Bars the view may shift during a press before it counts as a pan. */
export const LIVE_SHIFT_BARS = 2

/** The pre-fix rule: any range change during the press counted as a pan (dropped the click). */
export function legacyPressStillAClick(atPress: LogicalRange | null, atRelease: LogicalRange | null): boolean {
  if (!atPress || !atRelease) return true
  return !(Math.abs(atPress.from - atRelease.from) > 0.01 || Math.abs(atPress.to - atRelease.to) > 0.01)
}

export function pressStillAClick(atPress: LogicalRange | null, atRelease: LogicalRange | null): boolean {
  // Test-only switch: the real-host smoke flips this to reproduce the original bug in a live chart.
  if ((globalThis as { __dhlLegacyClickGuard?: boolean }).__dhlLegacyClickGuard) return legacyPressStillAClick(atPress, atRelease)
  if (!atPress || !atRelease) return true
  const zoomed = Math.abs((atPress.to - atPress.from) - (atRelease.to - atRelease.from)) > 0.01
  const panned = Math.abs(atPress.from - atRelease.from) > LIVE_SHIFT_BARS
  return !zoomed && !panned
}
