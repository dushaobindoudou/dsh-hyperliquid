import * as React from 'react'

export type PanelKind = 'sessions' | 'desk' | 'chat'

const paths: Record<PanelKind, React.ReactNode> = {
  sessions: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M12 9h6M12 13h6" /></>,
  desk: <><path d="M3 19h18M4 15l4-5 4 3 5-7 3 2" /><circle cx="17" cy="6" r="1" /></>,
  chat: <><path d="M4 5h16v11H9l-5 4V5Z" /><path d="M8 9h8M8 12h5" /></>,
}

export function PanelIcon({ kind, size = 18 }: { kind: PanelKind; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[kind]}</svg>
}

export function FoldIcon({ direction }: { direction: 'left' | 'right' }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d={direction === 'left' ? 'M9 4v16m7-11-3 3 3 3' : 'M15 4v16m-7-11 3 3-3 3'} />
  </svg>
}

export function SearchIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 5 5" /></svg>
}

export type UiIconName = 'chevronDown' | 'chevronRight' | 'arrowDown' | 'arrowUp' | 'more' | 'settings' | 'info' | 'close' | 'plus' | 'check' | 'star' | 'pencil' | 'archive' | 'coin'
  | 'bell' | 'sync' | 'trash' | 'lock' | 'unlock' | 'eye' | 'eyeOff' | 'copy' | 'save' | 'cursor' | 'calendar' | 'download' | 'camera' | 'help' | 'live'

/** Shared outline icons, aligned on the same 24px grid as the panel icons. */
export function UiIcon({ name, size = 16, filled = false }: { name: UiIconName; size?: number; filled?: boolean }) {
  const paths: Record<UiIconName, React.ReactNode> = {
    cursor: <path d="m5 3 14 10-7 1-3 7z" />,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M7 3v4m10-4v4M3 11h18M7 15h3m4 0h3M7 18h3" /></>,
    download: <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />,
    camera: <><path d="M3 7h4l2-3h6l2 3h4v14H3z" /><circle cx="12" cy="13" r="4" /></>,
    help: <><circle cx="12" cy="12" r="9" /><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 5m0 3h.01" /></>,
    live: <path d="m4 4 10 8L4 20zm14 0v16" />,
    chevronDown: <path d="m6 9 6 6 6-6" />,
    chevronRight: <path d="m9 6 6 6-6 6" />,
    bell: <path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0" />,
    sync: <path d="M4 9h13l-3-3M20 15H7l3 3" />,
    trash: <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" />,
    lock: <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
    unlock: <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 7.5-2" /></>,
    eye: <><path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z" /><circle cx="12" cy="12" r="2.5" /></>,
    eyeOff: <path d="M3 3l18 18M10.6 6.1A9.7 9.7 0 0 1 12 6c6 0 9.5 6 9.5 6a16 16 0 0 1-3 3.6M6.3 7.6A16 16 0 0 0 2.5 12S6 18 12 18a9 9 0 0 0 4.3-1.1" />,
    copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" /></>,
    save: <path d="M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6" />,
    arrowDown: <path d="M12 4v16m-6-6 6 6 6-6" />,
    arrowUp: <path d="M12 20V4m-6 6 6-6 6 6" />,
    more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
    // Gear outline after Lucide's "settings" (ISC licence, see NOTICE): an even 8-tooth gear on the 24px grid.
    settings: <><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></>,
    info: <><circle cx="12" cy="12" r="10" /><path d="M12 11v5M12 8h.01" /></>,
    close: <path d="M18 6 6 18M6 6l12 12" />,
    plus: <path d="M12 5v14M5 12h14" />,
    check: <path d="m5 12 4 4L19 6" />,
    star: <path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2Z" />,
    pencil: <><path d="m15 5 4 4M4 20l4.5-1 10-10a2.83 2.83 0 0 0-4-4l-10 10L4 20Z" /></>,
    archive: <><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v12h14V8M10 12h4" /></>,
    coin: <><circle cx="12" cy="12" r="9" /><path d="M15.5 8.5c-.7-.8-1.9-1.2-3.5-1.2-2.1 0-3.5.9-3.5 2.5 0 3.7 7 1.5 7 5.1 0 1.5-1.4 2.6-3.5 2.6-1.6 0-2.8-.4-3.7-1.3M12 5v14" /></>,
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill={name === 'star' && filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[name]}</svg>
}
