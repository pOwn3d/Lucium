// The answer to getDisplayMedia on a system that has no picker of its own: the sources are listed, the user picks one in a menu, and the
// page gets that one. Everything that touches the system (the list of sources, the menu, the macOS authorization) is handed in, so the
// order of the checks is tested without capturing anything. Called by Electron for every share: the system's picker (`useSystemPicker`) is not asked for.

import { nothingToShareNotice, screenAccessNotice, shareChoices, shareFailedNotice, shareRefusal, shareStreams, type ShareChoice, type ShareSource, type ShareStreams } from '@shared/display-media'

/** The part of Electron's request this needs. `frame` is null once the page has navigated away or is gone. */
export interface DisplayMediaRequest {
  frame: { url: string } | null
  userGesture: boolean
  videoRequested: boolean
  audioRequested: boolean
}

export interface DisplayMediaDeps {
  platform: string
  /** The user's answer to the system question about recording the screen ('granted' where the system asks none). */
  screenAccess(): 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'
  /** What the system can share. Rejects when it cannot say. */
  listSources(): Promise<ShareSource[]>
  /** Shows the choices to the user for the page that asked; resolves with the id picked, or null when they gave up. */
  choose(request: DisplayMediaRequest, choices: ShareChoice[]): Promise<string | null>
  /** Sharing did not start: tells the user, in the window of the page that asked (`openSettings`: the cause is the screen permission). */
  blocked(request: DisplayMediaRequest, notice: string, openSettings?: boolean): void
  warn(message: string, detail?: unknown): void
}

/** Electron's `setDisplayMediaRequestHandler` callback: the streams to give the page, or null to refuse. */
type Answer = (streams: ShareStreams | null) => void

/** The origin of an address for a log line: never the path or the query, which can carry what the user is reading. */
const originForLog = (url: string): string => (URL.canParse(url) ? new URL(url).origin : 'unknown address')

export function createDisplayMediaHandler(deps: DisplayMediaDeps): (request: DisplayMediaRequest, callback: Answer) => void {
  return (request, callback) => {
    // A callback that throws (Electron does when the frame is gone) is told in the log, not lost.
    const answer: Answer = (streams) => {
      try {
        callback(streams)
      } catch (error) {
        deps.warn(`[display-media] the answer could not be delivered to ${originForLog(request.frame?.url ?? '')}:`, error)
      }
    }

    const refusal = shareRefusal({ url: request.frame?.url ?? '', userGesture: request.userGesture, videoRequested: request.videoRequested })
    if (refusal) {
      deps.warn(`[display-media] refused (${refusal}) for ${originForLog(request.frame?.url ?? '')}`)
      return answer(null)
    }

    // The system question is the user's: when they said no, the list would hold displays with no windows named; say why instead.
    const refuseForAccess = (access: string): null => {
      deps.warn(`[display-media] the system does not let the application record the screen (${access})`)
      deps.blocked(request, screenAccessNotice(), true)
      return null
    }
    const access = deps.screenAccess()
    if (access === 'restricted') return answer(refuseForAccess(access))

    // macOS answers "denied" both when the user refused and when nobody ever asked: listing the sources is what makes the system ask (and put
    // the app in Réglages Système › Enregistrement de l'écran), so the list is asked for, and the answer read again after it.
    deps
      .listSources()
      .then((sources) => {
        if (access === 'denied' && deps.screenAccess() !== 'granted') return refuseForAccess('denied')
        const choices = shareChoices(sources)
        if (choices.length === 0) {
          deps.warn('[display-media] nothing to share was listed')
          // The page only learns that the request was refused: the user is told why, in the window of the page.
          deps.blocked(request, nothingToShareNotice())
          return null
        }
        return deps.choose(request, choices).then((id) => choices.find((c) => c.id === id) ?? null)
      })
      .then((choice) => answer(choice ? shareStreams(choice, request.audioRequested, deps.platform) : null))
      .catch((error: unknown) => {
        deps.warn(`[display-media] sharing could not start for ${originForLog(request.frame?.url ?? '')}:`, error)
        deps.blocked(request, shareFailedNotice())
        answer(null)
      })
  }
}
