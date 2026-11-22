// "A function that is off costs nothing" (docs/fonctions.md), checked from the source in two ways the unit tests of the gates cannot:
//  1. an inventory of the mechanisms that cost something while they exist (a recurring timer, a script every page loads, a hook on every
//     request, a listener on the power events…): every one of them is listed here with what keeps it off when its function is off. A new
//     one that is not listed fails this test, so that nobody adds an always-on mechanism without saying why it is not tied to a setting;
//  2. the wiring that lets the engine keep its sessions free of a function's scripts: the real engine, its profiles and the real library of the
//     extensions run over a stand-in of Electron (engine/engine-constructed.test-support.ts, profile-made.test-support.ts), and the
//     window on a stand-in (shell/browser-fake.test-support.ts). Only the Web Store's call sites are read from its source.

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { MEDIA_BRIDGE } from '@shared/media-player'
import { defaultSettings } from '@shared/model'
import { constructEngine, world as electronWorld } from './engine/engine-constructed.test-support'
import { engineForPages } from './engine/electron-page.test-support'
import { inertEngine, madeSessions } from './profile-made.test-support'
import type { SwitchedPreload } from './engine/switched-preload'
import { fakeBrowser } from './shell/browser-fake.test-support'
import { syncHost } from './shell/sync-host.test-support'
import { posix } from './windows.test-support'

vi.mock('electron', async () => (await import('./engine/engine-constructed.test-support')).engineElectron())
vi.mock('electron-chrome-extensions', async () => ({ ElectronChromeExtensions: (await import('./profile-made.test-support')).realLibrary() }))
vi.mock('electron-chrome-web-store', () => ({}))
// `Browser.start` runs on a stand-in (shell/browser-start.test.ts): the blocking service and the shims of the extensions are inert, as their own tests run them.
vi.mock('./blocking', () => ({ blockingService: () => ({ subscribe: () => () => {} }) }))
vi.mock('./shell/extension-shims', () => ({ ExtensionShims: class {} }))

const MAIN = fileURLToPath(new URL('./', import.meta.url))

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return path.endsWith('.ts') && !path.endsWith('.test.ts') && !path.endsWith('.d.ts') && !/\/smoke[^/]*\.ts$/.test(posix(path)) ? [path] : []
  })
}

/** The code of a file without the lines that are only comments. */
const codeOf = (path: string): string =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')

const read = (file: string): string => readFileSync(join(MAIN, file), 'utf8')

/** A program or a worker started: a call of a launcher of node:child_process by its own name, an import of one under another name, a utility process, a worker, a request to an XPC service. */
const PROGRAM_STARTED = /\b(?:spawn|spawnSync|execFile|execFileSync|execSync|fork)\(|\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\s+as\s+\w+|utilityProcess\.fork|new Worker\(|\.sendRequest\(/g

/** What each kind of mechanism looks like in the source. */
const KINDS = {
  'recurring timer': /\bsetInterval\(/g,
  'preload script in a session': /\.registerPreloadScript\(/g,
  'hook on the requests of a session': /webRequest\.on[A-Z]\w*\(/g,
  'listener on every new web contents': /'web-contents-created'/g,
  'listener on the service workers of a session': /serviceWorkers\.on\(/g,
  'listener on the power events': /powerMonitor\.on\(|power\.on\(/g,
  'system-wide shortcut': /globalShortcut\.register|\.register\(wanted/g,
  // What a function that is off must not do either: ask the network, start a program or a worker, listen to the state, run code in a page.
  'network request': /\bnet\.(?:fetch|request)\(|\.fetch\(/g,
  // `.sendRequest(` is a request to the XPC service of the vault's keychain, which launchd starts when it is not running (vault-keychain.ts).
  // `spawn as nodeSpawn`: a launcher imported under another name is not seen by its calls (`this.spawnProcess(…)`), so the aliased import is the mark.
  'program or worker started': PROGRAM_STARTED,
  'subscription to the state': /\.subscribe\(/g,
  // What the system says of itself (its scroll bars setting): a notification the system posts, and the application becoming active.
  'listener on the system settings': /\bsubscribeNotification\(|'did-become-active'/g,
  'code run in a page': /executeJavaScript\w*\(|insertCSS\(|addInitScript/g
} as const
type Kind = keyof typeof KINDS

interface Entry {
  kind: Kind
  file: string
  count: number
  /** What keeps it from costing anything while its function is off (or why it is the application's base). */
  why: string
}

const INVENTORY: Entry[] = [
  { kind: 'recurring timer', file: 'shell/auto-archive.ts', count: 1, why: "gate 'auto-archive': no timer while the general delay and every profile's are 'Jamais' (feature-wiring.test.ts)" },
  { kind: 'recurring timer', file: 'shell/auto-update.ts', count: 1, why: "gate 'auto-update' (feature-wiring.test.ts)" },
  { kind: 'recurring timer', file: 'shell/little.ts', count: 1, why: "gate 'little-archive' (smoke-features.ts)" },
  { kind: 'recurring timer', file: 'shell/browser.ts', count: 1, why: "the sleep sweep, gate 'sleep' (smoke-features.ts)" },
  { kind: 'recurring timer', file: 'shell/browser-layout.ts', count: 1, why: "the sliding of the page card, which ends by itself in a fraction of a second" },
  { kind: 'recurring timer', file: 'shell/battery-saver.ts', count: 1, why: 'armed only on battery power with the setting on (battery-saver.test.ts)' },
  { kind: 'recurring timer', file: 'blocking/service.ts', count: 1, why: 'armed only while an option of the blocker needs a list (blocking/service.test.ts)' },
  { kind: 'recurring timer', file: 'engine/web-store.ts', count: 1, why: "`schedule()` arms it only when installing is on and updates are not 'À la demande' (the default)" },
  { kind: 'recurring timer', file: 'shell/resource-watch.ts', count: 1, why: "the 2 s refresh of the resource panel of the sidebar: armed when a first panel opens in any window, cleared when the last one closes (or the application locks), never while none is open; the watch itself exists only while 'resource-gauge' is on (resource-watch.test.ts)" },
  { kind: 'recurring timer', file: 'shell/floating-video.ts', count: 1, why: "the reading of the floating video (« Image dans l'image » asked from Lucium): armed only while a video floats in Lucium's window and its bar is on screen, every 0.5 s; cleared as the bar hides or the window closes (floating-video.test.ts)" },
  { kind: 'recurring timer', file: 'shell/window-share.ts', count: 1, why: "the annotated share (on by default; not built at all with LUCIUM_ANNOTATE=0, from the sources or in a smoke run): armed only while a window is shared (every 2 s, to see that the window is still there); stopped with the share (window-share.test.ts)" },

  { kind: 'preload script in a session', file: 'engine/electron-engine-preloads.ts', count: 5, why: 'window.chrome.app (the identity of the pages as a Chrome has no setting: a base of the page, one small script per tab, which does nothing but define an object); the password bridge (registered only while the password manager is on, taken away when it goes off: password-bridge.test.ts, smoke-passwords.ts); the dialog bridge (window.prompt, no setting: a base of the page, one small script per tab); the shims and the patches for the service workers (2), put in a session only when an extension is first loaded there; those for the frames go through `registerLimitedPreload` (extension-runtime.ts)' },
  { kind: 'preload script in a session', file: 'engine/electron-engine-network.ts', count: 2, why: 'the page guard (scriptlets and fingerprint: put in a session only while block-scriptlets, fingerprint or the blocking of ads is on, which carries the rules of the YouTube player; taken out by the portal), and the same script for the service workers of the web, put in a session only while fingerprint is on and taken out with it (inner-guard-wiring.test.ts)' },
  { kind: 'preload script in a session', file: 'engine/extension-runtime.ts', count: 2, why: 'one helper, `registerLimitedPreload`: the library scripts and our shims for the frames, put in a session at its first extension load, those of frames limited to the pages of extensions (and again without the limit for an Electron that refuses it); engine/web-store.ts puts the script of the store through it too, limited to the pages of the store, only while installing from the store is on (extension-runtime.test.ts)' },
  { kind: 'preload script in a session', file: 'engine/internal-pages.ts', count: 1, why: "the script of the Extensions page (a tab at lucium-ui://extensions/): registered in the session of a profile for that address alone (`matches`), so no other document reads or runs it; a refused limit registers nothing at all, and a private context or a container never gets it (internal-pages.test.ts)" },
  { kind: 'preload script in a session', file: 'engine/switched-preload.ts', count: 1, why: "the media bridge: registered only while 'media-player' is on (switched-preload.test.ts)" },

  { kind: 'hook on the requests of a session', file: 'engine/electron-engine-network.ts', count: 13, why: 'the response policy ($removeparam, $csp: added by the hook of the answers only while a rule needs it, engine-cache.test.ts) and its redirect hook; the hook of the answers itself is a base of the application with no setting (a host that asks for strict transport security is held to it: strict-transport.ts): with nothing else to do it sees the https documents only (local-file-wiring.test.ts); the blocker and the privacy options share one hook per session with the guard of local files, a base of the application with no setting (a local page must not read the disk: local-file-guard.ts): it always sees file:// only, and the web requests only while the blocker or a privacy option is on (local-file-wiring.test.ts); GPC has its own (network.test.ts, smoke-features.ts), the hook of the request headers, which is also a base of the application with no setting and is always on a session of pages (the three Client Hints Chromium leaves out of the navigations: shared/client-hints.ts): with nothing else to do it sees the navigations of the web only, and adds nothing until the hints of the engine are read (client-hints-wiring.test.ts); the request rules and the request listeners of extensions (Electron applies neither in a session the application watches): the three hooks above widen, and the five that only watch (onSendHeaders, onBeforeRedirect, onResponseStarted, onCompleted, onErrorOccurred, each set and taken away in installRequestEvents) exist, only while an extension of the profile has a rule or listens to that event, and never in a private context (extension-net-wiring.test.ts)' },
  { kind: 'hook on the requests of a session', file: 'engine/electron-engine-profile.ts', count: 1, why: 'the answers to the pictures of the default session, for images only: a base of the application with no setting. The interface draws the icons of sites from the copies of the main process and its pages may load no picture of the web (page-csp.test.ts); should one leave this session all the same, its answer sets no cookie in a session that belongs to no profile and that nothing erases (interface-images.test.ts). The request side shares the listener of engine/own-requests.ts' },
  { kind: 'hook on the requests of a session', file: 'engine/own-requests.ts', count: 4, why: "Sec-GPC on the requests the application makes for itself (the feed of the versions, the filter lists, the translation catalogue, the Chrome Web Store, the lookups of icons and of live folders): one listener per session of the application, installed only while 'sendGpc' is on and taken off when it goes off or when the session's service stops; the default session keeps, with the option off, the rule of its pictures alone and for images only (own-requests.test.ts)" },
  { kind: 'hook on the requests of a session', file: 'engine/session-hooks.ts', count: 3, why: 'removes the hooks of a session that ends (the response policy included)' },
  { kind: 'hook on the requests of a session', file: 'shell/space-images-electron.ts', count: 1, why: 'the throw-away session that shrinks a picture, made when a picture is chosen and for nothing else' },

  { kind: 'listener on every new web contents', file: 'engine/electron-engine-base.ts', count: 1, why: 'the last click or key anywhere (what lets the Web Store, a sign-in window and a shared screen know the user acted: a security base, no setting); the same listener hands each new web contents to the identity of the sign-in pages of Google (shared/google-sign-in.ts: a base of the pages, no setting; it looks at main-frame navigations and nothing else, google-sign-in-wiring.test.ts)' },
  { kind: 'listener on every new web contents', file: 'engine/electron-engine-extensions.ts', count: 1, why: 'the diagnostic log of LUCIUM_EXT_LOG (nothing without the variable)' },
  { kind: 'listener on every new web contents', file: 'engine/extension-dev.ts', count: 2, why: "the console of the extensions' pages (the Extensions page): added (and taken off) by `ExtensionConsoleWatch.start()`, which the window that holds the page calls for each tab that has it (shell/internal-pages.ts) and ends when the page goes (it sleeps, closes, moves or the window closes); none open, no listener (extension-console.test.ts, internal-pages.test.ts)" },
  { kind: 'listener on every new web contents', file: 'shell/page-commands.ts', count: 1, why: "Edit › Spelling: puts the choice on a new session; it listens to nothing afterwards" },

  { kind: 'listener on the service workers of a session', file: 'engine/electron-engine-network.ts', count: 1, why: 'the start of the service workers of the web, to answer the page guard they load: added only while fingerprint is on, removed with it (inner-guard-wiring.test.ts)' },
  { kind: 'listener on the service workers of a session', file: 'engine/electron-engine-preloads.ts', count: 1, why: "the shims' worker tracking (put in a session with the first extension)" },
  { kind: 'listener on the service workers of a session', file: 'engine/electron-engine-extensions.ts', count: 3, why: 'the console of the workers (only when someone asked: `watchWorkerConsole`), and the two of LUCIUM_EXT_LOG' },

  { kind: 'listener on the service workers of a session', file: 'engine/extension-console.ts', count: 1, why: "the console of the extensions' workers, for the journal of the Extensions page: attached only between `start()` and the function it returns, i.e. while a tab of a window has the page (extension-console.test.ts, internal-pages.test.ts)" },

  { kind: 'listener on the power events', file: 'index.ts', count: 1, why: "the port given to the lock: it listens only while its function is on (lock-service.test.ts)" },
  { kind: 'listener on the power events', file: 'shell/password-wiring.ts', count: 1, why: "the port given to the password manager: it listens only while its function is on (password-service.test.ts)" },
  { kind: 'listener on the power events', file: 'shell/password-service.ts', count: 1, why: 'attached only while the vault is open (password-service.test.ts)' },
  { kind: 'listener on the power events', file: 'lock-service.ts', count: 1, why: 'attached only while the lock is on (lock-service.test.ts)' },
  { kind: 'listener on the power events', file: 'shell/system-quit.ts', count: 1, why: "the application's base (its quit path, no setting): the `shutdown` event fires once, when the system shuts down or logs out, and nothing runs before it; with the signal handlers it keeps a quit the system asks for from waiting for a question (system-quit.test.ts)" },
  { kind: 'listener on the power events', file: 'shell/battery-saver.ts', count: 2, why: 'attached only while the setting is on (battery-saver.test.ts)' },

  { kind: 'system-wide shortcut', file: 'shell/little-shortcut.ts', count: 1, why: "gate 'little-shortcut' (feature-wiring.test.ts)" },
  { kind: 'system-wide shortcut', file: 'shell/page-annotate.ts', count: 2, why: "the annotation of a page (on by default; not built with LUCIUM_ANNOTATE=0): ⌥⌘P is held only while an annotation runs, and released when it stops; ⌥⌘M (start and stop) is held system-wide only while the user's setting « ⌥⌘M depuis toute application » is on (off by default: the File menu binds it), and released as soon as it is off or the controller is disposed (page-annotate.test.ts)" },
  { kind: 'system-wide shortcut', file: 'shell/window-share.ts', count: 1, why:"the annotated share (on by default; not built with LUCIUM_ANNOTATE=0): ⌥⌘P is held only while a window is shared and its switch in the command window is on, and released when the share stops (window-share.test.ts)" },

  // ---- Requests, programs, subscriptions and page code. Each one is either asked for (a click, a menu command), kept off by the setting of its function, or the application's base. ----
  { kind: 'network request', file: 'blocking/index.ts', count: 1, why: 'the fetch handed to the list updater, which runs only while an option of the blocker needs a list; the engine tests give it an offline one' },
  { kind: 'network request', file: 'blocking/list-updater.ts', count: 1, why: 'downloads a list: only when the blocking service asks (an option of the blocker on, a list due), never for a custom list' },
  { kind: 'network request', file: 'translate/controller.ts', count: 1, why: "downloads a language pack: only after the user pressed the button of the translation panel ('translate-local', docs/traduction-locale.md)" },
  { kind: 'network request', file: 'translate/transfer.ts', count: 1, why: "the files of a language pack and the Bergamot engine's WebAssembly binary (zstd, resumed with a Range after a cut): only during a download the user clicked in the translation panel, once the addresses and the size were shown ('translate-local', translate.test.ts: nothing asked before a click)" },
  { kind: 'network request', file: 'shell/favicon-service.ts', count: 1, why: "the icon of a site: the service exists only while 'favicons' is on (gate, smoke-features.ts: no request with the setting off)" },
  { kind: 'network request', file: 'shell/favicon-resolver.ts', count: 1, why: "the home page of a site without an icon: run by the favicon service only (gate 'favicons')" },
  { kind: 'network request', file: 'shell/menu-actions.ts', count: 1, why: 'the update feed, asked by the menu command "Rechercher les mises à jour…" (the user\'s click), never by itself' },
  // Not a request of this process, so no pattern above sees it: the download of an update by Squirrel.Mac (shell/app-update.ts,
  // autoUpdater.checkForUpdates), started only by « Télécharger et installer » after the menu's check or by « Installer » in the notice of the
  // background look; nothing of the autoUpdater is touched before.
  { kind: 'network request', file: 'shell/ollama-fetch.ts', count: 2, why: "the two ways out of the page summary and of the two requests of its settings (the test of an Ollama address, the list of its models): net.fetch to Ollama on this Mac, and the fetch of a session without a proxy to Ollama on a computer of the local network; only on a click on « Résumer la page » or on a click of the AI settings (turning Ollama on, « Lire les modèles installés », a connection test), never when the pane is drawn (AISettings has no effect: ai-settings-models.test.ts)" },
  { kind: 'network request', file: 'shell/browser-dialogs.ts', count: 1, why: "the description file of a site's search engine after the user accepts the offer of 'search-discovery' (nothing is read while the setting is off: discoverSearch)" },
  { kind: 'network request', file: 'shell/ipc.ts', count: 1, why: "the suggestions of the search engine while typing: the handler answers [] before any request when the setting of the profile (its own, else the general one) is off" },
  { kind: 'network request', file: 'shell/auto-update.ts', count: 1, why: "the look at the update feed (the built-in address in the built application) 20 s after launch then once a day: gate 'auto-update', on by default; the setting off sends nothing (feature-wiring.test.ts, update-feed.test.ts, smoke-features.ts)" },
  { kind: 'network request', file: 'shell/translate-ipc.ts', count: 2, why: "the two ways the translation panel reaches the packs' server: only after a click, and only with 'translate-local' on" },
  { kind: 'network request', file: 'engine/web-store.ts', count: 1, why: "the transport of the Chrome Web Store: used by an install or an update the user asked for, or by the check that 'web-store' schedules only when it is on and the mode is not \"À la demande\"" },
  { kind: 'network request', file: 'engine/electron-engine-downloads.ts', count: 1, why: "the probe of a server that resumes a download (only with 'download-resume' on: engine/download-resume.ts)" },
  { kind: 'network request', file: 'engine/ephemeral-scope.ts', count: 1, why: "the icon a page of a private window declares, fetched through the private session (no credentials) so that the disk cache of the sidebar does not remember the site: a base of the sidebar" },
  { kind: 'network request', file: 'engine/site-icons.ts', count: 1, why: "the icon of a site, downloaded once through the session of the profile that shows it, when the interface draws a row with that icon: a base of the sidebar, which no longer loads any picture from a site itself. Nothing is asked for an icon no page declared and the state does not name (site-icons.test.ts)" },
  { kind: 'network request', file: 'engine/electron-engine-network.ts', count: 1, why: 'the session of the profile handed to engine/site-icons.ts for that download: the same request, counted where the session is' },
  { kind: 'network request', file: 'engine/electron-page-navigation.ts', count: 1, why: "'Enregistrer les images' (a command): the pictures of the page, fetched through its own session" },

  { kind: 'program or worker started', file: 'engine/download-quarantine.ts', count: 1, why: 'xattr, run when a download finishes to put the macOS quarantine mark on the file (download-quarantine.test.ts), never otherwise' },
  { kind: 'program or worker started', file: 'launch-refusal.ts', count: 1, why: "/bin/sh, which runs zenity or kdialog (the box that says why a launch was refused) and then xdg-open (its first button opens the download page), all by absolute path: started only in a launch that the built application refuses for --no-sandbox on Linux, with a screen, detached, after which the launch ends at once (launch-refusal.test.ts); never in a launch that starts" },
  { kind: 'program or worker started', file: 'importers/service.ts', count: 1, why: 'plutil, run when the user imports Safari data from the import sheet, never otherwise' },
  { kind: 'program or worker started', file: 'shell/native-messaging.ts', count: 1, why: "the program of a native messaging host (`spawn as nodeSpawn`, called through `this.spawnProcess`): started only when an extension opens a port or sends a message to a host whose manifest is in Lucium's own folder (the folders of other browsers only with 'native-hosts' on), after the manifest, the extension and the real path of the program were checked; never at start (native-messaging.test.ts)" },
  { kind: 'program or worker started', file: 'shell/native-messaging-registry.ts', count: 1, why: "reg.exe of Windows (`execFile`, by its full path in System32), run to read where Chrome registered a native messaging host: only when an extension opens a port or sends a message to a host that Lucium's own folder does not have, only on Windows, and only with 'native-hosts' on (nativeHostRegistryKeys lists nothing otherwise); never at start (native-messaging-registry.test.ts)" },
  { kind: 'program or worker started', file: 'shell/default-browser-ports.ts', count: 1, why: "reg.exe of Windows (`execFile`, by its full path in System32), run to read which browser Windows holds for http and https: only on Windows, only when the default-browser row of the Settings or the welcome sheet is drawn and again when their window regains the focus; never at start, and never for the menu, which does not read it (default-browser.test.ts)" },
  { kind: 'program or worker started', file: 'shell/squirrel-staging.ts', count: 1, why: "launchctl remove, run only when an update downloaded in this run is found withdrawn by the feed (at a look of 'auto-update', from the menu, or at the quit), to take back the job Squirrel staged for it (squirrel-staging.test.ts, app-update.test.ts); never at start, never without a downloaded update" },
  { kind: 'program or worker started', file: 'shell/open-with.ts', count: 1, why: "the application the user chose to open a file with: run on that choice only ('open-with' only remembers it)" },
  { kind: 'program or worker started', file: 'shell/renderer-hosts.ts', count: 1, why: 'ps, run while the task manager is open, and only for a renderer that runs a service worker and holds no web contents nor frame: its Chromium id is read once per process, never again for it (renderer-hosts.test.ts); never at start' },
  { kind: 'program or worker started', file: 'shell/sleep-pressure.ts', count: 1, why: "sysctl, read for the memory pressure by the sleep sweep (while 'sleep' is on, no timer of its own) and by the resource gauge of the sidebar at the same beat and when its panel opens (while 'resource-gauge' is on); one reading serves 30 s (sleep-pressure.test.ts, resource-watch.test.ts); never at start" },
  { kind: 'program or worker started', file: 'platform/index.ts', count: 1, why: "pmset, read for the battery: asked by the battery saver only while 'battery-saver' is on (battery-saver.test.ts)" },
  { kind: 'program or worker started', file: 'engine/regex-find.ts', count: 1, why: "the worker of the regular-expression search: made at the first search with 'find-regex' on, ended with the search (regex-find.test.ts)" },
  { kind: 'program or worker started', file: 'vault-keychain.ts', count: 1, why: "the keychain helper of the vault's Touch ID (macOS, an XPC service that launchd starts for a request of the addon, and that leaves 10 s after its last connection): asked once when the user turns Touch ID on or off, opens the vault with it, or changes the phrase or deletes the vault while it is on, with 'password-manager' on (the service answers nothing while it is off: password-touch-id.test.ts); never at start" },
  { kind: 'program or worker started', file: 'helper-signature.ts', count: 1, why: "/usr/bin/codesign, run to check the signature of a helper of Contents/Helpers/ right before it would be started (the translation helper above is its only caller), and again only when the helper's files changed (a helper replaced or rewritten on the disk after a first check must not be started on the old verdict); never at start" },
  { kind: 'program or worker started', file: 'translate/bergamot.ts', count: 1, why: "the worker that runs the Bergamot engine (WebAssembly): made when a translation with a Bergamot model starts (a click on « Traduire », 'translate-local' on), terminated when that translation ends or is stopped (bergamot.test.ts)" },
  { kind: 'program or worker started', file: 'translate/system.ts', count: 1, why: "the helper of macOS's own translation (Contents/Helpers/LuciumTranslate.app, macOS 26 and later only): started by the first request, when the translation panel opens on a page (what the system has of the pair shown), for a translation the user clicked, or for a page that loads in a language the user put in « Toujours traduire » (a tab restored in such a language, as the application starts, included), with 'translate-local' on (the IPC answers nothing while it is off); one run serves the page's batches, then its input is closed after 45 s without a request and it quits (it quits by itself after 120 s without one, or when Lucium quits); an older build of it runs once per request, as before; never at start without a language in « Toujours traduire », never from the Settings window, never on an older macOS, never elsewhere than macOS (system-choice.test.ts, system.test.ts, system-stream.test.ts)" },

  { kind: 'program or worker started', file: 'publish-update.ts', count: 2, why: "not part of the application: nothing imports this file but scripts/publish-update.mjs, which the maintainer starts to publish an update (spawnSync for ssh, scp, curl and the local checks, spawn for the archive downloaded back and hashed); publish-update.test.ts runs it against fakes" },
  { kind: 'program or worker started', file: 'public-export.ts', count: 4, why: "not part of the application: nothing imports this file but scripts/export-public.mjs, which the maintainer starts to make the tree of the public repository (spawnSync for git and the secret scanners, execFileSync for git archive and tar); public-export.test.ts runs it on repositories made in temporary folders" },
  { kind: 'program or worker started', file: 'make-dmg.ts', count: 1, why: "not part of the application: nothing imports this file but scripts/make-dmg.mjs, which the maintainer starts to make the disk image of a release (spawnSync for ditto, hdiutil, codesign, xcrun notarytool and stapler, spctl and the local checks); make-dmg.test.ts runs it against fakes" },
  { kind: 'program or worker started', file: 'release-records.ts', count: 2, why: "not part of the application: nothing imports this file but scripts/build-record.mjs and scripts/engine-release-run.mjs, which the maintainer starts for a release (spawnSync for git, and for the pnpm scripts of the engine run); release-records.test.ts runs it against fakes" },
  { kind: 'program or worker started', file: 'verify-app.ts', count: 2, why: "not part of the application: nothing imports this file but scripts/verify-app.mjs, which the maintainer starts to check a built app (spawnSync for codesign, spctl, stapler and plutil, which only read; spawn for the two launches the built app must refuse, on a throw-away data folder); verify-app.test.ts runs it against fakes" },

  { kind: 'subscription to the state', file: 'store.ts', count: 1, why: 'the store itself: the subscription every other one goes through' },
  { kind: 'subscription to the state', file: 'shell/app-menu-wiring.ts', count: 1, why: "the application's base: the menu, rebuilt only when what it shows changed (`menuKey`)" },
  { kind: 'subscription to the state', file: 'shell/password-wiring.ts', count: 1, why: "the application's base: a subscriber of the lock, which closes the vault with the application" },
  { kind: 'subscription to the state', file: 'index.ts', count: 5, why: "the application's base: the lock's view, the gates of the application (`gates.gate(...)`), the block exception handlers registration, the lock's own subscribers, and the two of the synchronisation: the one that closes its window when the application locks (`sync.lockChanged()`: it does nothing while no window is open, and no window is open until the person opens one by hand, docs/synchronisation.md §6.1; sync-service.test.ts), and the handed port by which its marks follow the state (`session.subscribe`), which the service subscribes to only while the switch is on (sync-service-session.test.ts: « subscribes when it is turned on, and lets go when it is turned off »)" },
  { kind: 'subscription to the state', file: 'shell/annotate-wiring.ts', count: 1, why: "the system-wide ⌥⌘M of the page annotation (part of main()), which follows its setting (a comparison of two booleans; nothing is held while the setting is off), and the position, the clearing and the keys of one letter of its bar" },
  { kind: 'subscription to the state', file: 'shell/appearance.ts', count: 1, why: "the application's base: the two appearances (Lucium's, which moves nativeTheme, and the one asked of the websites, which goes to the pages; a comparison of two words, appearance.test.ts). Nothing is attached to any page while the websites' one is Automatique (engine/color-scheme.ts)" },
  { kind: 'subscription to the state', file: 'shell/app-icon.ts', count: 1, why: "the application's base: the Dock icon follows Settings › Icon (a comparison of two strings; followAppIcon, app-icon.test.ts)" },
  { kind: 'subscription to the state', file: 'shell/browser.ts', count: 5, why: "the window's base (its own sync, the lock, the battery saver's list of listeners, the blocker's events) and the favicon service, which exists only while 'favicons' is on (gate)" },
  { kind: 'subscription to the state', file: 'sync/sync-tracker.ts', count: 1, why: "the marks of the synchronisation follow the state (docs/synchronisation.md §9.2): subscribed by `MarkTracker.start()`, which the service calls only while the switch is on and at the launch when it was left on, and let go by `halt()` when it is turned off (sync-service-session.test.ts, sync-tracker.test.ts); nothing is subscribed while the switch is off" },
  { kind: 'subscription to the state', file: 'shell/windows.ts', count: 2, why: "the window manager's base: follows the shared state to open and close windows" },
  { kind: 'subscription to the state', file: 'shell/feature-gate.ts', count: 1, why: 'the portal: one subscription per gate, which is all a switched-off function owns (feature-wiring.test.ts: "the gate\'s own subscription is all there is")' },
  { kind: 'subscription to the state', file: 'shell/backups.ts', count: 1, why: "gate 'auto-backup' (feature-wiring.test.ts)" },
  { kind: 'subscription to the state', file: 'shell/favicon-service.ts', count: 1, why: "made and dropped with the service, which exists only while 'favicons' is on (smoke-features.ts)" },
  { kind: 'subscription to the state', file: 'shell/panel-scaling.ts', count: 1, why: 'the windows of their own (Réglages, Extensions, the task manager, À propos): armed when the first one opens and let go when the last one closes, so that nothing is subscribed while none is open (panel-scaling.test.ts); the comparison of one reference when the state changes' },
  { kind: 'subscription to the state', file: 'shell/little-shortcut.ts', count: 1, why: "gate 'little-shortcut' (feature-wiring.test.ts)" },
  { kind: 'subscription to the state', file: 'shell/thumbnails.ts', count: 1, why: "made with the thumbnails, which exist only while 'hover-cards' is on (gate in shell/ipc.ts, smoke-features.ts)" },
  { kind: 'listener on the system settings', file: 'shell/system-scroll-bars.ts', count: 2, why: "« Toujours afficher les barres de défilement » (macOS): the one notification the system posts when the setting changes, read as a base of the interface with no setting of its own (the interface follows the system, as it does for the appearance); it costs nothing until the setting is changed, and a Mac that is not a Mac never subscribes (system-scroll-bars.test.ts)" },
  { kind: 'listener on the system settings', file: 'index.ts', count: 1, why: 'the setting above is read again each time the application becomes active, in case the notification was missed: one read of a user default, nothing while the application is in the background (launch-wiring.test.ts)' },

  { kind: 'code run in a page', file: 'engine/engine-client-hints.ts', count: 2, why: 'the read of navigator.userAgentData in the page of the main window (the Client Hints of the engine, for the navigations of the pages): a base of the application with no setting, once a run, when that page commits (again at its document if that read came too early), and never again once read; the other match is the type of the web contents it is given (engine-client-hints.test.ts)' },
  { kind: 'code run in a page', file: 'engine/electron-engine-bridge.ts', count: 4, why: 'the relay of an event of an extension (registerRelay, relayScript); and the script or the style sheet an extension asks chrome.scripting to put in a tab the user lent it with a click (scriptLentTab: only on such a call, only for an extension that holds activeTab and scripting, extension-net-calls.test.ts)' },
  { kind: 'code run in a page', file: 'engine/lent-tabs.ts', count: 2, why: "the message or the change of the storage that an extension hands to the script it injected into a tab the user lent it with a click (LentTabs.deliver): only for an extension that holds activeTab and scripting, only after its own call of chrome.scripting.executeScript on that tab made the runtime there, and only in the world of that extension (lent-tabs.test.ts)" },
  { kind: 'code run in a page', file: 'engine/electron-page-base.ts', count: 2, why: "on a command or a switch: the style slots (applyCss; empty while their function is off: the theme, the dark mode, the blocker's hiding, the Boosts), and the one call that takes a question or a command of the media player to every frame of the page (inFrames)" },
  { kind: 'code run in a page', file: 'engine/electron-page-content.ts', count: 11, why: "the layer of the page annotation (runAnnotateLayer, in its own isolated world): only while an annotation the user started runs, on the pages it was shown on, and taken away when it stops; the animation of « Effacer les données du site » (runClearOverlay, in its own isolated world): only while a run the user started (the sheet, the shortcut, a menu) erases a site, never with « Aucune » or while motion is reduced, and gone with the run; the readable mode (runReadable: its probe and its recolouring engine, in its own isolated world), only for a page of a site that is not on Original, never while every site is (readableInUse, Browser.applyDarkToPage); the fake-data fill of a form (readFormFields, fillFormFields): only on the right-click command on an editable field, never on its own; on a command or a switch: the panels, the Boost scripts, the element picker, the translation, the password fill" },
  { kind: 'code run in a page', file: 'engine/electron-page-lifecycle.ts', count: 2, why: "the probe of the sleep, and the one that is always there: the typing watcher (TRACK_INPUT, every document). The probe of the sleep, of the automatic reload and of « Actualiser tous les onglets » reads it to leave a page with unsent text alone, so it is a base of the safety of the typed text, not of the sleep (docs/fonctions.md)" },
  { kind: 'code run in a page', file: 'engine/electron-page-media.ts', count: 18, why: "on a command or a switch: the page tools (only those whose setting is on: syncTools), scroll sync, reading aloud, Picture in Picture (asked whether to float in a world of its own when a tab is left, for the system's window or Lucium's) and Lucium's floating video window (its search in the page and its frames, the staging of the video, its reading while the bar is on screen, its commands: only from the menu or the media player's button), the media volume (media-player)" },
  { kind: 'code run in a page', file: 'engine/electron-page-navigation.ts', count: 3, why: "on a command: the PDF zoom, the regex find, the search discovery" },
  { kind: 'code run in a page', file: 'engine/electron-page.ts', count: 2, why: "the language of each loaded page, read once to offer the translation entry for another language (did-stop-loading), only while 'translate-local' is on and in the translation's isolated world (its lang attribute, or for a web page without one its visible text: sampleScript), nothing leaves the machine" },
  { kind: 'code run in a page', file: 'engine/devtools-open.ts', count: 2, why: "the front-end of the developer tools (devtools://, not a web page): asks it to show a panel or to enter the inspect mode, on a command (⌥⌘I/J/C, F12, the page menu), never otherwise" },
  { kind: 'code run in a page', file: 'engine/error-pages.ts', count: 2, why: "the error page of the browser itself (chrome-error:), when a page fails to load; and the veil put over a page that answered 404 or 5xx with nothing to show (only when the document is empty and has no script)" },
  { kind: 'code run in a page', file: 'engine/sleep-probe.ts', count: 2, why: "the sleep's question to the frames of a page (an embedded player): whether a video floats in Picture in Picture, asked only when the sweep, a reload of all tabs or the automatic reload is about to put that page to sleep or reload it (the type of a frame that can be asked, and the call)" },
  { kind: 'code run in a page', file: 'engine/tab-capture-helper.ts', count: 1, why: "the fixed script of the helper page of a capture of the sound of a tab by an extension (HELPER_SCRIPT: no parameter, it reads the samples of the sound and sends them to the main process): only while an extension the person allowed (Réglages › Extensions et outils, then the switch of the extension) captures a tab it was handed, in a window nobody sees that is made for that capture and destroyed with it; nothing before, nothing after (tab-capture-helper.test.ts)" },
  { kind: 'code run in a page', file: 'engine/markdown-picker.ts', count: 2, why: 'the block picker of the Markdown export: started and ended by the command' },
  { kind: 'code run in a page', file: 'engine/page-reader.ts', count: 1, why: 'reads a page for the export or the reader: on a command' },
  { kind: 'code run in a page', file: 'engine/reader-mode.ts', count: 1, why: 'the reader mode: on a command' },
  { kind: 'code run in a page', file: 'shell/dev-aids.ts', count: 1, why: 'a probe of the application\'s own window (the extension buttons), not of a web page' },
  { kind: 'code run in a page', file: 'shell/annotate-bar-ghost.ts', count: 1, why: "the annotation bar's drop zones (on by default; not built with LUCIUM_ANNOTATE=0): the overlay's own page, made when the user drags the grip of the bar and destroyed at the drop, lights a zone and puts the outline of the landing place (ghostCall: numbers and the name of one of four edges); never otherwise (page-annotate.test.ts)" },
  { kind: 'code run in a page', file: 'shell/browser-commands.ts', count: 1, why: "the application's own window: opens the popup of an extension from the toolbar (activateExtension)" },
  { kind: 'code run in a page', file: 'shell/context-menu-folder.ts', count: 1, why: "the application's own window: renames a folder from its menu" },
  { kind: 'code run in a page', file: 'shell/settings-window.ts', count: 1, why: "the application's own Settings window: goes to the right pane" },
  { kind: 'code run in a page', file: 'shell/menu-bar-edit.ts', count: 1, why: 'asks whether a field of the page is being edited, to enable or not an Edit command: on that menu command' },
  { kind: 'code run in a page', file: 'shell/portrait.ts', count: 1, why: "the application's own window: waits for its images before a capture" },
  { kind: 'code run in a page', file: 'shell/space-images-electron.ts', count: 1, why: 'the throw-away view that shrinks a picture the user chose for a space' },
  { kind: 'code run in a page', file: 'shell/tooltip.ts', count: 1, why: "the application's own tooltip window" },
  { kind: 'code run in a page', file: 'shell/fullscreen-notice.ts', count: 1, why: "the notice's own page, made when a web page takes the window in full screen and closed five seconds later or with the full screen: it measures its own size once (fullscreen-notice.test.ts); never otherwise" }
]

describe('the pattern of the programs started', () => {
  const seen = (code: string): number => (code.match(PROGRAM_STARTED) ?? []).length

  it('sees a launcher of node:child_process called by its own name, and one imported under another name', () => {
    expect(seen(`spawn('ps', [])`)).toBe(1)
    expect(seen(`execFile('xattr', [])`)).toBe(1)
    expect(seen(`import { spawn as nodeSpawn } from 'node:child_process'`)).toBe(1)
    expect(seen(`import { execFile as run, type ChildProcess } from 'node:child_process'`)).toBe(1)
    expect(seen(`import {\n  fork as forkChild,\n  exec as shell\n} from 'node:child_process'`)).toBe(2)
  })

  it('does not take for a program the other things named alike', () => {
    expect(seen(`const found = /a/.exec(text)`)).toBe(0)
    expect(seen(`import { join as joinPath } from 'node:path'`)).toBe(0)
    expect(seen(`const forked = options.fork`)).toBe(0)
  })
})

describe('the mechanisms that cost something while they exist', () => {
  const found = new Map<string, number>()
  for (const path of sourceFiles(MAIN)) {
    const code = codeOf(path)
    for (const [kind, pattern] of Object.entries(KINDS)) {
      const count = (code.match(pattern) ?? []).length
      if (count > 0) found.set(`${kind}|${posix(relative(MAIN, path))}`, count)
    }
  }

  it('are all listed, with what keeps them from costing anything while their function is off', () => {
    const listed = new Map(INVENTORY.map((e) => [`${e.kind}|${e.file}`, e.count]))
    const unlisted = [...found].filter(([key, count]) => listed.get(key) !== count).map(([key, count]) => `${key} x${count}`)
    expect(
      unlisted,
      `Un mécanisme qui coûte tant qu'il existe n'est pas dans l'inventaire (src/main/zero-cost-inventory.test.ts). Rattachez-le à son réglage par un portail (feature-gate.ts) et listez-le avec ce qui le coupe, ou dites pourquoi il fait partie de la base.`
    ).toEqual([])
  })

  it('are all still there: an entry whose mechanism is gone is removed from the inventory', () => {
    const stale = INVENTORY.filter((e) => found.get(`${e.kind}|${e.file}`) !== e.count).map((e) => `${e.kind}|${e.file}`)
    expect(stale).toEqual([])
  })

  it('give a reason for each entry', () => {
    for (const entry of INVENTORY) expect(entry.why.trim().length, `${entry.kind} in ${entry.file}`).toBeGreaterThan(20)
  })
})

const { ElectronEngine } = await import('./engine/electron-engine')
const { Browser } = await import('./shell/browser')
const engineMethods = ElectronEngine.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>
const shell = Browser.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>

describe('the wiring that keeps a function out of the sessions while it is off', () => {
  /** The text of a method, from its signature to the next member of the class at the same indentation. */
  const method = (source: string, signature: string): string => {
    const start = source.indexOf(signature)
    expect(start, `${signature} is not in the source any more`).toBeGreaterThanOrEqual(0)
    const next = source.slice(start + signature.length).search(/\n  (?:private |protected |abstract |async |public |static |readonly )*[A-Za-z_]+\(/)
    return source.slice(start, next < 0 ? undefined : start + signature.length + next)
  }

  /** A profile `p` the real `ensureProfile` makes, over the real library, on an engine whose other members are inert: its session, and the engine. */
  function profileMade(over: Record<string, unknown> = {}) {
    madeSessions.clear()
    const engine = Object.assign(Object.create(ElectronEngine.prototype) as Record<string, unknown>, inertEngine({ installShims: engineMethods['installShims'], installPatches: engineMethods['installPatches'], ...over }))
    engineMethods['ensureProfile']!.call(engine, 'p')
    return { engine, ses: [...madeSessions.values()][0]! }
  }

  it('puts the scripts of the extension runtime in a session only through its first extension load', () => {
    const { engine, ses } = profileMade({ registerFrameShims: engineMethods['registerFrameShims'], extensionNets: new WeakMap(), contextGone: () => undefined })
    // A profile that loaded nothing carries none of them, the library's own included (the library registers two as it is set up, and they are taken out right after).
    expect(ses.scripts.map((script) => script.id)).toEqual([])
    engineMethods['prepareExtensions']!.call(engine, 'p')
    // The first load puts them in, in the order they rely on: ours, the library's, ours again. A second load puts nothing more.
    const ids = ses.scripts.map((script) => script.id)
    expect(ids.filter((id) => id.startsWith('lucium-shims'))).toHaveLength(2)
    expect(ids.filter((id) => id.startsWith('crx-'))).toHaveLength(2)
    expect(ids.filter((id) => id.startsWith('lucium-patches'))).toHaveLength(2)
    expect(Math.max(...ids.flatMap((id, at) => (id.startsWith('lucium-shims') ? [at] : [])))).toBeLessThan(Math.min(...ids.flatMap((id, at) => (id.startsWith('crx-') ? [at] : []))))
    expect(Math.max(...ids.flatMap((id, at) => (id.startsWith('crx-') ? [at] : [])))).toBeLessThan(Math.min(...ids.flatMap((id, at) => (id.startsWith('lucium-patches') ? [at] : []))))
    engineMethods['prepareExtensions']!.call(engine, 'p')
    expect(ses.scripts).toHaveLength(ids.length)
  })

  it('prepares the session before an extension is loaded into it, by the engine and by the store', async () => {
    const order: string[] = []
    const engine = Object.assign(Object.create(ElectronEngine.prototype) as object, {
      profiles: new Map([['p', { runtime: { activate: () => void order.push('prepare') } }]]),
      extensionTools: { failed: vi.fn(), loaded: vi.fn() },
      extensionLedger: () => ({ idOfPath: () => undefined }),
      registerLoaded: (_profile: string, extension: unknown) => extension
    })
    await (engineMethods['loadInto']!.call(engine, 'p', { extensions: { loadExtension: async () => (order.push('load'), { manifest: { manifest_version: 3 } }) } }, '/nowhere/an-extension') as Promise<unknown>)
    expect(order).toEqual(['prepare', 'load'])
    // The Web Store is handed the same preparation as its host: what it installs, and what it updates, is loaded into a session that has the scripts.
    const constructed = await constructEngine()
    const activate = vi.fn()
    ;(constructed as unknown as { profiles: Map<string, unknown> }).profiles.set('p', { runtime: { activate } })
    ;((constructed as unknown as { webStore: { host: { prepareLoad(profileId: string): void } } }).webStore.host).prepareLoad('p')
    expect(activate).toHaveBeenCalledTimes(1)
    // And its three call sites (an install, the update check, the update the user accepted) come right before the library loads what it unpacked.
    const store = read('engine/web-store.ts')
    expect(store.match(/this\.host\.prepareLoad\(profileId\)/g) ?? []).toHaveLength(3)
    const install = store.indexOf('await rename(staged, target)')
    expect(store.indexOf('this.host.prepareLoad(profileId)', install)).toBeGreaterThan(install)
    expect(store.indexOf("return { action: 'allow' }", install)).toBeGreaterThan(store.indexOf('this.host.prepareLoad(profileId)', install))
  })

  it('gives a page the media bridge only through the switch, and listens on its channels only while it is on', async () => {
    // A page made in a session asks the switch for the script: it is registered while the bridge is on, and not once it is off.
    const world = await engineForPages({ ready: null })
    world.create('t')
    expect((world.engine as unknown as { mediaBridge: { ensure: ReturnType<typeof vi.fn> } }).mediaBridge.ensure).toHaveBeenCalledTimes(1)
    const constructed = (await constructEngine()) as unknown as { setMediaBridge(on: boolean): void; mediaBridge: SwitchedPreload<{ registerPreloadScript(script: unknown): string; unregisterPreloadScript(id: string): void }> }
    const session = () => ({ registerPreloadScript: vi.fn(() => "id"), unregisterPreloadScript: vi.fn() })
    const first = session()
    constructed.mediaBridge.ensure(first)
    expect(first.registerPreloadScript).toHaveBeenCalledWith(expect.objectContaining({ id: 'lucium-media-bridge' }))
    // The channels are served from the start (the bridge is on until the shell says the media player is off), and only while it is on.
    expect(electronWorld.ipcHandle.has(MEDIA_BRIDGE.hello)).toBe(true)
    expect(electronWorld.ipcOn.has(MEDIA_BRIDGE.actions)).toBe(true)
    constructed.setMediaBridge(false)
    expect(electronWorld.ipcHandle.has(MEDIA_BRIDGE.hello)).toBe(false)
    expect(electronWorld.ipcOn.has(MEDIA_BRIDGE.actions)).toBe(false)
    const second = session()
    constructed.mediaBridge.ensure(second)
    expect(second.registerPreloadScript).not.toHaveBeenCalled()
    constructed.setMediaBridge(true)
    expect(electronWorld.ipcHandle.has(MEDIA_BRIDGE.hello)).toBe(true)
  })

  it('loads the Web Store library for a profile only when something installed from the store is to be updated', () => {
    const run = method(read('engine/web-store.ts'), 'private async runUpdates(): Promise<UpdateReport> {')
    const nothing = run.indexOf('installed.length === 0')
    expect(nothing).toBeGreaterThanOrEqual(0)
    expect(run.indexOf('this.lib()')).toBeGreaterThan(nothing)
  })

  it('listens to the console of the service workers only when someone asked for it', () => {
    const watching = (): { listened: () => number; engine: Record<string, unknown>; ses: { serviceWorkers: { listenerCount(event: string): number } } } => {
      const made = profileMade({ watchWorkerConsole: engineMethods['watchWorkerConsole'], consoleListeners: [], consoleSessions: new WeakSet() })
      return { listened: () => made.ses.serviceWorkers.listenerCount('console-message'), engine: made.engine, ses: made.ses }
    }
    // A profile made while nobody listens does not carry the whole console of every worker to the main process.
    const quiet = watching()
    expect(quiet.listened()).toBe(0)
    // Someone asks (the engine test): the profiles that exist are listened to, once.
    engineMethods['onExtensionConsole']!.call(quiet.engine, () => undefined)
    expect(quiet.listened()).toBe(1)
    engineMethods['onExtensionConsole']!.call(quiet.engine, () => undefined)
    expect(quiet.listened()).toBe(1)
  })

  /** `Browser.start` for the main window or a private one: the gates it makes, by name. */
  const gatesOf = (kind: 'main' | 'private'): string[] => {
    const gates: string[] = []
    const fake = fakeBrowser({
      isPrivate: () => kind === 'private',
      isSecondary: () => false,
      gates: { gate: (id: string) => void gates.push(id) },
      store: { get: () => ({ settings: defaultSettings() }), subscribe: () => () => {} },
      group: new Set()
    })
    shell['start']!.call(fake.self)
    return gates
  }

  it("sweeps the archive only through the gate of 'auto-archive'", () => {
    // The gate is made by the main window, which sweeps the shared archive; a private window has none. No timer of the window's own is made at the start.
    vi.useFakeTimers()
    try {
      expect(gatesOf('main')).toContain('auto-archive')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
    expect(gatesOf('private')).not.toContain('auto-archive')
  })

  it('applies the media player setting to the engine and to the players the window holds', () => {
    // To the engine, by a normal window (a private window leaves the setting of the main window alone).
    const applied: boolean[] = []
    const windowWith = (mediaPlayer: boolean, own: Record<string, unknown> = {}) =>
      fakeBrowser({ isPrivate: () => false, isSecondary: () => false, engine: { setMediaBridge: (on: boolean) => void applied.push(on) }, store: { get: () => ({ settings: { ...defaultSettings(), mediaPlayer } }) }, ...own })
    shell['configureMediaBridge']!.call(windowWith(false).self)
    shell['configureMediaBridge']!.call(windowWith(true).self)
    shell['configureMediaBridge']!.call(windowWith(true, { isPrivate: () => true }).self)
    expect(applied).toEqual([false, true])
    // At the start of the window, and at each change of the settings: the two places that ask for it.
    const started = fakeBrowser({ isPrivate: () => false, isSecondary: () => false, gates: { gate: () => undefined }, store: { get: () => ({ settings: defaultSettings() }), subscribe: () => () => {} }, group: new Set() })
    shell['start']!.call(started.self)
    expect(started.calls.filter((call) => call.name === 'configureMediaBridge')).toHaveLength(1)
    const dispatching = (action: unknown) => {
      const state = syncHost([]).state()
      const fake = fakeBrowser({ isPrivate: () => false, store: { get: () => state, root: () => ({ get: () => state }), dispatch: () => undefined }, dispatch: shell['dispatch'], closedHistoryCtx: () => undefined, reopenedWithHistory: () => null, reopened: { begin: () => null, end: () => undefined } })
      shell['dispatch']!.call(fake.self, action)
      return fake.calls.filter((call) => call.name === 'configureMediaBridge').length
    }
    expect(dispatching({ type: 'settings/update', patch: { mediaPlayer: false } })).toBe(1)
    expect(dispatching({ type: 'tab/open', url: 'https://site.example/' })).toBe(0)
    // To the players the window holds: with the player switched off the players go, and each tab is given its own volume back (a player that still makes sense stays while it is on).
    const holdingWith = (mediaPlayer: boolean) => {
      const released: string[] = []
      const fake = fakeBrowser({
        mediaPlayers: ['t1'],
        store: { get: () => ({ tabs: [{ id: 't1' }], settings: { ...defaultSettings(), mediaPlayer } }) },
        visibleIds: () => [],
        runtimeOfGroup: () => ({ tabs: { t1: { loading: false, audible: true, muted: false, awake: true } } }),
        releaseMedia: (id: string) => void released.push(id)
      })
      shell['pruneMediaPlayers']!.call(fake.self)
      return { released, players: fake.self['mediaPlayers'] }
    }
    expect(holdingWith(true)).toEqual({ released: [], players: ['t1'] })
    const holding = { self: holdingWith(false) }
    expect(holding.self.released).toEqual(['t1'])
    expect(holding.self.players).toEqual([])
  })
})
