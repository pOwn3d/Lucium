// The accessibility preferences the user can force, and how they reach a document. The system's own (prefers-contrast, prefers-reduced-motion,
// prefers-reduced-transparency) are read by the stylesheets as they always were; a setting only adds an attribute on the root, which tokens.css answers
// like the media query. A switch can ask for more (more contrast, less motion, less transparency), never for less than the system asks: the media blocks
// of the sheets cannot be undone from outside, so "Follow the system" is the off state and nothing forces the opposite.

import type { Settings } from './model'

export type AccessibilitySettings = Pick<Settings, 'forceHighContrast' | 'forceReduceMotion' | 'forceReduceTransparency'>

/** The attribute of the root each preference sets (tokens.css reads them), and the value it takes when the preference is forced. */
export const ACCESSIBILITY_ATTRIBUTES = {
  forceHighContrast: ['data-contrast', 'more'],
  forceReduceMotion: ['data-motion', 'reduce'],
  forceReduceTransparency: ['data-transparency', 'reduce']
} as const satisfies Record<keyof AccessibilitySettings, readonly [string, string]>

/** The part of an element that `applyAccessibility` needs (a test gives it a recorder). */
export interface AttributeHost {
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
}

/** Puts on the root the attributes of the forced preferences, and takes off those of a preference that is no longer forced. Idempotent: a snapshot calls it each time. */
export function applyAccessibility(root: AttributeHost, settings: AccessibilitySettings): void {
  for (const [key, [name, value]] of Object.entries(ACCESSIBILITY_ATTRIBUTES) as Array<[keyof AccessibilitySettings, readonly [string, string]]>) {
    if (settings[key]) root.setAttribute(name, value)
    else root.removeAttribute(name)
  }
}
