// The two small buttons above the footer of the sidebar, while the space on screen has a video behind it: Pause / Lire, and « Toujours lire » (the
// video plays now and goes on while another window or application is in front). Both are the space's own choice, written in its background, as the Fond
// panel writes its pause: the user decides, here, without opening a panel.

import type { Space } from '@shared/model'
import { toggledAlwaysPlay, toggledVideoPause, videoAlwaysPlays, videoBackgroundPaused } from '@shared/space-media'
import { t } from '@shared/i18n'
import { api } from './api'
import { PauseGlyph, PlayGlyph } from './media-glyphs'

/** The height of play and pause in these 26 px buttons, beside the 14 px infinity sign. */
const GLYPH_HEIGHT = 10

/** The infinity sign: the video plays all the time. */
function AlwaysGlyph() {
  return (
    <svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <path d="M7 7C5.9 5.6 5 4.6 3.6 4.6a2.4 2.4 0 0 0 0 4.8C5 9.4 5.9 8.4 7 7s2-2.4 3.4-2.4a2.4 2.4 0 0 1 0 4.8C9 9.4 8.1 8.4 7 7z" />
    </svg>
  )
}

/**
 * The controls, for the space on screen; nothing when its background is not a video. `reduceMotion`: the system's or Lucium's wish for less motion.
 * `saving`: the battery saver is on, which holds the video still; the second button says so, unless the space already holds it (then the saver changes nothing).
 */
export function BackgroundVideoControls({ space, reduceMotion, saving = false }: { space: Pick<Space, 'id' | 'background'>; reduceMotion: boolean; saving?: boolean }) {
  const background = space.background
  if (!background || background.type !== 'video' || !background.value) return null
  const paused = videoBackgroundPaused(background, reduceMotion)
  const always = videoAlwaysPlays(background, reduceMotion)
  const heldBySaver = saving && !paused
  const write = (next: typeof background) => void api().dispatch({ type: 'space/update', id: space.id, patch: { background: next } })
  const pauseLabel = paused ? t('sidebar.lire-la-video-de-fond') : t('sidebar.mettre-en-pause-la-video-de-fond')
  return (
    <div className="bg-video-controls" role="group" aria-label={t('sidebar.video-de-fond')}>
      {/* A dark pill under the buttons: they read over a bright video as well as a dark one (sidebar.css). */}
      <div className="bg-video-pill">
        <button type="button" className="bg-video-button" aria-label={pauseLabel} data-tip={pauseLabel} onClick={() => write(toggledVideoPause(background, reduceMotion))}>
          {paused ? <PlayGlyph height={GLYPH_HEIGHT} /> : <PauseGlyph height={GLYPH_HEIGHT} />}
        </button>
        {/* Pressed while the video plays all the time; a click on it while the video is paused plays it, for good. */}
        <button
          type="button"
          className="bg-video-button"
          aria-pressed={always}
          aria-label={t('sidebar.toujours-lire-la-video-de-fond')}
          data-tip={heldBySaver ? t('sidebar.en-pause-tant-que-le-mode-economie-de-batterie-est-active') : always ? t('sidebar.la-video-tourne-tout-le-temps') : t('sidebar.la-video-s-arrete-hors-premier-plan')}
          onClick={() => write(toggledAlwaysPlay(background, reduceMotion))}
        >
          <AlwaysGlyph />
        </button>
      </div>
    </div>
  )
}
