/**
 * dsh-hyperliquid — sidebar panel entry icon.
 *
 * The sidebar owns the row button (PanelRow renders this slot inside its
 * own <button> and calls layout.selectPanel(id) with our registration id),
 * so the entry renders ONLY the icon glyph — same contract as
 * dsh-bots' PluginsPanelIcon.
 * @module src/client/components/panel-entry
 */

import * as React from 'react'
import { BrandMark } from './brand-mark'

export function PanelEntry(props: { size?: number }) {
  return (
    <span className="dhl-entrymark">
      <BrandMark size={props?.size ?? 18} />
    </span>
  )
}
