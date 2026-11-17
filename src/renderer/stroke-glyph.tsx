// A stroked glyph on a 24 × 24 grid (paths and circles), drawn in the colour of the text: the icons of the sheet « Effacer les données du site »
// and of the choice of its animation in Réglages, after the extension they come from.

import type { GlyphPart } from '@shared/site-data-overlay'

export function StrokeGlyph({ parts, size = 16, stroke = 2, className }: { parts: readonly GlyphPart[]; size?: number; stroke?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {parts.map((part, i) => ('d' in part ? <path key={i} d={part.d} /> : <circle key={i} cx={part.circle[0]} cy={part.circle[1]} r={part.circle[2]} />))}
    </svg>
  )
}

/** The icons of the sheet. */
export const SHEET_ICONS = {
  trash: [{ d: 'M3 6h18' }, { d: 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6' }, { d: 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' }, { d: 'M10 11v6' }, { d: 'M14 11v6' }],
  busy: [{ d: 'M21 12a9 9 0 1 1-6.219-8.56' }],
  plus: [{ d: 'M5 12h14' }, { d: 'M12 5v14' }],
  check: [{ d: 'M20 6 9 17l-5-5' }],
  cross: [{ d: 'M18 6 6 18' }, { d: 'm6 6 12 12' }],
  sliders: [{ d: 'M20 7h-9' }, { d: 'M14 17H5' }, { circle: [17, 17, 3] }, { circle: [7, 7, 3] }],
  warning: [{ d: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3' }, { d: 'M12 9v4' }, { d: 'M12 17h.01' }]
} as const satisfies Record<string, readonly GlyphPart[]>
