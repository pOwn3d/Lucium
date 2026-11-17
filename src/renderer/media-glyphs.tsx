// The play and pause pictograms, drawn once: those of the media player at the foot of the sidebar. Every control that plays or pauses something
// (the sound of a tab in the media player, the floating video, the video behind a space, a download, the animated card of a setting) shows these
// two, at the height its button needs, so that play and pause look the same wherever they are. media-glyphs.test.ts refuses a second drawing.

/** Their height in the media player, in px. The width follows the drawing: play 11 x 12, pause 9 x 12. */
const MEDIA_PLAYER_HEIGHT = 12

/** A triangle pointing right, filled, its corners rounded by a stroke of the same colour. */
export function PlayGlyph({ height = MEDIA_PLAYER_HEIGHT }: { height?: number }) {
  return (
    <svg viewBox="0 0 11 12" width={(height * 11) / 12} height={height} fill="currentColor" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.5" aria-hidden="true">
      <path d="M1.6 1.5v9L9.6 6z" />
    </svg>
  )
}

/** Two filled bars with rounded corners. */
export function PauseGlyph({ height = MEDIA_PLAYER_HEIGHT }: { height?: number }) {
  return (
    <svg viewBox="0 0 9 12" width={(height * 9) / 12} height={height} fill="currentColor" aria-hidden="true">
      <rect x="0" y="0" width="3" height="12" rx="0.9" />
      <rect x="6" y="0" width="3" height="12" rx="0.9" />
    </svg>
  )
}
