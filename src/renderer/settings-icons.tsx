// The pictograms of the pages of the Settings sidebar: one family, a 24 px grid, a 1.5 px stroke with round ends.

import type { ReactNode } from 'react'
import type { CategoryIcon } from '@shared/settings-catalog'

const PATHS: Record<CategoryIcon, ReactNode> = {
  home: <path d="M4 11 12 4.500l8 6.500v8a1 1 0 0 1-1 1h-4.500v-6h-5v6H5a1 1 0 0 1-1-1v-8Z" />,
  palette: (
    <>
      <path d="M12 3a9 9 0 1 0 0 18c1.500 0 2.200-1 1.800-2.200-.4-1.300.4-2.500 1.900-2.500h1.500a3 3 0 0 0 3-3C20.200 7.100 16.500 3 12 3Z" />
      <path d="M7.500 12h.01M10 7.500h.01M14.500 7.500h.01" strokeWidth="2.200" />
    </>
  ),
  tab: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <path d="M3 10h18M8 5v5" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3 4 6v6c0 5 3.500 8 8 9 4.500-1 8-4 8-9V6l-8-3Z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v11m0 0 4-4m-4 4-4-4" />
      <path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2" />
    </>
  ),
  puzzle: <path d="M10 4a2 2 0 1 1 4 0v1h3a1 1 0 0 1 1 1v3h1a2 2 0 1 1 0 4h-1v3a1 1 0 0 1-1 1h-3v1a2 2 0 1 1-4 0v-1H7a1 1 0 0 1-1-1v-3H5a2 2 0 1 1 0-4h1V6a1 1 0 0 1 1-1h3V4Z" />,
  person: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.500" />
      <path d="m20 20-4.200-4.200" />
    </>
  ),
  keyboard: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="2.500" />
      <path d="M7 10h.01M10.500 10h.01M14 10h.01M17.500 10h.01M8 14h8" strokeWidth="1.800" />
    </>
  ),
  sparkle: <path d="M12 3.500 13.900 9l5.600 1.900-5.600 1.900L12 18.500l-1.900-5.700-5.600-1.900L10.100 9 12 3.500ZM18.500 16.500l.7 1.800 1.800.7-1.800.7-.7 1.800-.7-1.800-1.800-.7 1.800-.7.7-1.800Z" />,
  info: (
    <>
      <circle cx="12" cy="12" r="8.500" />
      <path d="M12 11v5.500M12 7.800h.01" strokeWidth="1.800" />
    </>
  )
}

/** The pictogram of a category, as drawn in the sidebar (16 px). */
export function CategoryGlyph({ icon, size = 16 }: { icon: CategoryIcon; size?: number }) {
  return (
    <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.500" strokeLinecap="round" strokeLinejoin="round">
      {PATHS[icon]}
    </svg>
  )
}
