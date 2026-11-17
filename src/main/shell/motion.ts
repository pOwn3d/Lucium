import { systemPreferences } from 'electron'

/** Whether the system asks for less motion (macOS: Accessibility › Display › Reduce motion). The interface follows `prefers-reduced-motion` on its own; the main process asks here. */
export function prefersReducedMotion(): boolean {
  try {
    return systemPreferences.getAnimationSettings().prefersReducedMotion
  } catch (error) {
    // Not available on this platform: the animation plays rather than a setting being guessed.
    console.warn('[motion] cannot read the system animation settings:', (error as Error).message)
    return false
  }
}
