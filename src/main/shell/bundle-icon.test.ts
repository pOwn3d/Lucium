// The custom icon of the application bundle (bundle-icon.ts): what is put, taken off or left, one call at a time, what a failure says; then, on
// macOS only, the real script on a throw-away bundle: the icon goes on and off, and the strict check of the signature fails, then passes again.
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { BUNDLE_ICON_FILE, BUNDLE_ICON_SCRIPT, BundleIcon, bundleIconDeps, bundleOfExecutable, callBundleIconScript, type BundleIconDeps, type PosedIcon } from './bundle-icon'
import { tempDir } from '../temp-dir'

const BUNDLE = '/Applications/Lucium.app'
const pictureOf = (id: string): string => `${BUNDLE}/Contents/Resources/app-icons/${id}.png`

/** A call to the system that waits until the test lets it end. */
function deferred() {
  let end: (answer: string) => void = () => undefined
  let fail: (error: Error) => void = () => undefined
  const promise = new Promise<string>((resolve, reject) => {
    end = resolve
    fail = reject
  })
  return { promise, end, fail }
}

/** A bundle as the keeper sees it: whether it carries a custom icon, the record of the icon put, every call to the system and every line of the log. */
function bundle(over: Partial<BundleIconDeps> & { custom?: boolean; posed?: PosedIcon | null } = {}) {
  const state = { custom: over.custom ?? false, posed: over.posed ?? null, running: 0, most: 0 }
  const calls: Array<[string, string]> = []
  const logs: string[] = []
  const deps: BundleIconDeps = {
    bundle: () => BUNDLE,
    picture: pictureOf,
    hasCustomIcon: () => state.custom,
    checkWritable: () => undefined,
    call: async (target, picture) => {
      calls.push([target, picture])
      state.custom = picture !== ''
      return 'true\n'
    },
    readPosed: () => state.posed,
    writePosed: (posed) => {
      state.posed = posed
    },
    log: (line) => void logs.push(line),
    ...over
  }
  return { keeper: new BundleIcon(deps), state, calls, logs }
}

describe('the custom icon of the bundle, as the choice changes', () => {
  it('puts a chosen icon other than the default on the bundle, with its picture, and records it', async () => {
    const b = bundle()
    expect(await b.keeper.keep('sepia-or')).toBeNull()
    expect(b.calls).toEqual([[BUNDLE, pictureOf('sepia-or')]])
    expect(b.state).toMatchObject({ custom: true, posed: { bundle: BUNDLE, icon: 'sepia-or' } })
    expect(b.logs).toEqual([])
  })

  it('does nothing again while the bundle carries the chosen icon, at this launch or the next one', async () => {
    const b = bundle()
    await b.keeper.keep('sepia-or')
    await b.keeper.keep('sepia-or')
    expect(b.calls).toHaveLength(1)
    // The next launch: a new keeper, the same bundle and record.
    const next = bundle({ custom: true, posed: { bundle: BUNDLE, icon: 'sepia-or' } })
    expect(await next.keeper.keep('sepia-or')).toBeNull()
    expect(next.calls).toEqual([])
  })

  it('puts the icon again when the bundle lost it (a new version replaced it), or carries one it does not know (another copy, another icon)', async () => {
    const replaced = bundle({ custom: false, posed: { bundle: BUNDLE, icon: 'sepia-or' } })
    await replaced.keeper.keep('sepia-or')
    expect(replaced.calls).toEqual([[BUNDLE, pictureOf('sepia-or')]])
    const moved = bundle({ custom: true, posed: { bundle: '/Users/someone/Desktop/Lucium.app', icon: 'sepia-or' } })
    await moved.keeper.keep('sepia-or')
    expect(moved.calls).toEqual([[BUNDLE, pictureOf('sepia-or')]])
    expect(moved.state.posed).toEqual({ bundle: BUNDLE, icon: 'sepia-or' })
  })

  it('takes the custom icon off when the default icon is chosen, and forgets the record; with nothing to take off, calls nothing', async () => {
    const b = bundle({ custom: true, posed: { bundle: BUNDLE, icon: 'cyber' } })
    expect(await b.keeper.keep('clair')).toBeNull()
    expect(b.calls).toEqual([[BUNDLE, '']])
    expect(b.state).toMatchObject({ custom: false, posed: null })
    await b.keeper.keep('clair')
    expect(b.calls).toHaveLength(1)
  })

  it('leaves the custom icon of another profile alone: a profile that put none on this bundle takes none off, whatever it asks for', async () => {
    // A second instance on a blank profile (a test, a capture, a measure): the bundle is shared, the record of the icon put is not.
    const blank = bundle({ custom: true })
    expect(await blank.keeper.keep('clair')).toBeNull()
    expect(await blank.keeper.keep('../../../etc/passwd')).toBeNull()
    expect(blank.calls).toEqual([])
    expect(blank.state.custom).toBe(true)
    expect(blank.logs).toEqual([])
    // The record names another copy of the application, not this bundle: no icon of this profile is on it either.
    const elsewhere = bundle({ custom: true, posed: { bundle: '/Users/someone/Desktop/Lucium.app', icon: 'cyber' } })
    expect(await elsewhere.keeper.keep('clair')).toBeNull()
    expect(elsewhere.calls).toEqual([])
    // A record that cannot be read proves nothing either: nothing is taken off.
    const unread = bundle({ custom: true, readPosed: () => { throw new SyntaxError('Unexpected token') } })
    expect(await unread.keeper.keep('clair')).toBeNull()
    expect(unread.calls).toEqual([])
    expect(unread.state.custom).toBe(true)
  })

  it('keeps the icon one profile put through the launches of another, and still takes it off when that profile goes back to the default icon', async () => {
    const owner = bundle()
    // A launch of another profile: its own record (none), the bundle of the owner.
    const launchOther = () => {
      const other: ReturnType<typeof bundle> = bundle({
        hasCustomIcon: () => owner.state.custom,
        call: async (target, picture) => {
          other.calls.push([target, picture])
          owner.state.custom = picture !== ''
          return 'true\n'
        }
      })
      return other
    }
    await owner.keeper.keep('cyber')
    expect(owner.state.custom).toBe(true)
    // The other profile starts on the default icon, as a new profile does: the icon of the owner stays, at each launch.
    const first = launchOther()
    const second = launchOther()
    await first.keeper.keep('clair')
    await second.keeper.keep('clair')
    expect(first.calls.concat(second.calls)).toEqual([])
    expect(owner.state.custom).toBe(true)
    // The owner goes back to the default icon: it comes off.
    await owner.keeper.keep('clair')
    expect(owner.state).toMatchObject({ custom: false, posed: null })
    expect(owner.calls).toEqual([[BUNDLE, pictureOf('cyber')], [BUNDLE, '']])
  })

  it('takes an id that is not one of the list for the default icon: no picture of it is ever looked for', async () => {
    const b = bundle({ custom: true, posed: { bundle: BUNDLE, icon: 'cyber' }, picture: () => { throw new Error('no picture is looked for') } })
    expect(await b.keeper.keep('../../../etc/passwd')).toBeNull()
    expect(b.calls).toEqual([[BUNDLE, '']])
  })

  it('writes nothing when there is no bundle of the running application (not macOS, not the built application)', async () => {
    const b = bundle({ bundle: () => null, custom: true })
    expect(await b.keeper.keep('cyber')).toBeNull()
    expect(await b.keeper.keep('clair')).toBeNull()
    expect(b.calls).toEqual([])
  })
})

describe('a bundle that cannot take the icon', () => {
  const cases: Array<[string, Partial<BundleIconDeps>, RegExp]> = [
    ['it cannot be written (installed by an administrator, a read-only folder or volume)', { checkWritable: () => { throw Object.assign(new Error(`EACCES: permission denied, access '${BUNDLE}'`), { code: 'EACCES' }) } }, /EACCES: permission denied/],
    ['macOS refuses', { call: async () => 'false\n' }, /macOS refused \(it answered "false"\)/],
    ['the call fails or takes too long', { call: async () => { throw new Error('Command failed: /usr/bin/osascript (killed: SIGTERM)') } }, /killed: SIGTERM/],
    ['macOS says yes and the bundle carries no icon', { call: async () => 'true\n' }, /macOS answered true, but the bundle carries no custom icon/]
  ]
  it.each(cases)('says so when %s: the Dock keeps it while Lucium runs, the log says why, nothing is recorded', async (_name, over, why) => {
    const b = bundle(over)
    expect(await b.keeper.keep('sepia-or')).toEqual({ reason: 'bundle-not-writable' })
    expect(await b.keeper.settled()).toEqual({ reason: 'bundle-not-writable' })
    expect(b.state.posed).toBeNull()
    expect(b.logs).toHaveLength(1)
    expect(b.logs[0]).toContain(`cannot put the icon "sepia-or" on ${BUNDLE}`)
    expect(b.logs[0]).toMatch(why)
    expect(b.logs[0]).toContain('the Dock shows it only while Lucium runs')
  })

  it('tries again at the next choice, and the issue goes once the icon is put', async () => {
    let refuse = true
    const b = bundle({ checkWritable: () => { if (refuse) throw new Error('EROFS: read-only file system') } })
    expect(await b.keeper.keep('cyber')).toEqual({ reason: 'bundle-not-writable' })
    refuse = false
    expect(await b.keeper.keep('solaire')).toBeNull()
    expect(b.state.posed).toEqual({ bundle: BUNDLE, icon: 'solaire' })
  })

  it('writes to the log when the custom icon cannot be taken off for the default icon (the Dock shows the default one all the same)', async () => {
    const b = bundle({ custom: true, posed: { bundle: BUNDLE, icon: 'cyber' }, call: async () => 'false\n' })
    expect(await b.keeper.keep('clair')).toBeNull()
    expect(b.logs).toEqual([`[icon] cannot take the custom icon off ${BUNDLE}: macOS refused (it answered "false")`])
    // The record stays: the next launch, still on the default icon, tries again.
    expect(b.state.posed).toEqual({ bundle: BUNDLE, icon: 'cyber' })
  })

  it('puts the icon again, and says why, when the record cannot be read; writes to the log when it cannot be written', async () => {
    const unread = bundle({ custom: true, readPosed: () => { throw new SyntaxError('Unexpected token') } })
    expect(await unread.keeper.keep('cyber')).toBeNull()
    expect(unread.calls).toHaveLength(1)
    expect(unread.logs).toEqual(['[icon] the record of the icon put on the bundle cannot be read (Unexpected token): the icon is put again'])
    const unwritten = bundle({ writePosed: () => { throw new Error('ENOSPC: no space left on device') } })
    expect(await unwritten.keeper.keep('cyber')).toBeNull()
    expect(unwritten.logs).toEqual(['[icon] the record of the icon put on the bundle cannot be written (ENOSPC: no space left on device): the next launch puts the icon again'])
  })
})

describe('the calls to the system', () => {
  it('run one at a time: a choice waits for the call under way, and a choice overtaken before its turn does nothing', async () => {
    const pending: Array<ReturnType<typeof deferred>> = []
    const b = bundle({
      call: (target, picture) => {
        b.calls.push([target, picture])
        b.state.running++
        b.state.most = Math.max(b.state.most, b.state.running)
        const call = deferred()
        pending.push(call)
        return call.promise.finally(() => {
          b.state.running--
          b.state.custom = picture !== ''
        })
      }
    })
    const first = b.keeper.keep('cyber')
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    void b.keeper.keep('solaire')
    const last = b.keeper.keep('abysse')
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(b.calls).toEqual([[BUNDLE, pictureOf('cyber')]])
    pending[0]!.end('true')
    await first
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    expect(b.calls).toEqual([[BUNDLE, pictureOf('cyber')], [BUNDLE, pictureOf('abysse')]])
    pending[1]!.end('true')
    expect(await last).toBeNull()
    expect(b.state.most).toBe(1)
    expect(b.state.posed).toEqual({ bundle: BUNDLE, icon: 'abysse' })
  })
})

describe('before an update is installed', () => {
  it('takes the custom icon off, after the call under way, and puts nothing back in this run', async () => {
    const call = deferred()
    const b = bundle({
      call: (target, picture) => {
        b.calls.push([target, picture])
        if (picture === '') {
          b.state.custom = false
          return Promise.resolve('true')
        }
        return call.promise.then((answer) => ((b.state.custom = true), answer))
      }
    })
    void b.keeper.keep('cyber')
    await vi.waitFor(() => expect(b.calls).toHaveLength(1))
    const released = b.keeper.releaseForUpdate()
    void b.keeper.keep('solaire')
    call.end('true')
    await released
    await b.keeper.keep('nebula')
    expect(b.calls).toEqual([[BUNDLE, pictureOf('cyber')], [BUNDLE, '']])
    expect(b.state).toMatchObject({ custom: false, posed: null })
    expect(b.logs).toEqual([`[icon] the custom icon was taken off ${BUNDLE} before the update is installed; the next launch puts it back`])
  })

  it('calls nothing when the bundle carries no custom icon', async () => {
    const b = bundle()
    await b.keeper.releaseForUpdate()
    expect(b.calls).toEqual([])
    expect(b.logs).toEqual([])
  })

  it('never stops the installation: a failure is written to the log', async () => {
    const b = bundle({ custom: true, checkWritable: () => { throw new Error('EACCES: permission denied') } })
    await expect(b.keeper.releaseForUpdate()).resolves.toBeUndefined()
    expect(b.logs).toEqual([`[icon] cannot take the custom icon off ${BUNDLE} before the update is installed (the installation goes on): EACCES: permission denied`])
  })
})

describe('the bundle and the script', () => {
  it('is the .app folder around the executable, and nothing else', () => {
    expect(bundleOfExecutable('/Applications/Lucium.app/Contents/MacOS/Lucium')).toBe('/Applications/Lucium.app')
    expect(bundleOfExecutable('/Volumes/Lucium 1.0.1/Lucium.app/Contents/MacOS/Lucium')).toBe('/Volumes/Lucium 1.0.1/Lucium.app')
    for (const elsewhere of ['/usr/local/bin/node', '/Applications/Lucium.app/Contents/Frameworks/x', 'Lucium.app/Contents/MacOS/Lucium', '/opt/Lucium/Contents/MacOS/Lucium', '/']) expect(bundleOfExecutable(elsewhere), elsewhere).toBeNull()
  })

  it('is a constant that names no path: the bundle and the picture come as its arguments', () => {
    expect(BUNDLE_ICON_SCRIPT).toContain('function run(argv)')
    expect(BUNDLE_ICON_SCRIPT).not.toMatch(/\/Applications|\/Users|\.app|\.png/)
  })

  it('is never given a path that osascript could read as one of its options', async () => {
    await expect(callBundleIconScript('-e', '')).rejects.toThrow('not an absolute path: "-e"')
    await expect(callBundleIconScript(BUNDLE, '-l')).rejects.toThrow('not an absolute path: "-l"')
    await expect(callBundleIconScript('Lucium.app', '')).rejects.toThrow('not an absolute path')
  })

  it('reads and writes the record of the data folder, and takes a file that is not a record for an error', () => {
    const record = join(tempDir('lucium-icon-record-'), 'bundle-icon.json')
    writeFileSync(record, '["not", "a", "record"]')
    const logs: string[] = []
    const deps = bundleIconDeps({ bundle: () => null, picture: pictureOf, record: () => record, log: (line) => void logs.push(line) })
    expect(() => deps.readPosed()).toThrow('is not a record of an icon')
    writeFileSync(record, JSON.stringify({ bundle: BUNDLE, icon: 'cyber' }))
    expect(deps.readPosed()).toEqual({ bundle: BUNDLE, icon: 'cyber' })
    deps.writePosed(null)
    expect(existsSync(record)).toBe(false)
    expect(deps.readPosed()).toBeNull()
  })

  it('writes the record for the user alone (0600), like every file of the data folder, even over one an earlier version left readable by others', () => {
    const record = join(tempDir('lucium-icon-record-'), 'bundle-icon.json')
    writeFileSync(record, '{}', { mode: 0o644 })
    chmodSync(record, 0o644)
    const deps = bundleIconDeps({ bundle: () => null, picture: pictureOf, record: () => record, log: () => undefined })
    deps.writePosed({ bundle: BUNDLE, icon: 'cyber' })
    expect(statSync(record).mode & 0o777).toBe(0o600)
    expect(deps.readPosed()).toEqual({ bundle: BUNDLE, icon: 'cyber' })
    // Written aside and moved over the file: nothing is left beside it.
    expect(existsSync(`${record}.tmp`)).toBe(false)
  })
})

// The real thing, on macOS only: a throw-away bundle signed ad hoc, the real script through osascript, the real codesign. Skipped elsewhere: there is
// no Finder, no osascript and no codesign there.
describe.runIf(process.platform === 'darwin')('on macOS, the real script on a throw-away bundle (skipped on other systems)', () => {
  const repoPicture = join(__dirname, '../../../resources/app-icons/sepia-or.png')

  /** A bundle signed ad hoc, whose resources are sealed as those of Lucium are (an executable, an Info.plist). */
  function fakeApp(): string {
    const app = join(tempDir('lucium-bundle-icon-'), 'Fake.app')
    mkdirSync(join(app, 'Contents/MacOS'), { recursive: true })
    copyFileSync('/usr/bin/true', join(app, 'Contents/MacOS/Fake'))
    writeFileSync(
      join(app, 'Contents/Info.plist'),
      '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Fake</string><key>CFBundleIdentifier</key><string>test.lucium.fake</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>\n'
    )
    execFileSync('/usr/bin/codesign', ['--sign', '-', '--force', app], { stdio: 'pipe' })
    return app
  }
  const strict = (app: string) => spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { encoding: 'utf8' })
  const finderInfo = (app: string) => spawnSync('/usr/bin/xattr', ['-p', 'com.apple.FinderInfo', app], { encoding: 'utf8' })

  it('puts the picture on the bundle (Icon\\r and the Finder flag of its root), which fails the strict check, then takes it off and the check passes again', { timeout: 30_000 }, async () => {
    const app = fakeApp()
    expect(strict(app).status).toBe(0)
    expect((await callBundleIconScript(app, repoPicture)).trim()).toBe('true')
    expect(existsSync(join(app, BUNDLE_ICON_FILE))).toBe(true)
    expect(finderInfo(app).status).toBe(0)
    const refused = strict(app)
    expect(refused.status).not.toBe(0)
    expect(refused.stderr).toContain('detritus not allowed')

    expect((await callBundleIconScript(app, '')).trim()).toBe('true')
    expect(existsSync(join(app, BUNDLE_ICON_FILE))).toBe(false)
    expect(finderInfo(app).stderr).toContain('No such xattr')
    expect(strict(app).status).toBe(0)
  })

  it('refuses a picture it cannot read, and leaves the bundle as it is', { timeout: 30_000 }, async () => {
    const app = fakeApp()
    await expect(callBundleIconScript(app, join(app, 'missing.png'))).rejects.toThrow('the picture cannot be read')
    expect(existsSync(join(app, BUNDLE_ICON_FILE))).toBe(false)
  })

  it('keeps the chosen icon through the real files, and says when the bundle cannot be written', { timeout: 30_000 }, async () => {
    const app = fakeApp()
    const record = join(tempDir('lucium-bundle-record-'), 'bundle-icon.json')
    const logs: string[] = []
    const keeper = new BundleIcon(bundleIconDeps({ bundle: () => app, picture: () => repoPicture, record: () => record, log: (line) => void logs.push(line) }))
    expect(await keeper.keep('sepia-or')).toBeNull()
    expect(existsSync(join(app, BUNDLE_ICON_FILE))).toBe(true)
    expect(JSON.parse(readFileSync(record, 'utf8'))).toEqual({ bundle: app, icon: 'sepia-or' })
    expect(await keeper.keep('clair')).toBeNull()
    expect(existsSync(join(app, BUNDLE_ICON_FILE))).toBe(false)
    expect(existsSync(record)).toBe(false)
    expect(strict(app).status).toBe(0)
    expect(logs).toEqual([])

    // A bundle the user cannot write (as one an administrator installed): nothing is called, the issue and the log say so.
    chmodSync(app, 0o555)
    expect(await keeper.keep('cyber')).toEqual({ reason: 'bundle-not-writable' })
    expect(existsSync(join(app, BUNDLE_ICON_FILE))).toBe(false)
    expect(logs).toEqual([expect.stringMatching(/cannot put the icon "cyber" on .*Fake\.app: EACCES/)])
  })
})
