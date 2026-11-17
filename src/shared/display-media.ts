// Sharing the screen or a window in a video call (`navigator.mediaDevices.getDisplayMedia`), as pure rules. The engine applies them
// (main/engine/display-media.ts). The picker is Lucium's own on every system: the picker of the operating system (macOS 15 and later) is
// never asked for, it crashes the application in Electron 45. These are its rules: who may ask, and what the answer carries.

/** What can be shared: a whole display, or one window. The picker of the system does not list the tabs of a browser either. */
import { t } from './i18n'

export type ShareKind = 'screen' | 'window'

/** A source as `desktopCapturer` names it: `screen:<n>:0` or `window:<n>:<n>`. The name is the window's title, written by another application. */
export interface ShareSource {
  id: string
  name: string
}

/** A line of the picker: what the user reads, and the source it stands for. */
export interface ShareChoice {
  id: string
  kind: ShareKind
  label: string
}

/** Only the windows in front are listed: a desktop can hold hundreds, and a menu is not a list one scrolls. */
export const SHARE_WINDOWS_MAX = 30
/** A window title can be as long as a document name. */
export const SHARE_LABEL_MAX = 70

const SOURCE_ID = /^(screen|window):\d{1,10}:\d{1,10}$/
const CONTROL = /\p{Cc}/gu

/**
 * The lines of the picker: the displays first ("Écran entier" when there is only one), then the windows in the order the system gives
 * them (front first), without the ones that have no title (the system gives none for a window it will not name) and with long titles
 * cut. A source whose id is not one of the two shapes is not offered: what the user picks is what the page gets.
 */
export function shareChoices(sources: readonly ShareSource[]): ShareChoice[] {
  const kindOf = (id: unknown): ShareKind | null => (typeof id === 'string' ? ((SOURCE_ID.exec(id)?.[1] as ShareKind | undefined) ?? null) : null)
  const screens = sources.filter((s) => kindOf(s.id) === 'screen')
  const choices: ShareChoice[] = screens.map((s, i) => ({ id: s.id, kind: 'screen', label: screens.length === 1 ? t('display-media.ecran-entier') : t('display-media.ecran-n', { n: i + 1 }) }))
  let windows = 0
  for (const source of sources) {
    if (kindOf(source.id) !== 'window') continue
    if (windows >= SHARE_WINDOWS_MAX) break
    const title = String(source.name ?? '').replace(CONTROL, ' ').trim()
    if (title === '') continue
    windows++
    choices.push({ id: source.id, kind: 'window', label: title.length > SHARE_LABEL_MAX ? `${title.slice(0, SHARE_LABEL_MAX - 1)}…` : title })
  }
  return choices
}

/** Why a request to share is refused before anything is offered; null when it may go on. */
export type ShareRefusal = 'not-a-web-page' | 'no-user-gesture' | 'no-video'

export interface ShareRequest {
  /** The address of the frame that asks, '' when the frame is gone. */
  url: string
  /** Whether the page asked while handling a click or a key. */
  userGesture: boolean
  videoRequested: boolean
}

/**
 * Who may share: a web page (not a file, not a page of the interface or of an extension) that asked because the user just did
 * something, and that asked for a picture: a call needs the picture, and a page that asks only for sound is not sharing a screen.
 */
export function shareRefusal(request: ShareRequest): ShareRefusal | null {
  if (!URL.canParse(request.url) || !['http:', 'https:'].includes(new URL(request.url).protocol)) return 'not-a-web-page'
  if (!request.userGesture) return 'no-user-gesture'
  if (!request.videoRequested) return 'no-video'
  return null
}

/** What the page gets: the picture of the source and, in one case only, sound. */
export interface ShareStreams {
  video: { id: string; name: string }
  audio?: 'loopback'
}

/**
 * The answer for a chosen source. The sound of the system is offered only when the page asked for it, for a whole display, and where
 * Electron can capture it (Windows: `loopback`); on macOS and Linux the page gets the picture alone, and it is told nothing of sound.
 */
export function shareStreams(choice: ShareChoice, audioRequested: boolean, platform: string): ShareStreams {
  const streams: ShareStreams = { video: { id: choice.id, name: choice.label } }
  if (audioRequested && platform === 'win32' && choice.kind === 'screen') streams.audio = 'loopback'
  return streams
}

/** The notice when the system will not let the application see the screen (macOS: Enregistrement de l'écran). */
export const screenAccessNotice = (): string => t('display-media.autorisez-lucium-a-enregistrer-l-ecran')

/** The button of that notice, and the pane it opens: Réglages Système › Confidentialité et sécurité › Enregistrement de l'écran. */
export const screenSettingsLabel = (): string => t('display-media.ouvrir-les-reglages')
export const SCREEN_RECORDING_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'

/** The notices when the user asked to share and the picker has nothing to offer, or could not be made: the page only learns that the request was refused. */
export const nothingToShareNotice = (): string => t('display-media.rien-a-partager')
export const shareFailedNotice = (): string => t('display-media.le-partage-n-a-pas-pu-demarrer')
