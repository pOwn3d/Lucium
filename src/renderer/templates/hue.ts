// The hue of a space, as the templates take it (the colour of the space gives the accent). A panel opened for a space puts its hue on its
// own root; the tokens (tokens.css) derive the accent and the tinted surfaces from it.

import type { CSSProperties } from 'react'
import { themeHue } from '@shared/theme'
import type { Space } from '@shared/model'

/** The class that makes an element work out the accent from its own `--hue` (tokens.css). */
export const HUE_CLASS = 'tk-hue'

/** The hue of the space `activeSpaceId`, or `undefined` for a panel with no space (it then keeps the hue of the document). */
export function activeSpaceHue(spaces: readonly Pick<Space, 'id' | 'theme'>[], activeSpaceId: string | null | undefined): number | undefined {
  const space = spaces.find((candidate) => candidate.id === activeSpaceId)
  return space ? themeHue(space.theme) : undefined
}

/** The class and the style a root takes for a hue; nothing for no hue, so that a panel without a space adds no rule. */
export function hueProps(hue: number | undefined): { className: string; style?: CSSProperties } {
  if (hue === undefined || !Number.isFinite(hue)) return { className: '' }
  return { className: HUE_CLASS, style: { '--hue': Math.round(((hue % 360) + 360) % 360) } as CSSProperties }
}
