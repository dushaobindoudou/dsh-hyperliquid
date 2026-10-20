/**
 * dsh-hyperliquid — the official Hyperliquid brand mark.
 *
 * Path is the OFFICIAL vector from the brand kit (SVG format.zip,
 * Hyperliquid_Blob_Green.svg, viewBox 200×200) — never re-traced, never
 * recolored (brand rules). Mint #97FCE4 on transparent.
 * @module src/client/components/brand-mark
 */

import * as React from 'react'

export const HL_MARK_PATH = 'M175.11589,99.27891c0,49.46366-30.3687,65.33789-46.47302,51.30413-13.11357-11.5031-17.02471-35.88989-36.81018-38.42055-25.07698-2.99085-27.37764,30.36839-43.94216,30.36839-19.3254,0-23.00642-27.83773-23.00642-42.33179,0-14.72405,4.14115-34.73961,20.47565-34.73961,19.09528,0,20.24566,28.75802,44.17226,27.14754,23.69661-1.61047,24.1567-31.51877,39.80103-44.17224,13.57335-11.27313,45.78283.69019,45.78283,50.84413Z'

export function BrandMark({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 200 200" width={size} height={size} className="dhl-mark" aria-hidden="true">
      <path d={HL_MARK_PATH} fill="#97FCE4" />
    </svg>
  )
}
