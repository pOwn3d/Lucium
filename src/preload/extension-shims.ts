// Runs inside extension service workers and extension pages (registered by the engine, twice).
// Electron lacks some extension APIs that real extensions need to even start (chrome.tabGroups, chrome.debugger) or to work at
// all (chrome.sidePanel, chrome.identity), and the extension library (electron-chrome-extensions) implements some badly (native
// messaging, downloads, getContexts). This script defines or replaces them in the page's main world and forwards every call to the
// main process, which owns the real behavior.
//
// First pass, before the library's own preload: defines what is missing (the library leaves existing members alone and spreads them
// into its own objects). Second pass, after it (the library freezes `chrome` at the end of its preload, which is how the passes are
// told apart): replaces what the library got wrong. An API exists only for an extension that declared its permission, as the extension platform documents.

import { contextBridge, ipcRenderer } from 'electron'
import { NAMESPACE_PERMISSION } from '@shared/extension-access'
import { Channel } from '@shared/ipc-channels'
import { DATA_API_EVENTS, DATA_API_METHODS } from '@shared/extension-data-api'
import { LENT_PAYLOAD_MAX, NO_RECEIVER, PORT_CLOSED, TOO_LONG } from '@shared/lent-tab-runtime'
import { answerLentTabs } from './lent-tab-agent'
import { fixSenderTabs } from './sender-tab'

const CALL_CHANNEL = 'lucium-shim'
const EVENT_CHANNEL = 'lucium-shim-event'

/**
 * What a context of an extension may ask about the sound of a tab (`chrome.tabCapture`, and the sound a page listens to): its own channels, not the generic one.
 * The main process reads who asks from the frame or the worker that sent the call (never from an argument) and decides everything; this only carries the calls.
 */
const tabCaptureBridge = () => ({
  id: (options: unknown): Promise<string> => ipcRenderer.invoke(Channel.extTabCaptureId, options),
  listen: (id: string): Promise<{ sampleRate: number; channels: number }> => ipcRenderer.invoke(Channel.extTabCaptureListen, id),
  end: (id: string): Promise<void> => ipcRenderer.invoke(Channel.extTabCaptureEnd, id),
  list: (): Promise<unknown[]> => ipcRenderer.invoke(Channel.extTabCaptureList),
  // The main process asks the page to end the stream it holds (the person stopped the capture, the extension was switched off).
  onStop: (listener: (id: string) => void): void => {
    ipcRenderer.on(Channel.extTabCaptureStop, (_event, id: unknown) => {
      if (typeof id === 'string') listener(id)
    })
  },
  // A chunk of the sound of the capture this page holds (shared/tab-capture-pcm.ts): the main process sends it to the frame that holds the claim and to no other.
  onPcm: (listener: (id: string, chunk: ArrayBuffer) => void): void => {
    ipcRenderer.on(Channel.extTabCapturePcm, (_event, id: unknown, chunk: unknown) => {
      if (typeof id === 'string') listener(id, chunk as ArrayBuffer)
    })
  }
})

/**
 * Self-contained on purpose: Electron serializes this function and runs it in the main world. `namespacePermission` is the one thing
 * it is handed: the top-level namespaces the extension library defines for everyone, and the permission each needs on the extension platform.
 */
function mainWorldShims(namespacePermission: Readonly<Record<string, string>>, dataMethods: Readonly<Record<string, readonly string[]>>, dataEvents: Readonly<Record<string, readonly string[]>>, only?: 'copy' | 'tab-audio' | 'tab-audio-offscreen'): void {
  const g = globalThis as unknown as Record<string, any>
  const bridge = g.__luciumShim
  const chrome = g.chrome
  if (!bridge || !chrome || !chrome.runtime || !chrome.runtime.id) return
  const extensionId: string = chrome.runtime.id
  const secondPass = Object.isFrozen(chrome)
  // `browser` is the same API under the name WebExtensions use. The engine makes an object of it of its own, before the extension library adds its APIs
  // to `chrome`, so it lacks them (uBlock Origin Lite reads `browser.commands`, throws, and its worker never starts). Where the engine has such an object,
  // the name answers with `chrome` itself once the library is done. Where it has none, nothing is defined: extensions that look for `browser` to tell
  // a Firefox then still wrap `chrome` themselves.
  if (secondPass && g.browser && g.browser !== chrome) {
    try {
      Object.defineProperty(g, 'browser', { configurable: true, enumerable: true, get: () => chrome })
    } catch (error) {
      console.warn('[lucium] the name `browser` of an extension could not be made to answer with `chrome`:', error)
    }
  }
  // A document made without context isolation (offscreen) has no `getManifest`: its manifest is read by address (see installWithoutIsolation).
  const manifest = (typeof chrome.runtime.getManifest === 'function' ? chrome.runtime.getManifest() : g.__luciumManifest) || {}
  // The permissions the manifest lists as facultative count here from the start. The person may grant one later (`chrome.permissions.request`), and a
  // context cannot be given a namespace once the library has frozen `chrome`: its API is defined now. This decides nothing: until the permission is
  // granted, the main process refuses each call and sends none of the events, judged every time on what the extension holds then.
  const named = (list: unknown): string[] => (Array.isArray(list) ? list.filter((entry) => typeof entry === 'string') : [])
  const permissions = new Set<string>([...named(manifest.permissions), ...named(manifest.optional_permissions)])

  // The IPC layer prefixes the text of an error ("Error invoking remote method…"): an extension sees the message the documented API gives.
  const invoke = (api: string, method: string, args: unknown[]): Promise<any> =>
    bridge.call(extensionId, api, method, args).catch((error: any) => {
      throw new Error(String((error && error.message) || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    })

  const failWith = (error: any, callback: (value?: unknown) => void) => {
    chrome.runtime.lastError = { message: String((error && error.message) || error) }
    try {
      callback()
    } finally {
      delete chrome.runtime.lastError
    }
  }

  // `document.execCommand('copy')` and ('cut') in a page of the extension: MerciApp copies the new text from an offscreen document, then pastes it into the page. The extension platform allows
  // both to an extension that holds "clipboardWrite"; Electron answers false and sends no event. Where the browser's own command refuses, the copy is done here the way the
  // browser does it: the `copy` event goes to the focused element, what its handlers put in the event's data is what is copied (else the selection), and the main process
  // puts that on the clipboard. (The paste has no counterpart here: a page cannot be handed the clipboard before the command returns, and the platform's `paste` answers at once.)
  const installCopyCommand = (): void => {
    if (typeof document === 'undefined' || !permissions.has('clipboardWrite') || g.__luciumCopyInstalled) return
    g.__luciumCopyInstalled = true
    const nativeExec = Document.prototype.execCommand
    const nativeEnabled = Document.prototype.queryCommandEnabled
    const nativeSupported = Document.prototype.queryCommandSupported
    const copies = (command: unknown): boolean => typeof command === 'string' && (command.toLowerCase() === 'copy' || command.toLowerCase() === 'cut')
    const focused = (): Element => (document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body)
    const selectedText = (): string => {
      const field = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null
      if (field && (field.tagName === 'TEXTAREA' || field.tagName === 'INPUT') && typeof field.selectionStart === 'number') return field.value.slice(field.selectionStart, field.selectionEnd ?? field.selectionStart)
      return String(getSelection() ?? '')
    }
    const selectedHtml = (): string => {
      const selection = getSelection()
      if (!selection || selection.rangeCount === 0) return ''
      const holder = document.createElement('div')
      for (let i = 0; i < selection.rangeCount; i++) holder.appendChild(selection.getRangeAt(i).cloneContents())
      return holder.innerHTML
    }
    const copyIt = (command: string): boolean => {
      const data = new DataTransfer()
      const event = new ClipboardEvent(command.toLowerCase(), { clipboardData: data, bubbles: true, cancelable: true, composed: true })
      focused().dispatchEvent(event)
      // A handler that cancelled the event says what is copied; otherwise it is the selection.
      const text = event.defaultPrevented ? data.getData('text/plain') : selectedText()
      const html = event.defaultPrevented ? data.getData('text/html') : selectedHtml()
      if (text === '' && html === '') return event.defaultPrevented
      invoke('clipboard', 'write', [{ text, html }]).catch((error: any) => console.warn('[lucium] the copy of an extension page failed:', error && error.message))
      if (command.toLowerCase() === 'cut' && !event.defaultPrevented) nativeExec.call(document, 'delete')
      return true
    }
    const define = (name: string, value: unknown) => Object.defineProperty(Document.prototype, name, { value, writable: true, configurable: true, enumerable: true })
    define('execCommand', function execCommand(this: Document, command: string) {
      // The browser's own command first: where it is allowed (a click of the user), it is the one that runs.
      if ((nativeExec as any).apply(this, arguments)) return true
      return copies(command) ? copyIt(command) : false
    })
    define('queryCommandEnabled', function queryCommandEnabled(this: Document, command: string) {
      return copies(command) ? true : (nativeEnabled as any).apply(this, arguments)
    })
    define('queryCommandSupported', function queryCommandSupported(this: Document, command: string) {
      return copies(command) ? true : (nativeSupported as any).apply(this, arguments)
    })
  }

  // The sound of a tab, in a page of the extension (a popup, an options page, an offscreen document): `getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab',
  // chromeMediaSourceId } } })`, with an identifier `chrome.tabCapture.getMediaStreamId` gave. Chromium's own way to read it is not here, and the page never asks the browser for
  // a stream itself. It asks the main process to listen (`listen`, with the identifier); a helper page of Lucium's holds the sound of the tab and sends its samples, which the main
  // process hands to this page, and to no other, in chunks (shared/tab-capture-pcm.ts). The page plays them into a `MediaStreamTrackGenerator`: what it gives is a stream with one
  // audio track, and no picture. (No link is made between the pages: WebRTC does not work in an offscreen document.)
  // Any other call of `getUserMedia` goes through as it was, but in an offscreen document: Electron 45 stops on a request for media made from there (a crash, or a hang), so
  // every request that is not the sound of a tab is refused with a message (`offscreen`), the screen's included.
  const installTabAudio = (offscreen: boolean): void => {
    const capture = bridge.tabCapture
    const devices = typeof navigator !== 'undefined' ? (navigator as any).mediaDevices : undefined
    if (!capture || !devices || typeof devices.getUserMedia !== 'function' || g.__luciumTabAudio) return
    g.__luciumTabAudio = true
    const owner = Object.getPrototypeOf(devices)
    const nativeUserMedia = owner.getUserMedia
    const OURS = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/
    const HEADER = 16
    // What is kept of the sound before it plays: the jitter of the messages is smoothed by this much, no more.
    const JITTER_MS = 40
    const mandatoryOf = (value: any): any => (value && typeof value === 'object' && value.mandatory && typeof value.mandatory === 'object' ? value.mandatory : null)
    const soundOnly = 'Lucium: only the sound of a tab can be captured, not its picture.'
    const stopped = 'Lucium: the capture of the sound of this tab was stopped.'
    const unavailable = (): DOMException => new DOMException('Lucium: media capture is not available in an offscreen document (Electron 45 stops on it): use a popup or an options page', 'NotSupportedError')
    // The IPC layer prefixes the text of an error ("Error invoking remote method…"): the page reads the reason the main process gave.
    const reasonOf = (error: any): Error => new Error(String((error && error.message) || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    /** What each capture holds: the track the page gets (and its clones), the writer that plays the samples, and the first of them while they wait for the jitter buffer. */
    const live = new Map<string, { tracks: Set<any>; writer: any; track: any; queue: any[]; queuedMs: number; micros: number; over: boolean }>()
    const tellEnd = (id: string): void => {
      capture.end(id).catch((error: any) => console.warn('[lucium] the end of a capture of the sound of a tab could not be told to the browser:', error && error.message))
    }
    // The stream is over (every track made from it ended): what was kept for the buffer is let go, and the main process is told (it closes the helper page).
    const finish = (id: string): void => {
      const held = live.get(id)
      if (!held) return
      live.delete(id)
      for (const audio of held.queue) audio.close()
      held.queue = []
      tellEnd(id)
    }
    capture.onStop((id: string) => {
      const held = live.get(id)
      if (!held) return
      // A capture that has not given its stream yet has no track to stop: it is over, and what waits for it is told.
      held.over = true
      for (const track of [...held.tracks]) track.stop()
    })
    const play = (held: { writer: any }, audio: any): void => {
      held.writer.write(audio).then(
        () => audio.close(),
        (error: any) => {
          audio.close()
          console.warn('[lucium] a chunk of the sound of a tab could not be played:', error && error.message)
        }
      )
    }
    // A chunk of the sound, as the main process judged it: a header of four 32-bit integers (sequence, rate, channels, frames), then the samples, planar. The page reads it again.
    capture.onPcm((id: string, chunk: any) => {
      const held = live.get(id)
      if (!held || held.over || Object.prototype.toString.call(chunk) !== '[object ArrayBuffer]' || chunk.byteLength < HEADER) return
      const view = new DataView(chunk)
      const rate = view.getUint32(4, true)
      const channels = view.getUint32(8, true)
      const frames = view.getUint32(12, true)
      if (rate < 8000 || rate > 96000 || channels < 1 || channels > 2 || frames < 1 || chunk.byteLength !== HEADER + channels * frames * 4) return
      const audio = new g.AudioData({ format: 'f32-planar', sampleRate: rate, numberOfFrames: frames, numberOfChannels: channels, timestamp: Math.round(held.micros), data: new Float32Array(chunk, HEADER, channels * frames) })
      held.micros += (frames / rate) * 1e6
      // Kept until 40 ms of sound are there, then played as it comes (what is kept is counted for good: the buffer is not filled again).
      held.queue.push(audio)
      held.queuedMs += (frames / rate) * 1000
      if (held.queuedMs < JITTER_MS) return
      for (const waiting of held.queue.splice(0)) play(held, waiting)
    })
    // The stream is over when every track made from it is: stopped by the page (`stop` fires no `ended`), ended by the browser, clones included.
    const watch = (id: string, track: any): void => {
      const held = live.get(id)
      if (!held) return
      held.tracks.add(track)
      const left = (): void => {
        const current = live.get(id)
        if (!current || !current.tracks.delete(track)) return
        if (current.tracks.size === 0) finish(id)
      }
      track.addEventListener('ended', left)
      const stop = track.stop
      track.stop = function () {
        stop.call(track)
        left()
      }
      const clone = track.clone
      track.clone = function () {
        const copy = clone.call(track)
        watch(id, copy)
        return copy
      }
    }
    const take = async (id: string): Promise<any> => {
      if (typeof g.MediaStreamTrackGenerator !== 'function' || typeof g.AudioData !== 'function') throw new DOMException('Lucium: this page cannot play the samples of the sound of a tab (MediaStreamTrackGenerator, AudioData).', 'NotSupportedError')
      const track = new g.MediaStreamTrackGenerator({ kind: 'audio' })
      // Known before the main process is asked: its first chunks may come before its answer.
      const held = { tracks: new Set<any>(), writer: track.writable.getWriter(), track, queue: [] as any[], queuedMs: 0, micros: 0, over: false }
      live.set(id, held)
      try {
        // The main process refuses, or answers with the format of the sound once the first chunk came: it ended the claim itself when it refuses.
        await capture.listen(id).catch((error: any) => {
          throw reasonOf(error)
        })
        if (held.over) throw new Error(stopped)
        watch(id, track)
        return new MediaStream([track])
      } catch (error) {
        live.delete(id)
        for (const audio of held.queue) audio.close()
        track.stop()
        throw error
      }
    }
    Object.defineProperty(owner, 'getUserMedia', {
      value: function getUserMedia(this: unknown, constraints?: any): Promise<any> {
        const audio = mandatoryOf(constraints && constraints.audio)
        const video = mandatoryOf(constraints && constraints.video)
        const audioId = audio && audio.chromeMediaSource === 'tab' && typeof audio.chromeMediaSourceId === 'string' && OURS.test(audio.chromeMediaSourceId) ? audio.chromeMediaSourceId : null
        const videoIsTab = !!video && video.chromeMediaSource === 'tab' && typeof video.chromeMediaSourceId === 'string' && OURS.test(video.chromeMediaSourceId)
        if (audioId === null && !videoIsTab) return offscreen ? Promise.reject(unavailable()) : nativeUserMedia.apply(this, arguments)
        // The picture of a tab is never given, with or without the sound.
        if (videoIsTab || (constraints && constraints.video)) return Promise.reject(new Error(soundOnly))
        return take(audioId as string)
      },
      writable: true,
      configurable: true,
      enumerable: true
    })
    if (!offscreen) return
    // The other requests for media that reach the browser from such a document, the screen's and the old names: refused as `getUserMedia` is.
    if (typeof owner.getDisplayMedia === 'function') Object.defineProperty(owner, 'getDisplayMedia', { value: () => Promise.reject(unavailable()), writable: true, configurable: true, enumerable: true })
    const navigatorProto = Object.getPrototypeOf(navigator)
    for (const name of ['getUserMedia', 'webkitGetUserMedia']) {
      if (typeof navigatorProto[name] !== 'function') continue
      Object.defineProperty(navigatorProto, name, {
        value: function (_constraints: unknown, _success: unknown, failure: unknown): void {
          if (typeof failure !== 'function') throw unavailable()
          const error = unavailable()
          queueMicrotask(() => failure(error))
        },
        writable: true,
        configurable: true,
        enumerable: true
      })
    }
  }

  // A document of an extension made without context isolation (an offscreen one) is given the stream of the sound of a tab at once, before its first script: its manifest
  // is only read after, and a page that asks as it starts would otherwise meet the browser's own call. An offscreen document is also refused every other request for media.
  if (only === 'tab-audio' || only === 'tab-audio-offscreen') {
    installTabAudio(only === 'tab-audio-offscreen')
    return
  }

  // The copy command alone, for the rest of what such a document is given.
  if (only === 'copy') {
    installCopyCommand()
    return
  }

  // Extension APIs return promises or take a trailing callback and report failures through chrome.runtime.lastError.
  const method =
    (api: string, name: string) =>
    (...args: unknown[]): Promise<unknown> | undefined => {
      const callback = typeof args[args.length - 1] === 'function' ? (args.pop() as (value?: unknown) => void) : null
      const result = invoke(api, name, args)
      if (!callback) return result
      result.then(
        (value) => callback(value),
        (error) => failWith(error, callback)
      )
      return undefined
    }

  // A function of ours with the two ways of calling an extension API: it answers with a promise, or hands the result to a trailing callback.
  const promised =
    (run: (...args: any[]) => Promise<unknown>) =>
    (...args: unknown[]): Promise<unknown> | undefined => {
      const callback = typeof args[args.length - 1] === 'function' ? (args.pop() as (value?: unknown) => void) : null
      const result = run(...args)
      if (!callback) return result
      result.then(
        (value) => callback(value),
        (error) => failWith(error, callback)
      )
      return undefined
    }

  const listeners: Record<string, Set<(...a: unknown[]) => void>> = {}
  /** Events that arrive before the first listener (a worker is told right after it starts, while its script is still running) wait for it. */
  const waiting: Record<string, Array<{ args: unknown[]; at: number }>> = {}
  const buffered = new Set<string>()
  const WAIT_MS = 15000
  const emit = (key: string, args: unknown[]) => {
    const set = listeners[key]
    if (buffered.has(key) && (!set || set.size === 0)) {
      const queue = (waiting[key] = waiting[key] || [])
      queue.push({ args, at: Date.now() })
      if (queue.length > 50) queue.shift()
      return
    }
    for (const fn of [...(set || [])]) {
      try {
        fn(...args)
      } catch (error) {
        console.error(error)
      }
    }
  }
  /** `options.buffer`: keep events for a listener that is not there yet. `options.onListening`: called when the first listener comes. */
  const event = (api: string, name: string, options: { buffer?: boolean; onListening?: () => void } = {}) => {
    const key = `${api}.${name}`
    const set = (listeners[key] = listeners[key] || new Set())
    if (options.buffer) buffered.add(key)
    return {
      addListener: (fn: (...a: unknown[]) => void) => {
        const first = set.size === 0
        set.add(fn)
        if (first && options.onListening) options.onListening()
        const queue = waiting[key]
        if (queue && queue.length > 0) {
          delete waiting[key]
          setTimeout(() => {
            for (const { args, at } of queue) if (Date.now() - at < WAIT_MS) emit(key, args)
          }, 0)
        }
      },
      removeListener: (fn: (...a: unknown[]) => void) => void set.delete(fn),
      hasListener: (fn: (...a: unknown[]) => void) => set.has(fn),
      hasListeners: () => set.size > 0
    }
  }
  bridge.onEvent((api: string, name: string, args: unknown[]) => emit(`${api}.${name}`, args))

  const define = (name: string, value: unknown) => {
    if (chrome[name] === undefined) Object.defineProperty(chrome, name, { value, configurable: true, enumerable: true, writable: true })
  }

  if (secondPass) {
    // The first pass held `Object.defineProperty` back for the namespaces below while the library's script ran: that script is over.
    const original = (Object.defineProperty as unknown as { __luciumOriginal?: typeof Object.defineProperty }).__luciumOriginal
    if (original) Object.defineProperty = original
  }

  if (!secondPass) {
    installTabAudio(false)
    // The extension platform defines `chrome.cookies`, `chrome.webNavigation`... only for an extension that declared the permission; the library defines
    // them for everyone. Its script (it runs right after this one) defines each with `Object.defineProperty(chrome, name, ...)`, and
    // `chrome` is frozen once it is done, so the only moment to keep a namespace from existing is now: that call is ignored for them.
    // (The calls themselves are refused in the main process whatever happens here: src/main/engine/ece-router.ts.)
    const hidden = new Set(Object.keys(namespacePermission).filter((name) => !permissions.has(namespacePermission[name] as string)))
    if (hidden.size > 0) {
      // A pass that finds `chrome` still open is not always the first (the library's script can stop before it freezes `chrome`): the function held
      // back is then ours already, and wrapping it again would leave one of ours in place for good once the other is taken away.
      const held = (Object.defineProperty as unknown as { __luciumOriginal?: typeof Object.defineProperty }).__luciumOriginal
      const original = held ?? Object.defineProperty
      const holdBack = function (target: object, key: PropertyKey, descriptor: PropertyDescriptor): object {
        // The library is done (it froze `chrome`) and no later pass came to give the function back: the first call after that does it.
        if (Object.isFrozen(chrome)) {
          if (Object.defineProperty === holdBack) Object.defineProperty = original
          return original(target, key, descriptor)
        }
        if (target === chrome && typeof key === 'string' && hidden.has(key)) return target
        return original(target, key, descriptor)
      }
      Object.defineProperty(holdBack, '__luciumOriginal', { value: original })
      Object.defineProperty = holdBack as typeof Object.defineProperty
    }

    if (permissions.has('sidePanel')) {
      define('sidePanel', {
        open: method('sidePanel', 'open'),
        setOptions: method('sidePanel', 'setOptions'),
        getOptions: method('sidePanel', 'getOptions'),
        setPanelBehavior: method('sidePanel', 'setPanelBehavior'),
        getPanelBehavior: method('sidePanel', 'getPanelBehavior'),
        onOpened: event('sidePanel', 'onOpened'),
        onClosed: event('sidePanel', 'onClosed')
      })
    }

    if (permissions.has('tabGroups')) {
      define('tabGroups', {
        TAB_GROUP_ID_NONE: -1,
        Color: { GREY: 'grey', BLUE: 'blue', RED: 'red', YELLOW: 'yellow', GREEN: 'green', PINK: 'pink', PURPLE: 'purple', CYAN: 'cyan', ORANGE: 'orange' },
        query: method('tabGroups', 'query'),
        get: method('tabGroups', 'get'),
        update: method('tabGroups', 'update'),
        move: method('tabGroups', 'move'),
        onCreated: event('tabGroups', 'onCreated'),
        onUpdated: event('tabGroups', 'onUpdated'),
        onMoved: event('tabGroups', 'onMoved'),
        onRemoved: event('tabGroups', 'onRemoved')
      })
    }

    // chrome.omnibox exists for an extension that declared a keyword. The command bar reaches it with `onInputStarted` then `onInputEntered`
    // (src/shared/omnibox.ts) and nothing else: suggestions are never asked for, so `onInputChanged` and the rest are there to be listened to and stay silent.
    const omnibox = manifest.omnibox
    if (omnibox && typeof omnibox.keyword === 'string' && omnibox.keyword.trim() !== '') {
      define('omnibox', {
        DescriptionStyleType: { URL: 'url', MATCH: 'match', DIM: 'dim' },
        OnInputEnteredDisposition: { CURRENT_TAB: 'currentTab', NEW_FOREGROUND_TAB: 'newForegroundTab', NEW_BACKGROUND_TAB: 'newBackgroundTab' },
        // Accepted, and shown nowhere: there is no list of suggestions for it to head.
        setDefaultSuggestion: (_suggestion: unknown, callback?: () => void) => {
          if (typeof callback === 'function') {
            callback()
            return undefined
          }
          return Promise.resolve()
        },
        onInputStarted: event('omnibox', 'onInputStarted', { buffer: true }),
        onInputChanged: event('omnibox', 'onInputChanged'),
        onInputEntered: event('omnibox', 'onInputEntered', { buffer: true }),
        onInputCancelled: event('omnibox', 'onInputCancelled'),
        onDeleteSuggestion: event('omnibox', 'onDeleteSuggestion')
      })
    }

    if (permissions.has('debugger')) {
      define('debugger', {
        attach: method('debugger', 'attach'),
        detach: method('debugger', 'detach'),
        sendCommand: method('debugger', 'sendCommand'),
        getTargets: method('debugger', 'getTargets'),
        onEvent: event('debugger', 'onEvent'),
        onDetach: event('debugger', 'onDetach')
      })
    }

    // chrome.tabCapture: the sound of a tab, and nothing else. `getMediaStreamId` gives the identifier a page of the extension then uses (getUserMedia with
    // `chromeMediaSource: 'tab'`); every condition is the main process's to judge. `capture`, the picture of a tab and the screen are not provided.
    // `onStatusChanged` is there to be listened to and says nothing: the page that holds the stream is the one that knows what became of it.
    if (permissions.has('tabCapture') && bridge.tabCapture) {
      const asked = (call: () => Promise<unknown>): Promise<unknown> =>
        call().catch((error: any) => {
          throw new Error(String((error && error.message) || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
        })
      define('tabCapture', {
        getMediaStreamId: promised((options?: unknown) => asked(() => bridge.tabCapture.id(options))),
        getCapturedTabs: promised(() => asked(() => bridge.tabCapture.list())),
        onStatusChanged: event('tabCapture', 'onStatusChanged')
      })
    }

    if (permissions.has('identity')) {
      define('identity', {
        // The address an authorization server sends the browser back to; nothing is loaded from it.
        getRedirectURL: (path?: string) => `https://${extensionId}.chromiumapp.org/${String(path || '').replace(/^\//, '')}`,
        launchWebAuthFlow: method('identity', 'launchWebAuthFlow')
      })
    }

    // chrome.sessions: the tabs the person closed and their reopening (the main process answers, and refuses a call whose permission is missing). `onChanged` exists and stays
    // silent: nothing tells an extension that the list changed, it asks again.
    if (permissions.has('sessions')) {
      define('sessions', {
        MAX_SESSION_RESULTS: 25,
        getRecentlyClosed: method('sessions', 'getRecentlyClosed'),
        restore: method('sessions', 'restore'),
        getDevices: method('sessions', 'getDevices'),
        onChanged: event('sessions', 'onChanged')
      })
    }

    // chrome.history, chrome.bookmarks, chrome.browsingData: the main process answers (and refuses a call whose permission is missing).
    for (const api of Object.keys(dataMethods)) {
      if (!permissions.has(api)) continue
      define(api, {
        ...Object.fromEntries((dataMethods[api] as readonly string[]).map((name) => [name, method(api, name)])),
        ...Object.fromEntries((dataEvents[api] as readonly string[]).map((name) => [name, event(api, name)]))
      })
    }

    // Where the platform has no chrome.management at all; where it has one (second pass), `getAll` is added to it.
    if (permissions.has('management')) define('management', { getAll: method('management', 'getAll') })

    if (chrome.tabs) {
      if (permissions.has('tabGroups')) {
        if (chrome.tabs.group === undefined) chrome.tabs.group = method('tabs', 'group')
        if (chrome.tabs.ungroup === undefined) chrome.tabs.ungroup = method('tabs', 'ungroup')
      }
      if (chrome.tabs.discard === undefined) chrome.tabs.discard = method('tabs', 'discard')
      if (chrome.tabs.captureVisibleTab === undefined) chrome.tabs.captureVisibleTab = method('tabs', 'captureVisibleTab')

      // What the library leaves out of chrome.tabs, built on what it has. Extensions call these without testing for them, and stop at the first one that is not there.
      const tabs = chrome.tabs
      const only = (value: unknown): any => (Array.isArray(value) ? value[0] : value)
      // The tab on screen in a window (the current one without an id), which the old chrome.tabs.getSelected meant.
      if (tabs.getSelected === undefined) {
        tabs.getSelected = promised(async (windowId?: number) => {
          const list: any[] = await tabs.query(typeof windowId === 'number' ? { active: true, windowId } : { active: true, currentWindow: true })
          return list[0]
        })
      }
      // A copy of the tab right after it, in front: that is where the documented API puts it. Its address is needed, which only an extension allowed to read it has.
      if (tabs.duplicate === undefined) {
        tabs.duplicate = promised(async (tabId: number) => {
          const tab = await tabs.get(tabId)
          if (!tab || typeof tab.url !== 'string' || tab.url === '') throw new Error('Cannot duplicate this tab: its address is not available to this extension.')
          return tabs.create({ url: tab.url, windowId: tab.windowId, index: tab.index + 1, active: true })
        })
      }
      // The order of the tabs is the user's, in the sidebar: a move is accepted and changes nothing, and the tab comes back as it is.
      if (tabs.move === undefined) {
        tabs.move = promised(async (tabIds: number | number[]) => {
          console.warn('[lucium] chrome.tabs.move does not reorder tabs here: the sidebar keeps the order the user gave them.')
          return Array.isArray(tabIds) ? Promise.all(tabIds.map((id) => tabs.get(id))) : tabs.get(tabIds)
        })
      }
      // The documented API highlights several tabs and shows the first; here the first is shown. `tabs` are positions in the window.
      if (tabs.highlight === undefined) {
        tabs.highlight = promised(async (info: { tabs?: number | number[]; windowId?: number }) => {
          const wanted = only(info && info.tabs)
          const list: any[] = await tabs.query(typeof (info && info.windowId) === 'number' ? { windowId: info.windowId } : { currentWindow: true })
          const target = list.find((tab) => tab.index === wanted)
          if (!target) throw new Error(`No tab at index: ${String(wanted)}.`)
          await tabs.update(target.id, { active: true })
          return chrome.windows.get(target.windowId, { populate: true })
        })
      }
      // The language the page declares (<html lang>), or "und", as the documented API says, when it does not say or the extension may not look.
      if (tabs.detectLanguage === undefined) {
        tabs.detectLanguage = promised(async (tabId?: number) => {
          try {
            const id = typeof tabId === 'number' ? tabId : only(await tabs.query({ active: true, currentWindow: true }))?.id
            const [first] = await chrome.scripting.executeScript({ target: { tabId: id }, func: () => document.documentElement.lang })
            const lang = first && typeof first.result === 'string' ? first.result.trim().toLowerCase() : ''
            return lang === '' ? 'und' : lang
          } catch {
            return 'und'
          }
        })
      }
    }
    return
  }

  // ---- second pass ----

  // Events of the extension platform that neither Electron nor the library defines and that a worker commonly registers as it starts (a notification that asks for its settings, another
  // extension installed): the missing event is `undefined.addListener`, a TypeError that stops the whole worker. They exist and stay silent; Lucium has nothing to tell yet.
  const SILENT_EVENTS: Record<string, string[]> = {
    notifications: ['onPermissionLevelChanged', 'onShowSettings'],
    management: ['onInstalled', 'onUninstalled', 'onEnabled', 'onDisabled']
  }
  for (const api of Object.keys(SILENT_EVENTS)) {
    const owner = chrome[api]
    if (!owner) continue
    for (const name of SILENT_EVENTS[api] as string[]) {
      if (owner[name] !== undefined) continue
      try {
        Object.defineProperty(owner, name, { value: event(api, name), enumerable: true, configurable: true })
      } catch (error) {
        console.warn(`[lucium] chrome.${api}.${name} could not be defined, so a listener of it will fail:`, error instanceof Error ? error.message : String(error))
      }
    }
  }

  // chrome.management.getAll, which the platform's partial chrome.management lacks: the main process answers, for an extension that holds "management".
  if (permissions.has('management') && chrome.management && chrome.management.getAll === undefined) {
    try {
      Object.defineProperty(chrome.management, 'getAll', { value: method('management', 'getAll'), enumerable: true, configurable: true, writable: true })
    } catch (error) {
      console.warn('[lucium] chrome.management.getAll could not be defined, so a call to it will fail:', error instanceof Error ? error.message : String(error))
    }
  }

  // chrome.runtime.connectNative / sendNativeMessage, in place of the library's (see src/main/engine/ece-router.ts).
  if (permissions.has('nativeMessaging')) {
    const ports: Record<string, { deliver(type: string, payload: any): void }> = {}
    bridge.onEvent((api: string, name: string, args: any[]) => {
      if (api !== 'nativeMessaging' || name !== 'port') return
      const port = ports[args[0]]
      if (port) port.deliver(args[1], args[2])
    })

    const portEvent = () => {
      const set = new Set<(...a: unknown[]) => void>()
      return {
        set,
        api: {
          addListener: (fn: (...a: unknown[]) => void) => void set.add(fn),
          removeListener: (fn: (...a: unknown[]) => void) => void set.delete(fn),
          hasListener: (fn: (...a: unknown[]) => void) => set.has(fn),
          hasListeners: () => set.size > 0
        }
      }
    }

    chrome.runtime.connectNative = (hostName: string) => {
      if (typeof hostName !== 'string') throw new TypeError('Error in invocation of runtime.connectNative(string application): No matching signature.')
      const portId: string = crypto.randomUUID()
      const onMessage = portEvent()
      const onDisconnect = portEvent()
      let open = true
      const close = (error: string | null, fireDisconnect: boolean) => {
        if (!open) return
        open = false
        delete ports[portId]
        if (!fireDisconnect) return
        chrome.runtime.lastError = error ? { message: error } : undefined
        try {
          for (const fn of [...onDisconnect.set]) fn(port)
        } finally {
          delete chrome.runtime.lastError
        }
      }
      const port = {
        name: hostName,
        onMessage: onMessage.api,
        onDisconnect: onDisconnect.api,
        postMessage: (message: unknown) => {
          if (!open) throw new Error('Attempting to use a disconnected port object')
          try {
            JSON.stringify(message)
          } catch {
            throw new Error('Could not serialize the message.')
          }
          invoke('nativeMessaging', 'post', [portId, message]).catch((error) => close(String(error.message || error), true))
        },
        disconnect: () => {
          if (!open) return
          close(null, false)
          invoke('nativeMessaging', 'disconnect', [portId]).catch((error) => console.error(error))
        }
      }
      ports[portId] = {
        deliver: (type, payload) => {
          if (type === 'message') for (const fn of [...onMessage.set]) fn(payload, port)
          else close(payload, true)
        }
      }
      // The port exists at once; a host that cannot be started ends it with a disconnect, as the documented API does.
      invoke('nativeMessaging', 'connect', [hostName, portId]).catch((error) => close(String(error.message || error), true))
      return port
    }

    chrome.runtime.sendNativeMessage = (hostName: string, message: unknown, callback?: (response?: unknown) => void) => {
      const result = invoke('nativeMessaging', 'sendMessage', [hostName, message])
      if (typeof callback !== 'function') return result
      result.then(
        (response) => callback(response),
        (error) => failWith(error, callback)
      )
      return undefined
    }
  }

  // The events Electron does not deliver to a service worker: the main process hands them over (see src/main/engine/ece-router.ts's
  // neighbour, the event relay). Only in a worker: pages get the real events.
  const inWorker = typeof g.ServiceWorkerGlobalScope !== 'undefined' && g instanceof g.ServiceWorkerGlobalScope
  if (inWorker) {
    const replace = (target: any, member: string, value: unknown) => {
      try {
        Object.defineProperty(target, member, { value, configurable: true, enumerable: true, writable: true })
      } catch (error) {
        console.error(`[lucium] cannot replace ${member}:`, error)
      }
    }
    replace(chrome.runtime, 'onInstalled', event('runtime', 'onInstalled', { buffer: true }))
    replace(chrome.runtime, 'onStartup', event('runtime', 'onStartup', { buffer: true }))
    const relayed = (namespace: string, member: string) => {
      if (!chrome[namespace]) return
      const name = `${namespace}.${member}`
      replace(chrome[namespace], member, event(namespace, member, { buffer: true, onListening: () => void invoke('events', 'subscribe', [name]).catch((error) => console.error(`[lucium] cannot listen to ${name}:`, error)) }))
    }
    relayed('storage', 'onChanged')
    relayed('alarms', 'onAlarm')
    relayed('idle', 'onStateChanged')
  }

  // Without the permission the library's stand-ins must not be there either: the extension platform does not define these functions for such an extension.
  if (!permissions.has('nativeMessaging')) {
    delete chrome.runtime.connectNative
    delete chrome.runtime.sendNativeMessage
  }

  // chrome.storage.managed is where an administrator's policy for the extension is read. The library makes it an alias of the extension's
  // own writable storage, which would hand an extension its own data as if an administrator had set it (and let it overwrite "policy").
  // There is no policy here: it is empty and read-only, as in a browser that has none.
  if (chrome.storage) {
    const settle = (value: unknown, callback?: (value?: unknown) => void) => {
      if (typeof callback !== 'function') return Promise.resolve(value)
      callback(value)
      return undefined
    }
    const readOnly = (callback?: (value?: unknown) => void) => {
      const error = new Error('This is a read-only store.')
      if (typeof callback !== 'function') return Promise.reject(error)
      failWith(error, callback)
      return undefined
    }
    const managed = {
      get: (keys?: unknown, callback?: (value?: unknown) => void) => {
        const answer = typeof keys === 'function' ? {} : typeof keys === 'object' && keys !== null && !Array.isArray(keys) ? { ...keys } : {}
        return settle(answer, typeof keys === 'function' ? (keys as (value?: unknown) => void) : callback)
      },
      getBytesInUse: (keys?: unknown, callback?: (value?: unknown) => void) => settle(0, typeof keys === 'function' ? (keys as (value?: unknown) => void) : callback),
      set: (_items: unknown, callback?: (value?: unknown) => void) => readOnly(callback),
      remove: (_keys: unknown, callback?: (value?: unknown) => void) => readOnly(callback),
      clear: (callback?: (value?: unknown) => void) => readOnly(callback),
      onChanged: event('storage.managed', 'onChanged')
    }
    Object.defineProperty(chrome.storage, 'managed', { value: managed, configurable: true, enumerable: true, writable: true })
  }

  // A call of an API of the browser itself, as a promise. A Manifest V3 context gets one from the browser. A Manifest V2 context has callbacks only, and
  // the failure of such a call cannot be read from here (the extension library put its own object in the place of `chrome.runtime`, and the browser
  // writes `lastError` on the one it made): the call then resolves either way, and what follows reads the state the browser really holds.
  const nativeCall = (owner: unknown, fn: (...a: unknown[]) => unknown, args: unknown[]): Promise<any> =>
    new Promise((resolve, reject) => {
      if (Number(manifest.manifest_version) >= 3) Promise.resolve(fn.apply(owner, args)).then(resolve, reject)
      else fn.call(owner, ...args, resolve)
    })

  // chrome.declarativeNetRequest: Electron applies the rules of an extension only in a session the application does not watch, and Lucium watches
  // every session of pages (the guard of local files, the blocker). So the application applies them itself (src/shared/net-rules.ts). The dynamic
  // and session rules are still registered with the browser, which checks and keeps them; a copy goes to the main process after every change and
  // when the worker starts. The static rulesets, which Electron never enables, are answered for by the main process alone.
  const netRules = chrome.declarativeNetRequest
  if (netRules && (permissions.has('declarativeNetRequest') || permissions.has('declarativeNetRequestWithHostAccess'))) {
    const nativeRules: Record<string, (...a: unknown[]) => unknown> = { getSessionRules: netRules.getSessionRules, getDynamicRules: netRules.getDynamicRules, updateSessionRules: netRules.updateSessionRules, updateDynamicRules: netRules.updateDynamicRules }
    const natively = (name: string, ...args: unknown[]): Promise<any> => nativeCall(netRules, nativeRules[name] as (...a: unknown[]) => unknown, args)
    // One copy at a time, in the order of the changes: the last one sent is the last state.
    let copying: Promise<unknown> = Promise.resolve()
    const copyRules = (): Promise<unknown> => {
      copying = copying
        .then(() => Promise.all([natively('getSessionRules'), natively('getDynamicRules')]))
        .then(([session, dynamic]) => invoke('declarativeNetRequest', 'mirror', [{ session, dynamic }]))
        .catch((error: any) => console.warn('[lucium] the request rules of this extension could not be handed to the browser, so the last ones it knows stay applied:', error && error.message))
      return copying
    }
    for (const name of ['updateSessionRules', 'updateDynamicRules']) {
      netRules[name] = promised((options: unknown) => natively(name, options).then(() => copyRules()).then(() => undefined))
    }
    for (const name of ['getEnabledRulesets', 'updateEnabledRulesets', 'updateStaticRules', 'getDisabledRuleIds', 'getAvailableStaticRuleCount', 'getMatchedRules']) netRules[name] = method('declarativeNetRequest', name)
    // The dynamic rules outlive the browser: the worker hands them over when it starts (a page of the extension would only repeat it).
    if (typeof document === 'undefined') void copyRules()
  }

  // chrome.webRequest: for the same reason, the browser never calls the listeners of an extension here. The main process tells this context about the
  // requests its listeners cover (it watches them anyway), and the listeners are called here. A blocking listener of a Manifest V2 extension is
  // asked: the event then carries a token, and what the blocking listeners of this context answer goes back with it (main/engine/extension-net.ts
  // waits for it a bounded time, and applies it). In a Manifest V3 extension a blocking listener is told only, as it is not allowed to block.
  if (chrome.webRequest && permissions.has('webRequest')) {
    const covers = (pattern: unknown, address: string): boolean => {
      if (pattern === '<all_urls>') return true
      const parts = /^(\*|[a-z-]+):\/\/(\*|[^/]*)(\/.*)$/.exec(String(pattern))
      if (!parts) return false
      // An address that is none is covered by no pattern.
      if (!URL.canParse(address)) return false
      const url = new URL(address)
      const scheme = url.protocol.slice(0, -1)
      if (parts[1] === '*' ? !/^(https?|wss?)$/.test(scheme) : parts[1] !== scheme && !(parts[1] === 'http' && scheme === 'ws') && !(parts[1] === 'https' && scheme === 'wss')) return false
      const host = String(parts[2]).replace(/:\d+$/, '')
      if (host !== '*' && (host.startsWith('*.') ? url.hostname !== host.slice(2) && !url.hostname.endsWith(host.slice(1)) : url.hostname !== host)) return false
      const path = new RegExp(`^${String(parts[3]).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
      return path.test(url.pathname + url.search)
    }
    type Held = { fn: (details: any, callback?: (response?: unknown) => void) => unknown; filter: { urls: unknown[]; types?: unknown[]; tabId?: unknown }; extra: unknown[] }
    const heldBy: Record<string, Held[]> = {}
    // A worker started for a request is told about it before its script has put its listeners back: the first events wait for them a moment.
    const early: Array<{ name: string; details: any; at: number }> = []
    let fresh = true
    // Said once in this context, not once per listener.
    let warnedBlocking = false
    // Only a Manifest V2 extension may block, as on the extension platform; its answers are applied.
    const mayBlock = Number(manifest.manifest_version) === 2 && permissions.has('webRequestBlocking')
    const isBlocking = (held: Held): boolean => held.extra.includes('blocking') || held.extra.includes('asyncBlocking')
    // The events on which this context ever held a blocking listener: the main process may ask it about one, and it always answers (an empty
    // answer once the listener is gone), so that the request never waits for it in vain.
    const askedOn = new Set<string>()
    const tell = (name: string, details: any, ask?: string): void => {
      const answers: Array<Promise<unknown>> = []
      for (const held of [...(heldBy[name] || [])]) {
        if (typeof held.filter.tabId === 'number' && held.filter.tabId !== details.tabId) continue
        if (Array.isArray(held.filter.types) && !held.filter.types.includes(details.type)) continue
        if (!held.filter.urls.some((pattern) => covers(pattern, details.url))) continue
        const told = { ...details }
        if (!held.extra.includes('requestHeaders')) delete told.requestHeaders
        if (!held.extra.includes('responseHeaders')) delete told.responseHeaders
        if (!held.extra.includes('requestBody')) delete told.requestBody
        const isAsked = ask !== undefined && isBlocking(held)
        try {
          if (isAsked && held.extra.includes('asyncBlocking')) answers.push(new Promise((resolve) => held.fn(told, resolve)))
          else {
            const returned = held.fn(told)
            // A blocking listener answers by what it returns (a promise of it is waited for too).
            if (isAsked) answers.push(Promise.resolve(returned))
          }
        } catch (error) {
          console.error(error)
        }
      }
      if (ask === undefined || !askedOn.has(name)) return
      Promise.all(
        answers.map((answer) =>
          answer.catch((error: unknown) => {
            console.error(error)
            return undefined
          })
        )
      )
        .then((values) => {
          // Plain data only crosses to the main process: an answer that cannot be copied goes as a word the main process refuses (and says so).
          const plain = values.filter((value) => value !== undefined && value !== null).map((value) => {
            try {
              return JSON.parse(JSON.stringify(value))
            } catch (error) {
              console.error(error)
              return 'unreadable'
            }
          })
          return invoke('webRequest', 'answer', [ask, plain])
        })
        .catch((error: any) => console.warn(`[lucium] chrome.webRequest.${name}: the answer of this listener could not be handed to the browser, so the request went on without it:`, error && error.message))
    }
    bridge.onEvent((api: string, name: string, args: any[]) => {
      if (api !== 'webRequest') return
      const ask = args[1] && typeof args[1].ask === 'string' ? (args[1].ask as string) : undefined
      if ((heldBy[name] || []).length > 0 || (ask !== undefined && askedOn.has(name))) return tell(name, args[0], ask)
      early.push({ name, details: args[0], at: Date.now() })
      if (early.length > 50) early.shift()
    })
    for (const name of ['onBeforeRequest', 'onBeforeSendHeaders', 'onSendHeaders', 'onHeadersReceived', 'onAuthRequired', 'onBeforeRedirect', 'onResponseStarted', 'onCompleted', 'onErrorOccurred']) {
      const held: Held[] = (heldBy[name] = [])
      chrome.webRequest[name] = {
        addListener: (fn: Held['fn'], filter: Held['filter'], extra?: unknown[]) => {
          if (typeof fn !== 'function') throw new TypeError('The listener of a webRequest event must be a function.')
          if (!filter || !Array.isArray(filter.urls)) throw new TypeError("The filter of a webRequest listener needs 'urls'.")
          const asked = Array.isArray(extra) ? extra : []
          // As on the extension platform: only an extension that holds the permission may ask to block.
          if (asked.includes('blocking') && !permissions.has('webRequestBlocking')) throw new Error('You do not have permission to use blocking webRequest listeners. Be sure to declare the webRequestBlocking permission in your manifest.')
          const blocking = asked.includes('blocking') || asked.includes('asyncBlocking')
          if (blocking && mayBlock) askedOn.add(name)
          else if (blocking && !warnedBlocking) {
            // The listener is taken, so that the extension goes on, but it is only told: without this line its author would look for a bug of theirs.
            warnedBlocking = true
            console.warn(`[lucium] chrome.webRequest.${name}: this listener asks to block ('blocking' or 'asyncBlocking'), which only a Manifest V2 extension may do. Lucium tells it about the requests but does not apply what it answers: nothing is cancelled, redirected or rewritten by it. Use chrome.declarativeNetRequest to act on a request.`)
          }
          held.push({ fn, filter, extra: asked })
          invoke('webRequest', 'listen', [name, { urls: filter.urls, types: filter.types, tabId: filter.tabId }, asked, fresh]).catch((error: any) => console.warn(`[lucium] chrome.webRequest.${name}: the browser did not take the listener, so it will hear nothing:`, error && error.message))
          fresh = false
          setTimeout(() => {
            for (const waited of early.splice(0)) if (Date.now() - waited.at < WAIT_MS) tell(waited.name, waited.details)
          }, 0)
        },
        removeListener: (fn: unknown) => {
          const at = held.findIndex((entry) => entry.fn === fn)
          if (at >= 0) held.splice(at, 1)
        },
        hasListener: (fn: unknown) => held.some((entry) => entry.fn === fn),
        hasListeners: () => held.length > 0
      }
    }
  }

  // chrome.scripting for an extension with "activeTab" and no host permission: the browser refuses the script even after the click that lends the tab
  // (it is never told about the loan). When it refuses, the main process is asked: it runs the script itself in a tab the user did lend, and answers
  // with the same refusal for any other (src/shared/active-tab-script.ts).
  if (chrome.scripting && permissions.has('scripting') && permissions.has('activeTab')) {
    for (const name of ['executeScript', 'insertCSS', 'removeCSS']) {
      const native = chrome.scripting[name]
      if (typeof native !== 'function') continue
      chrome.scripting[name] = promised((injection: any) =>
        nativeCall(chrome.scripting, native, [injection]).catch((error: any) => {
          const said = String((error && error.message) || error)
          if (!/Cannot access contents of/i.test(said) || !injection || !injection.target || typeof injection.target.tabId !== 'number') throw error
          const func = injection.func || injection.function
          return invoke('scripting', name, [{ target: { tabId: injection.target.tabId }, world: injection.world, func: typeof func === 'function' ? String(func) : undefined, args: injection.args, files: injection.files, css: injection.css, origin: injection.origin }])
        })
      )
    }
  }

  // chrome.tabs.sendMessage to a tab where the extension has no content script of its own, only the script it injected there after a click: the browser finds no receiver ("Receiving end does
  // not exist"), because the script lives in a world the application made (src/shared/lent-tab-runtime.ts). When it says so, the main process is asked: it hands the message to that script, in
  // a tab the user lent to this extension and where such a script runs, and answers with the same refusal for any other. What the script answers is what comes back.
  if (chrome.tabs && permissions.has('scripting') && permissions.has('activeTab') && typeof chrome.tabs.sendMessage === 'function') {
    const nativeSend = chrome.tabs.sendMessage
    chrome.tabs.sendMessage = promised((tabId: unknown, message: unknown, options?: unknown) =>
      nativeCall(chrome.tabs, nativeSend, options === undefined ? [tabId, message] : [tabId, message, options]).catch((error: any) => {
        if (!/Receiving end does not exist/i.test(String((error && error.message) || error))) throw error
        return invoke('lentTab', 'toTab', [tabId, message, options, typeof location === 'undefined' ? undefined : String(location.href)])
      })
    )
  }

  // chrome.extension: the library answers "is it allowed in private windows / on file: pages" with nothing; the answer of a browser that has neither is false.
  if (chrome.extension) {
    for (const name of ['isAllowedIncognitoAccess', 'isAllowedFileSchemeAccess']) chrome.extension[name] = promised(async () => false)
  }

  // chrome.contextMenus.update: the library's does nothing, so a menu that follows the page keeps the entries it first made.
  if (permissions.has('contextMenus') && chrome.contextMenus) chrome.contextMenus.update = method('contextMenus', 'update')

  // chrome.permissions: the library's preload drops the error of every call it forwards, so a request the main process refuses (no click or key
  // before it, a permission the manifest does not list as optional) answered `undefined` instead of failing with the reason. The same answer is
  // asked here, by a path that hands the error on: the promise is rejected, or `chrome.runtime.lastError` is set for a callback.
  if (chrome.permissions) for (const name of ['request', 'contains', 'getAll', 'remove']) chrome.permissions[name] = method('permissions', name)

  // chrome.action.setIcon / chrome.browserAction.setIcon with an image: the library throws the image away (a Manifest V3 extension is told it is "not yet supported")
  // and the toolbar icon goes blank. The images are made into PNG data URLs here and handed over in `path`, which the library lets through; the main process puts them
  // back where the library reads them (src/main/engine/ece-router.ts, keepActionIcon).
  const toDataUrl = async (image: { width: number; height: number }): Promise<string> => {
    if (typeof OffscreenCanvas === 'function') {
      const canvas = new OffscreenCanvas(image.width, image.height)
      canvas.getContext('2d')!.putImageData(image as ImageData, 0, 0)
      const blob = await canvas.convertToBlob({ type: 'image/png' })
      return new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(blob)
      })
    }
    const canvas = document.createElement('canvas')
    canvas.width = image.width
    canvas.height = image.height
    canvas.getContext('2d')!.putImageData(image as ImageData, 0, 0)
    return canvas.toDataURL('image/png')
  }
  for (const api of [chrome.action, chrome.browserAction]) {
    if (!api || typeof api.setIcon !== 'function') continue
    const original = api.setIcon
    api.setIcon = promised(async (details: any) => {
      const images = details && details.imageData
      if (!images) return original.call(api, details)
      const bySize: Record<string, { width: number; height: number }> = typeof images.width === 'number' ? { [images.width]: images } : images
      const path: Record<string, string> = {}
      for (const [size, image] of Object.entries(bySize)) path[size] = await toDataUrl(image)
      const { imageData: _drawn, ...rest } = details
      return original.call(api, { ...rest, path })
    })
  }

  // The paste of a content script. Electron does not let it call `document.execCommand('paste')` (the extension platform does, for an extension that holds "clipboardRead"), so the
  // content script (src/main/engine/content-prelude.ts) asks over a port, and the paste is done by the main process in the tab the port comes from. Only a port of
  // this extension, opened by a content script of one of its tabs; the main process checks the permission and the host again (shell/extension-shims.ts). The worker
  // alone listens: a port reaches every page of the extension that listens (its hidden page, a panel, an offscreen document), and each would paste once more.
  if (permissions.has('clipboardRead') && typeof document === 'undefined') {
    chrome.runtime.onConnect.addListener((port: any) => {
      if (port.name !== '__lucium-paste') return
      const sender = port.sender
      if (!sender || sender.id !== extensionId || !sender.tab || typeof sender.tab.id !== 'number' || String(sender.url).startsWith('chrome-extension:')) {
        port.disconnect()
        return
      }
      const tabId: number = sender.tab.id
      port.onMessage.addListener((message: any) => {
        if (!message || message.type !== 'paste') return
        invoke('clipboard', 'paste', [tabId]).catch((error: any) => console.warn('[lucium] the paste of a content script failed:', error && error.message))
      })
    })
  }

  installCopyCommand()

  // chrome.downloads: the library's functions do nothing.
  if (permissions.has('downloads') && chrome.downloads) {
    for (const name of ['download', 'search', 'cancel', 'erase']) chrome.downloads[name] = method('downloads', name)
    for (const name of ['onCreated', 'onChanged', 'onErased']) chrome.downloads[name] = event('downloads', name)
  }

  // chrome.runtime.getContexts: the panel docked beside the page is a side panel context, and the native list does not know it.
  if (typeof chrome.runtime.getContexts === 'function') {
    const nativeGetContexts = chrome.runtime.getContexts
    const same = (wanted: unknown[] | undefined, value: unknown) => !Array.isArray(wanted) || wanted.includes(value)
    const matches = (context: any, filter: any) =>
      same(filter.contextTypes, context.contextType) &&
      same(filter.tabIds, context.tabId) &&
      same(filter.windowIds, context.windowId) &&
      same(filter.frameIds, context.frameId) &&
      same(filter.documentUrls, context.documentUrl) &&
      same(filter.documentOrigins, context.documentOrigin) &&
      same(filter.contextIds, context.contextId) &&
      (typeof filter.incognito !== 'boolean' || filter.incognito === context.incognito)
    chrome.runtime.getContexts = (filter: any, callback?: (contexts?: unknown) => void) => {
      const wanted = filter || {}
      const result = Promise.all([nativeGetContexts.call(chrome.runtime, wanted), invoke('runtime', 'sidePanelContexts', [])]).then(([native, panels]) => [
        ...native,
        ...(panels as any[]).filter((context) => matches(context, wanted))
      ])
      if (typeof callback !== 'function') return result
      result.then(
        (contexts) => callback(contexts),
        (error) => failWith(error, callback)
      )
      return undefined
    }
  }
}

/**
 * Whether this is a context of an extension. A page or a worker of a web site has no `chrome.runtime.id`, and must be handed neither the
 * bridge nor the shims: for the service workers, the preload is registered for the whole session (for the frames, for the pages of extensions
 * only: see `registerFrameShims` in the engine). (The main world is asked, because that is where `chrome` lives.)
 */
function inExtensionContext(): boolean {
  return (
    contextBridge.executeInMainWorld({
      func: () => {
        const runtime = (globalThis as { chrome?: { runtime?: { id?: unknown } } }).chrome?.runtime
        return typeof runtime?.id === 'string' && runtime.id !== ''
      }
    }) === true
  )
}

function install(): void {
  if (!inExtensionContext()) return
  const isolated = globalThis as { __luciumBridged?: boolean }
  // The script runs twice in the same isolated world (see the top of this file): the bridge is exposed once.
  if (!isolated.__luciumBridged) {
    isolated.__luciumBridged = true
    contextBridge.exposeInMainWorld('__luciumShim', {
      call: (extensionId: string, api: string, method: string, args: unknown[]) => ipcRenderer.invoke(CALL_CHANNEL, extensionId, api, method, args),
      onEvent: (listener: (api: string, name: string, args: unknown[]) => void) => {
        ipcRenderer.on(EVENT_CHANNEL, (_e, api: string, name: string, args: unknown[]) => listener(api, name, args))
      },
      tabCapture: tabCaptureBridge()
    })
  }
  contextBridge.executeInMainWorld({ func: mainWorldShims, args: [NAMESPACE_PERMISSION, DATA_API_METHODS, DATA_API_EVENTS] })
  // After the second pass only (it checks that `chrome` is frozen): the senders of messages are given the real tab (a popup or an offscreen document, none).
  contextBridge.executeInMainWorld({ func: fixSenderTabs })
  // The worker answers for the script the extension injected into a tab the user lent it (it needs the listeners of the messages, which the call above puts where it can reach them).
  contextBridge.executeInMainWorld({ func: answerLentTabs, args: [NO_RECEIVER, PORT_CLOSED, TOO_LONG, LENT_PAYLOAD_MAX] })
}

/** Whether this frame is shown by the DevTools: the `devtools_page` of an extension and its panels are frames of the DevTools window. */
function inDevTools(): boolean {
  const origins = (globalThis as { location?: { ancestorOrigins?: ArrayLike<string> } }).location?.ancestorOrigins
  return origins !== undefined && Array.from(origins).includes('devtools://devtools')
}

/**
 * A page of an extension shown in the DevTools (its `devtools_page` and its panels) has no context isolation, and the library freezes `chrome` at the end of its preload,
 * before Chromium adds `chrome.devtools` to it: the page then never has `chrome.devtools`, which every DevTools extension (React Developer Tools, Redux DevTools) needs.
 * That one freeze, the library's, is skipped there; the next call of `Object.freeze` is the page's own again.
 */
function spareChromeFromFreeze(chrome: object): void {
  const freeze = Object.freeze
  Object.freeze = function (target: unknown) {
    if (target !== chrome) return freeze(target)
    Object.freeze = freeze
    return target
  } as typeof Object.freeze
}

/** The page of an extension's runtime this is, by its address and its manifest: the background page of a Manifest V2 extension, or not. */
function isBackgroundPage(runtime: { getManifest?: unknown }): boolean {
  if (typeof runtime.getManifest !== 'function') return false
  const manifest = (runtime.getManifest as () => unknown).call(runtime) as { manifest_version?: unknown; background?: { page?: unknown } } | null | undefined
  if (!manifest || Number(manifest.manifest_version) !== 2 || !manifest.background) return false
  const path = new URL(location.href).pathname
  // `background.scripts` runs in a page the browser makes; `background.page` names the extension's own.
  const page = manifest.background.page
  return path === '/_generated_background_page.html' || (typeof page === 'string' && path === `/${page.replace(/^\.?\//, '')}`)
}

/**
 * The background page of a Manifest V2 extension. Electron makes it without context isolation (an extension host, like the offscreen document), so its preload
 * world is the page's own and the bridge is a plain object. It is where such an extension listens to chrome.webRequest, and the browser never calls those
 * listeners (the hooks of Lucium's sessions come first): the shims feed them, and send back what the blocking ones answer. It gets the bridge, with its
 * events, and the shims in both passes, as an isolated page does. Its manifest is at hand before its own scripts run.
 */
function installInBackgroundPage(g: { __luciumShim?: unknown; __luciumBridged?: boolean }): void {
  // The script runs twice in the page (before and after the library's): the bridge is set once.
  if (!g.__luciumBridged) {
    g.__luciumBridged = true
    g.__luciumShim = {
      call: (extensionId: string, api: string, method: string, args: unknown[]) => ipcRenderer.invoke(CALL_CHANNEL, extensionId, api, method, args),
      onEvent: (listener: (api: string, name: string, args: unknown[]) => void) => {
        ipcRenderer.on(EVENT_CHANNEL, (_e, api: string, name: string, args: unknown[]) => listener(api, name, args))
      },
      tabCapture: tabCaptureBridge()
    }
  }
  mainWorldShims(NAMESPACE_PERMISSION, DATA_API_METHODS, DATA_API_EVENTS)
  fixSenderTabs()
}

/**
 * A document of an extension made without context isolation (an offscreen document) cannot be handed the bridge and does not need the shims: it needs the copy command alone
 * (MerciApp copies the text it pastes from such a document). Its preload world is the page's own, so the bridge is a plain object. The background page of a Manifest V2
 * extension, made the same way, is the exception: it gets the shims (`installInBackgroundPage`).
 */
function installWithoutIsolation(): void {
  const g = globalThis as unknown as { __luciumShim?: unknown; __luciumBridged?: boolean; __luciumManifest?: unknown; __luciumDevToolsSpared?: boolean; chrome?: { runtime?: { id?: unknown; getManifest?: unknown } } }
  const id = g.chrome?.runtime?.id
  if (typeof id !== 'string' || id === '') return
  if (isBackgroundPage(g.chrome!.runtime!)) return installInBackgroundPage(g)
  // This preload runs twice in the frame (before and after the library's): the freeze is spared once.
  const devtools = inDevTools()
  if (!g.__luciumDevToolsSpared && devtools) {
    g.__luciumDevToolsSpared = true
    spareChromeFromFreeze(g.chrome as object)
  }
  g.__luciumShim = {
    call: (extensionId: string, api: string, method: string, args: unknown[]) => ipcRenderer.invoke(CALL_CHANNEL, extensionId, api, method, args),
    onEvent: () => undefined,
    tabCapture: tabCaptureBridge()
  }
  // The sound of a tab is asked for by a call of `getUserMedia` in the page itself: it is set up now, before the manifest is read (see `mainWorldShims`). An offscreen document
  // is refused every other request for media (Electron 45 stops on one made from there); the pages of the DevTools are left as they are.
  mainWorldShims({}, {}, {}, devtools ? 'tab-audio' : 'tab-audio-offscreen')
  // `chrome.runtime.getManifest` is not there either: the extension's own manifest is read the way any of its pages can.
  fetch(`chrome-extension://${id}/manifest.json`)
    .then((response) => response.json())
    .then((manifest: unknown) => {
      g.__luciumManifest = manifest
      mainWorldShims({}, {}, {}, 'copy')
    })
    .catch((error: unknown) => console.warn('[lucium] the manifest of the extension could not be read, so its copy command is not set up:', error instanceof Error ? error.message : String(error)))
}

// Same guard as electron-chrome-extensions: extension service workers and extension pages. A service worker has no `location` to read in
// this preload (reading it threw, and no extension worker started), so `process.type` says it is a worker, and `install` asks the main
// world whether it is an extension's: the service worker of a web site is not handed the bridge. An extension document created without
// context isolation (an offscreen document) cannot receive the bridge: it has no use for these APIs, so it is left alone, but for the copy
// command; the background page of a Manifest V2 extension, made the same way, gets a plain bridge and the shims.
if (process.type === 'service-worker' || (typeof location !== 'undefined' && location.href.startsWith('chrome-extension://'))) {
  if (process.contextIsolated) {
    try {
      install()
    } catch (error) {
      console.error('[lucium] extension shims failed to install:', error)
    }
  } else if (typeof location !== 'undefined') {
    try {
      installWithoutIsolation()
    } catch (error) {
      console.error('[lucium] the copy command could not be set up for a document without context isolation:', error)
    }
  }
}
