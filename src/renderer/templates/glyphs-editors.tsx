// The glyphs of the small editors and of the permission bubble: the same family as glyphs.tsx, 1.5 px stroke on a 16 grid.

import type { ReactNode } from 'react'

const svg = (children: ReactNode): ReactNode => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
    {children}
  </svg>
)

export const TabGlyph = (): ReactNode => svg(<><rect x="1.75" y="3.25" width="12.5" height="9.5" rx="2" /><path d="M1.75 6.25h12.5M6 3.25v3" /></>)
export const StarGlyph = (): ReactNode => svg(<path d="m8 1.75 1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.5l-3.8 2 .7-4.3-3.1-3 4.3-.6Z" />)
export const ReloadGlyph = (): ReactNode => svg(<><path d="M13.25 8A5.25 5.25 0 1 1 11.6 4.2" /><path d="M13.25 2.5v3h-3" /></>)
export const WindowGlyph = (): ReactNode => svg(<><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" /><path d="M1.75 5.75h12.5" /></>)
export const PinGlyph = (): ReactNode => svg(<><path d="M8 14s4.5-3.9 4.5-7.5a4.5 4.5 0 0 0-9 0C3.5 10.100 8 14 8 14Z" /><circle cx="8" cy="6.5" r="1.600" /></>)
export const CameraGlyph = (): ReactNode => svg(<><rect x="1.75" y="4.25" width="9" height="7.5" rx="1.750" /><path d="m10.750 7 3.500-2v6l-3.500-2" /></>)
export const BellGlyph = (): ReactNode => svg(<><path d="M3.500 11.500h9M4.500 11.500V7a3.500 3.500 0 0 1 7 0v4.500" /><path d="M6.700 13.500a1.400 1.400 0 0 0 2.600 0" /></>)
