/** Icon & sticker library for the icon drawing tool: built-in glyphs plus categorized emoji stickers. */
import * as React from 'react'
import { tr } from '../remote'
import { ICONS, ICON_LIST } from '../drawing-tools'
import { STICKERS, isSingleEmoji } from '../../../lib/chart-drawings.js'

const TABS: Array<['icons' | keyof typeof STICKERS, string, string]> = [['icons', '图标', 'Icons'], ['trading', '交易', 'Trading'], ['faces', '表情', 'Faces'], ['symbols', '符号', 'Symbols']]

export function StickerPicker({ onPick }: { onPick: (label: string) => void }) {
  const [tab, setTab] = React.useState<(typeof TABS)[number][0]>('icons')
  const [custom, setCustom] = React.useState('')
  const value = custom.trim()
  const valid = isSingleEmoji(value)
  return <div className="dhl-sticker-picker">
    <form className="dhl-sticker-custom" onSubmit={(event) => { event.preventDefault(); if (valid) onPick(`emoji:${value}`) }}>
      <input value={custom} onChange={(event) => setCustom(event.target.value)} placeholder={tr('输入或粘贴任意 emoji，例如 🦄', 'Type or paste any emoji, e.g. 🦄')} aria-label={tr('自定义 emoji 贴纸', 'Custom emoji sticker')} maxLength={16} />
      <button type="submit" disabled={!valid}>{tr('放置', 'Place')}</button>
    </form>
    <div className="dhl-sticker-tabs" role="tablist">
      {TABS.map(([id, zh, en]) => <button type="button" role="tab" key={id} aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{tr(zh, en)}</button>)}
    </div>
    {tab === 'icons' ? <div className="dhl-icon-grid" role="group" aria-label={tr('图标', 'Icons')}>
      {ICON_LIST.map((name) => <button type="button" key={name} aria-label={tr(ICONS[name][0], ICONS[name][1])} title={tr(ICONS[name][0], ICONS[name][1])} onClick={() => onPick(name)}>
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ICONS[name][2]} /></svg>
        <span>{tr(ICONS[name][0], ICONS[name][1])}</span>
      </button>)}
    </div> : <div className="dhl-sticker-grid" role="group" aria-label={tr('贴纸', 'Stickers')}>
      {STICKERS[tab].map((emoji) => <button type="button" key={emoji} aria-label={`${tr('贴纸', 'Sticker')} ${emoji}`} onClick={() => onPick(`emoji:${emoji}`)}>{emoji}</button>)}
    </div>}
  </div>
}
