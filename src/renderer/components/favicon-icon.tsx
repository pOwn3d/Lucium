import { FC } from 'react'

/**
 * Globe favicon icon (default for tabs without a site favicon).
 * Uses currentColor for automatic light/dark mode support.
 * Hidden from a screen reader, as the other glyphs of a row are: it stands for a missing icon, and the title beside it names the page.
 */
export const FaviconIcon: FC<{ className?: string }> = ({ className = '' }) => (
  <svg
    viewBox="0 0 16 16"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
    aria-hidden="true"
    focusable="false"
  >
    {/* Globe outline */}
    <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1" />
    {/* Longitude lines */}
    <path d="M8 1 Q12 8 8 15 Q4 8 8 1" fill="none" stroke="currentColor" strokeWidth="0.75" />
    {/* Latitude lines */}
    <ellipse cx="8" cy="8" rx="7" ry="3" fill="none" stroke="currentColor" strokeWidth="0.75" />
    <ellipse cx="8" cy="8" rx="7" ry="1.5" fill="none" stroke="currentColor" strokeWidth="0.75" />
  </svg>
)

/** The outline of the puzzle piece, the one mark of the Extensions page: its tab (below) and the button of the site panel that opens it draw this path. */
export const EXTENSIONS_PUZZLE_PATH =
  'M10 4a2 2 0 1 1 4 0v1h3a1 1 0 0 1 1 1v3h1a2 2 0 1 1 0 4h-1v3a1 1 0 0 1-1 1h-3v1a2 2 0 1 1-4 0v-1H7a1 1 0 0 1-1-1v-3H5a2 2 0 1 1 0-4h1V6a1 1 0 0 1 1-1h3V4Z'

/**
 * The icon of the Extensions page, a puzzle piece: that page has no site to stand for it (no host, so no monogram) and declares no icon of its own.
 * Drawn like the globe: the text colour, hidden from a screen reader (the title beside it names the page).
 */
export const ExtensionsFaviconIcon: FC<{ className?: string }> = ({ className = '' }) => (
  <svg viewBox="3 3 18 18" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true" focusable="false">
    <path
      d={EXTENSIONS_PUZZLE_PATH}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
    />
  </svg>
)

export default FaviconIcon
