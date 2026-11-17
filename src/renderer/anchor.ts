import type { PlusAnchor } from '@shared/plus-menu'

/** The place of an element in the window (CSS pixels, from its top left corner): what a panel opened from it hangs from (`anchor` of an overlay request). */
export function rectOf(element: Element): PlusAnchor {
  const { x, y, width, height } = element.getBoundingClientRect()
  return { x, y, width, height }
}
