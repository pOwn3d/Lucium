// The glyphs of the panel templates: one family, 1.5 px stroke on a 16 grid (the stroke is set by the panel, see primitives.css). They are decorative:
// the title or the label next to them says the same thing.

import type { ReactNode } from 'react'

const svg = (children: ReactNode, size = 16): ReactNode => (
  <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" focusable="false">
    {children}
  </svg>
)

export const SearchGlyph = (): ReactNode => svg(<><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></>)
export const DownloadGlyph = (): ReactNode => svg(<><path d="M8 2.5v8M4.5 7.5 8 11l3.5-3.5" /><path d="M3 13.5h10" /></>)
export const ArchiveGlyph = (): ReactNode => svg(<><rect x="2" y="3" width="12" height="3" rx="1" /><path d="M3 6v6.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6M6.5 9h3" /></>)
export const ClockGlyph = (): ReactNode => svg(<><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3.2l2 1.3" /></>)
export const QrGlyph = (): ReactNode => svg(<><rect x="2.5" y="2.5" width="4" height="4" rx="0.5" /><rect x="9.5" y="2.5" width="4" height="4" rx="0.5" /><rect x="2.5" y="9.5" width="4" height="4" rx="0.5" /><path d="M9.5 9.5h1.5v1.5M13.5 9.5v4M11 13.5h1" /></>)
export const LockGlyph = (): ReactNode => svg(<><rect x="3" y="7" width="10" height="6.5" rx="1.5" /><path d="M5.5 7V5.5a2.5 2.5 0 0 1 5 0V7" /></>)
export const KeyGlyph = (): ReactNode => svg(<><circle cx="5.5" cy="8" r="2.5" /><path d="M8 8h5.5M11.5 8v2" /></>)
export const AlertGlyph = (): ReactNode => svg(<><path d="M8 2.5 14 13H2z" /><path d="M8 6.5v3M8 11.5v.1" /></>)
export const InfoGlyph = (): ReactNode => svg(<><circle cx="8" cy="8" r="5.5" /><path d="M8 7.5v3.5M8 5.3v.1" /></>)
export const PlusGlyph = (): ReactNode => svg(<path d="M8 3v10M3 8h10" />)
export const TrashGlyph = (): ReactNode => svg(<><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" /></>)
export const FolderGlyph = (): ReactNode => svg(<path d="M2 4.5A1.5 1.5 0 0 1 3.500 3H6l1.500 1.500h5A1.500 1.500 0 0 1 14 6v5.500a1.500 1.500 0 0 1-1.500 1.500h-9A1.500 1.500 0 0 1 2 11.500z" />)
export const BookmarkGlyph = (): ReactNode => svg(<path d="M4.5 2.5h7a.5.5 0 0 1 .5.5v10.5L8 10.5l-4 3V3a.5.5 0 0 1 .5-.5Z" />)
