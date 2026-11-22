// Loaded into the main frame of every web page (registered by the engine, see electron-engine.ts; Electron loads a preload into the main
// frame only, so the media of an embedded frame are driven by scripts from the engine instead). It gives the media player of the
// sidebar the two things a page's own scripts keep to themselves:
//  - the MediaSession handlers of the site ("previous track", "next track"): the engine cannot reach a handler the site registered, so
//    the page's `setActionHandler` is wrapped to remember them, and the shell can run them;
//  - a volume for the whole tab: Chromium has no per-tab level (only mute), so the `volume` of every media element is scaled by a factor.
//    The page keeps seeing the volume it asked for: the wrapped property answers with its own value and applies value x factor.
// Nothing is added to the page that a script could find, apart from the wrapped functions themselves.

import { contextBridge, ipcRenderer } from 'electron'
import { MEDIA_BRIDGE, SESSION_ACTIONS, parseVolume } from '../shared/media-player'
import { canReachMainWorld } from './main-world'

interface MainWorldMedia {
  setFactor(factor: number): void
  run(name: string): boolean
}

/** Self-contained on purpose: Electron serializes this function and runs it in the main world, before the scripts of the page. */
function mainWorldMedia(report: (names: string[]) => void): MainWorldMedia | null {
  const handlers = new Map<string, unknown>()
  let factor = 1
  let lastWalk = 0
  /** What the page set as the volume of an element (the element itself holds that times the factor). */
  const asked = new WeakMap<object, number>()
  const refs = new WeakMap<object, WeakRef<HTMLMediaElement>>()
  const known = new Set<WeakRef<HTMLMediaElement>>()
  const media = (globalThis as unknown as { HTMLMediaElement?: typeof HTMLMediaElement }).HTMLMediaElement
  const session = (globalThis as unknown as { MediaSession?: { prototype: { setActionHandler: (...args: unknown[]) => unknown } } }).MediaSession

  if (session && typeof session.prototype.setActionHandler === 'function') {
    const original = session.prototype.setActionHandler
    session.prototype.setActionHandler = function (this: unknown, ...args: unknown[]) {
      // The browser's own checks first: an action it does not know throws, and must not be remembered.
      const result = original.apply(this, args)
      if (typeof args[1] === 'function') handlers.set(String(args[0]), args[1])
      else handlers.delete(String(args[0]))
      report([...handlers.keys()])
      return result
    }
  }

  const descriptor = media ? Object.getOwnPropertyDescriptor(media.prototype, 'volume') : undefined
  const nativeGet = descriptor?.get
  const nativeSet = descriptor?.set
  /** Remembers the element so that a new factor reaches it (weakly: a page that drops its elements must not be kept alive by this). */
  const track = (element: HTMLMediaElement) => {
    if (refs.has(element)) return
    const ref = new WeakRef(element)
    refs.set(element, ref)
    known.add(ref)
  }
  /** What the page has set on the element (its level when first seen, if it never set one). */
  const adopt = (element: HTMLMediaElement): number => {
    let level = asked.get(element)
    if (level === undefined) {
      level = nativeGet!.call(element) as number
      asked.set(element, level)
    }
    track(element)
    return level
  }
  const apply = (element: HTMLMediaElement) => nativeSet!.call(element, adopt(element) * factor)

  if (media && nativeGet && nativeSet) {
    Object.defineProperty(media.prototype, 'volume', {
      configurable: true,
      enumerable: descriptor!.enumerable,
      get(this: HTMLMediaElement) {
        return asked.has(this) ? asked.get(this) : nativeGet.call(this)
      },
      set(this: HTMLMediaElement, value: number) {
        // The page's own validation first (a volume above 1 throws), then its level is kept and the scaled one is applied.
        nativeSet.call(this, value)
        if (factor === 1 && !asked.has(this)) return
        asked.set(this, nativeGet.call(this) as number)
        track(this)
        nativeSet.call(this, (asked.get(this) as number) * factor)
      }
    })
    // An element that starts playing after the factor was set (the next track, a new player) is brought to it before the first sound.
    const play = media.prototype.play
    media.prototype.play = function (this: HTMLMediaElement, ...args: []) {
      if (factor !== 1 && !asked.has(this)) apply(this)
      return play.apply(this, args)
    }
    document.addEventListener(
      'loadstart',
      (event) => {
        const target = event.target
        if (factor !== 1 && target instanceof media && !asked.has(target)) apply(target)
      },
      true
    )
  }

  const walk = (root: ParentNode) => {
    for (const element of root.querySelectorAll('video, audio')) if (!asked.has(element)) apply(element as HTMLMediaElement)
    for (const host of root.querySelectorAll('*')) if (host.shadowRoot) walk(host.shadowRoot)
  }

  return {
    setFactor(next: number) {
      factor = next
      if (!media || !nativeGet || !nativeSet) return
      for (const ref of known) {
        const element = ref.deref()
        if (element) apply(element)
        else known.delete(ref)
      }
      // The elements nothing has touched yet; the whole document is only walked now and then (the slider sends many values).
      if (Date.now() - lastWalk > 1000) {
        lastWalk = Date.now()
        walk(document)
      }
    },
    run(name: string) {
      const handler = handlers.get(name)
      if (typeof handler !== 'function') return false
      handler.call((globalThis as unknown as { navigator: { mediaSession: unknown } }).navigator.mediaSession, { action: name })
      return true
    }
  }
}

/** The handler names of the page, sent to the shell once things have settled (a site registers a dozen in a row), and only when they changed. */
let sent = ''
let timer: ReturnType<typeof setTimeout> | null = null
let latest: string[] = []
function report(names: string[]): void {
  latest = names
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    const signature = [...latest].sort().join(',')
    if (signature === sent) return
    sent = signature
    ipcRenderer.send(MEDIA_BRIDGE.actions, latest)
  }, 100)
}

let api: MainWorldMedia | null = null
// A document without context isolation (an offscreen document of an extension) is not a tab, so no player drives it, and `contextBridge` would only refuse (main-world.ts).
if (canReachMainWorld()) {
  try {
    api = contextBridge.executeInMainWorld({ func: mainWorldMedia, args: [report] }) as MainWorldMedia | null
  } catch (error) {
    // A document without a main world to patch (a sandboxed frame, a page being replaced): it has no handlers and no volume, and the player says so.
    console.warn('[lucium] the media bridge could not be installed in this frame:', error instanceof Error ? error.message : String(error))
  }
}

if (api) {
  const world = api
  ipcRenderer.on(MEDIA_BRIDGE.command, (_event, command: unknown) => {
    const c = command as { kind?: unknown; value?: unknown; name?: unknown } | null
    try {
      if (c?.kind === 'volume') {
        const volume = parseVolume(c.value)
        if (volume !== null) world.setFactor(volume)
      } else if (c?.kind === 'action' && (SESSION_ACTIONS as readonly unknown[]).includes(c.name)) {
        world.run(c.name as string)
      }
    } catch (error) {
      // The page's own handler failed: that is the page's, and the player cannot do more about it.
      console.warn('[lucium] a media action of the page failed:', error instanceof Error ? error.message : String(error))
    }
  })
  // The site's own Picture in Picture button (Twitch, YouTube…) opens the system's window, whose design is not ours: the shell is told, and takes the
  // video into Lucium's floating window instead. Only a real event counts (isTrusted): a page cannot forge one to have its tab pulled out.
  document.addEventListener(
    'enterpictureinpicture',
    (event) => {
      if (event.isTrusted) ipcRenderer.send(MEDIA_BRIDGE.pip)
    },
    true
  )
  // A page that has just loaded starts at the level its tab has (a new document of a tab the user turned down stays down).
  ipcRenderer
    .invoke(MEDIA_BRIDGE.hello)
    .then((volume: unknown) => {
      const level = parseVolume(volume)
      if (level !== null && level !== 1) world.setFactor(level)
    })
    .catch((error: unknown) => console.warn('[lucium] the level of this tab could not be read:', error instanceof Error ? error.message : String(error)))
}
