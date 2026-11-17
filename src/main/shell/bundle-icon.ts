// The chosen application icon, put on the application bundle itself so that the Dock, the Finder and the Launchpad keep it once Lucium is closed
// (Settings › About and updates › App icon; app-icon.ts does the Dock and decides which bundle). A custom icon is what the Finder's « Lire les informations »
// makes: an empty `Icon\r` file at the root of the bundle, the picture in its resource fork, and the root flagged by its `com.apple.FinderInfo`.
// That attribute fails `codesign --verify --deep --strict` (« resource fork, Finder information, or similar detritus not allowed »), while macOS
// still opens the application as notarized (`spctl`); taking the icon off removes both, and the strict check passes again (docs/drm.md). So the
// default icon, which is the bundle's own, is never put on it, and the icon comes off before an update replaces the bundle.
//
// Node only (no Electron): app-icon.ts hands over the bundle, the pictures and the log.

import { execFile } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync, rmSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { bundleIconStep, type AppIconIssue } from '@shared/icons'
import { replaceFileDurably } from '../durable-write'

/** The file of a folder's custom icon: empty, its picture in its resource fork. */
export const BUNDLE_ICON_FILE = 'Icon\r'

const OSASCRIPT = '/usr/bin/osascript'

/** How long the call to the system may take: the scripting host starts in a fraction of a second. */
export const BUNDLE_ICON_TIMEOUT_MS = 5000

/**
 * The system's own call, NSWorkspace `setIcon:forFile:options:`, through the scripting host (no native module). The text is a constant: the bundle
 * and the picture come as the arguments of `run`, never inside the script. An empty picture takes the custom icon off (the `Icon\r` file and the
 * attribute of the root go). A picture that cannot be read is an error, never « no picture », which would take the icon off. Prints true or false:
 * the call may refuse (a folder that cannot be written) and the host still ends well.
 */
export const BUNDLE_ICON_SCRIPT = [
  "ObjC.import('AppKit')",
  'function run(argv) {',
  "  if (argv.length !== 2) throw new Error('two arguments: the bundle, then the picture or an empty string')",
  '  let image = $()',
  "  if (argv[1] !== '') {",
  '    image = $.NSImage.alloc.initWithContentsOfFile(argv[1])',
  "    if (image.isNil()) throw new Error('the picture cannot be read')",
  '  }',
  "  return $.NSWorkspace.sharedWorkspace.setIconForFileOptions(image, argv[0], 0) ? 'true' : 'false'",
  '}'
].join('\n')

const execFileAsync = promisify(execFile)

/**
 * Runs the script on `bundle` with `picture` ('' takes the icon off), without a shell, for 5 seconds at most; answers what it printed. Both paths are
 * absolute: an argument that starts with a dash would be read by osascript as one of its options.
 */
export async function callBundleIconScript(bundle: string, picture: string): Promise<string> {
  if (!isAbsolute(bundle) || (picture !== '' && !isAbsolute(picture))) throw new Error(`not an absolute path: ${JSON.stringify(isAbsolute(bundle) ? picture : bundle)}`)
  const { stdout } = await execFileAsync(OSASCRIPT, ['-l', 'JavaScript', '-e', BUNDLE_ICON_SCRIPT, bundle, picture], { timeout: BUNDLE_ICON_TIMEOUT_MS, encoding: 'utf8' })
  return stdout
}

/** The `.app` folder an executable runs from (`<bundle>/Contents/MacOS/<name>`), or null when it is not in one. */
export function bundleOfExecutable(executable: string): string | null {
  const macos = dirname(executable)
  const contents = dirname(macos)
  const bundle = dirname(contents)
  return isAbsolute(executable) && basename(macos) === 'MacOS' && basename(contents) === 'Contents' && bundle.endsWith('.app') ? bundle : null
}

/** Which icon Lucium last put on which bundle, kept in the data folder: nothing is put again at each launch when the bundle already carries it. */
export interface PosedIcon {
  bundle: string
  icon: string
}

export interface BundleIconDeps {
  /** The bundle of the running application, or null: then nothing is ever written (see app-icon.ts). */
  bundle: () => string | null
  /** The picture of an icon of the list. */
  picture: (id: string) => string
  /** Whether the bundle carries a custom icon now. */
  hasCustomIcon: (bundle: string) => boolean
  /** Throws why the bundle cannot be written (not the owner, a read-only folder or volume). */
  checkWritable: (bundle: string) => void
  /** The call to the system (`callBundleIconScript`). */
  call: (bundle: string, picture: string) => Promise<string>
  /** The icon last put, null when none is recorded; throws when the record cannot be read. */
  readPosed: () => PosedIcon | null
  /** Records the icon put, or that none is (null). */
  writePosed: (posed: PosedIcon | null) => void
  log: (line: string) => void
}

const words = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * The custom icon of the running bundle, kept in step with the choice. One call to the system at a time: a choice made while one runs waits for
 * it, and a choice overtaken by a newer one before its turn does nothing (the newer one decides).
 */
export class BundleIcon {
  private queue: Promise<void> = Promise.resolve()
  private asked = 0
  private issue: AppIconIssue | null = null
  /** The icon came off for an update: nothing is put on the bundle again in this run. */
  private released = false

  constructor(private readonly deps: BundleIconDeps) {}

  /** Puts the icon `id` on the bundle, or takes the custom icon off for the default one; answers why it could not, once done. */
  keep(id: string): Promise<AppIconIssue | null> {
    const ticket = ++this.asked
    this.queue = this.queue.then(async () => {
      if (ticket !== this.asked || this.released) return
      this.issue = await this.sync(id)
    })
    return this.settled()
  }

  /** Why the bundle does not carry the chosen icon, once the calls under way are done (null: it does, or it needs none). */
  settled(): Promise<AppIconIssue | null> {
    return this.queue.then(() => this.issue)
  }

  /**
   * Before Squirrel replaces the application: takes the custom icon off the bundle, after the call under way, and puts nothing on it again in this
   * run. The new version arrives without it, and its first launch puts the chosen icon back. Never rejects: a failure is written to the log, and
   * the installation goes on.
   */
  releaseForUpdate(): Promise<void> {
    this.released = true
    const turn = this.queue.then(async () => {
      const bundle = this.deps.bundle()
      if (bundle === null || !this.deps.hasCustomIcon(bundle)) return
      const done = await this.change(bundle, '')
      if (done !== true) return this.deps.log(`[icon] cannot take the custom icon off ${bundle} before the update is installed (the installation goes on): ${done}`)
      this.remember(null)
      this.deps.log(`[icon] the custom icon was taken off ${bundle} before the update is installed; the next launch puts it back`)
    })
    this.queue = turn
    return turn
  }

  private async sync(id: string): Promise<AppIconIssue | null> {
    const bundle = this.deps.bundle()
    if (bundle === null) return null
    const step = bundleIconStep(id, { custom: this.deps.hasCustomIcon(bundle), posed: this.posedOn(bundle) })
    if (step === 'none') return null
    const done = await this.change(bundle, step === 'set' ? this.deps.picture(id) : '')
    if (done !== true) {
      if (step === 'clear') {
        this.deps.log(`[icon] cannot take the custom icon off ${bundle}: ${done}`)
        return null
      }
      this.deps.log(`[icon] cannot put the icon "${id}" on ${bundle}: ${done}; the Dock shows it only while Lucium runs`)
      return { reason: 'bundle-not-writable' }
    }
    this.remember(step === 'set' ? { bundle, icon: id } : null)
    return null
  }

  /** Puts `picture` on the bundle ('' takes the custom icon off), then checks the bundle. True when it worked; else what went wrong. */
  private async change(bundle: string, picture: string): Promise<true | string> {
    try {
      this.deps.checkWritable(bundle)
      const answer = (await this.deps.call(bundle, picture)).trim()
      if (answer !== 'true') return `macOS refused (it answered ${JSON.stringify(answer)})`
      const custom = this.deps.hasCustomIcon(bundle)
      if (custom !== (picture !== '')) return `macOS answered true, but the bundle ${custom ? 'still carries a custom icon' : 'carries no custom icon'}`
      return true
    } catch (error) {
      return words(error)
    }
  }

  private posedOn(bundle: string): string | null {
    try {
      const posed = this.deps.readPosed()
      return posed?.bundle === bundle ? posed.icon : null
    } catch (error) {
      this.deps.log(`[icon] the record of the icon put on the bundle cannot be read (${words(error)}): the icon is put again`)
      return null
    }
  }

  private remember(posed: PosedIcon | null): void {
    try {
      this.deps.writePosed(posed)
    } catch (error) {
      this.deps.log(`[icon] the record of the icon put on the bundle cannot be written (${words(error)}): the next launch puts the icon again`)
    }
  }
}

/** The real ones: the file system, the call to the system, and the record of the icon put (a small JSON file of the data folder). */
export function bundleIconDeps(options: { bundle: () => string | null; picture: (id: string) => string; record: () => string; log: (line: string) => void }): BundleIconDeps {
  return {
    bundle: options.bundle,
    picture: options.picture,
    hasCustomIcon: (bundle) => existsSync(join(bundle, BUNDLE_ICON_FILE)),
    checkWritable: (bundle) => accessSync(bundle, constants.W_OK),
    call: callBundleIconScript,
    readPosed: () => {
      const file = options.record()
      if (!existsSync(file)) return null
      const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
      const { bundle, icon } = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
      if (typeof bundle !== 'string' || typeof icon !== 'string') throw new Error(`${file} is not a record of an icon`)
      return { bundle, icon }
    },
    // Owner-only and whole, as every file of the data folder (durable-write.ts).
    writePosed: (posed) => (posed ? replaceFileDurably(options.record(), `${JSON.stringify(posed)}\n`) : rmSync(options.record(), { force: true })),
    log: options.log
  }
}
