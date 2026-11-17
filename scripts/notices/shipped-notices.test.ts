import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { tempDir } from '../../src/main/temp-dir'
import { onWindows } from '../../src/main/windows.test-support'

// The licence texts a built application must carry, checked on folders made for the test: no build is run, nothing is downloaded. What the real
// build proves, and this cannot: that the castLabs archive of the pinned Electron has the two files (the archives of 44.9.3 and 45.0.0-alpha.14 do).
const require = createRequire(import.meta.url)
const notices = require('./shipped-notices.cjs') as {
  ELECTRON_NOTICES: { source: string; shipped: string; minBytes: number }[]
  PROJECT_NOTICES: { shipped: string; minBytes: number }[]
  engineNoticeProblems(dist: string): string[]
  noticesDirs(appOutDir: string, platform: string, productFilename: string): { engine: string; project: string }
  putElectronNotices(dist: string, dir: string): string[]
  shippedNoticeProblems(dirs: { engine: string; project: string }): string[]
}
const afterPack = (require('../after-pack.cjs') as { default(context: unknown): Promise<void> }).default
const read = (relative: string): string => readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8')

/** An Electron distribution as its archive unzips: Electron.app, and the two notices beside it. */
function engine(files: Record<string, number> = { LICENSE: 1096, 'LICENSES.chromium.html': 1_200_000 }): string {
  const dist = tempDir('lucium-notices-engine-')
  mkdirSync(join(dist, 'Electron.app', 'Contents', 'Resources'), { recursive: true })
  for (const [name, size] of Object.entries(files)) writeFileSync(join(dist, name), 'x'.repeat(size))
  return dist
}

/** The resources of a packaged application with what electron-builder.yml copies there. */
function packaged(without: string[] = []): { appOutDir: string; resources: string } {
  const appOutDir = tempDir('lucium-notices-app-')
  const resources = join(appOutDir, 'Lucium.app', 'Contents', 'Resources')
  mkdirSync(resources, { recursive: true })
  for (const { shipped, minBytes } of notices.PROJECT_NOTICES) if (!without.includes(shipped)) writeFileSync(join(resources, shipped), 'x'.repeat(minBytes))
  return { appOutDir, resources }
}

const context = (appOutDir: string, electronDist: string | undefined, platform = 'darwin') => ({
  appOutDir,
  electronPlatformName: platform,
  packager: { appInfo: { productFilename: 'Lucium' }, projectDir: appOutDir, config: { electronDist } }
})

describe('the notices of the engine', () => {
  it('are the licence of Electron and the notices of Chromium, under the names a build of Electron gives them', () => {
    expect(notices.ELECTRON_NOTICES.map(({ source, shipped }) => [source, shipped])).toEqual([
      ['LICENSE', 'LICENSE.electron.txt'],
      ['LICENSES.chromium.html', 'LICENSES.chromium.html']
    ])
  })

  it('are in the resources of the bundle on macOS; elsewhere beside the executable, the texts of the project in `resources`', () => {
    const resources = join('/out/mac-arm64', 'Lucium DRM.app', 'Contents', 'Resources')
    expect(notices.noticesDirs('/out/mac-arm64', 'darwin', 'Lucium DRM')).toEqual({ engine: resources, project: resources })
    expect(notices.noticesDirs('/out/linux-unpacked', 'linux', 'Lucium')).toEqual({ engine: '/out/linux-unpacked', project: join('/out/linux-unpacked', 'resources') })
  })

  it('are copied from an unzipped engine, which electron-builder copies without them', () => {
    const dist = engine()
    const { resources } = packaged()
    expect(notices.putElectronNotices(dist, resources)).toEqual(['LICENSE.electron.txt', 'LICENSES.chromium.html'])
    expect(readFileSync(join(resources, 'LICENSE.electron.txt'), 'utf8')).toHaveLength(1096)
    expect(notices.shippedNoticeProblems({ engine: resources, project: resources })).toEqual([])
  })

  it('are left as they are when the build already has them', () => {
    const { resources } = packaged()
    writeFileSync(join(resources, 'LICENSE.electron.txt'), 'e'.repeat(1096))
    writeFileSync(join(resources, 'LICENSES.chromium.html'), 'c'.repeat(1_200_000))
    expect(notices.putElectronNotices(engine(), resources)).toEqual([])
    expect(readFileSync(join(resources, 'LICENSE.electron.txt'), 'utf8').startsWith('e')).toBe(true)
  })

  it('stop the build when the engine folder lost one, or holds an empty file in its place', () => {
    expect(() => notices.putElectronNotices(engine({ LICENSE: 1096 }), packaged().resources)).toThrow(/no usable LICENSES\.chromium\.html \(missing\)/)
    expect(() => notices.putElectronNotices(engine({ LICENSE: 0, 'LICENSES.chromium.html': 1_200_000 }), packaged().resources)).toThrow(/no usable LICENSE \(0 bytes/)
  })

  it('are looked for in an engine folder before a build is started on it', () => {
    expect(notices.engineNoticeProblems(engine())).toEqual([])
    expect(notices.engineNoticeProblems(engine({}))).toEqual(['LICENSE: missing', 'LICENSES.chromium.html: missing'])
    expect(notices.engineNoticeProblems(engine({ LICENSE: 1096, 'LICENSES.chromium.html': 12 }))).toEqual([
      'LICENSES.chromium.html: 12 bytes, less than the 1000000 the real text has'
    ])
  })
})

describe('the licence texts of a built application', () => {
  it('are six: the licence of Lucium, its notice, the additional permission, the notices of the npm packages, the licence of Electron, the notices of Chromium', () => {
    expect(notices.PROJECT_NOTICES.map(({ shipped }) => shipped)).toEqual(['LICENSE', 'NOTICE', 'ADDITIONAL-PERMISSION.txt', 'THIRD-PARTY-NOTICES.txt'])
    const { resources } = packaged()
    expect(notices.shippedNoticeProblems({ engine: resources, project: resources })).toEqual(['LICENSE.electron.txt: missing', 'LICENSES.chromium.html: missing'])
    notices.putElectronNotices(engine(), resources)
    expect(notices.shippedNoticeProblems({ engine: resources, project: resources })).toEqual([])
    const bare = packaged(['NOTICE', 'THIRD-PARTY-NOTICES.txt']).resources
    expect(notices.shippedNoticeProblems({ engine: bare, project: bare })).toEqual([
      'LICENSE.electron.txt: missing',
      'LICENSES.chromium.html: missing',
      'NOTICE: missing',
      'THIRD-PARTY-NOTICES.txt: missing'
    ])
    // The additional permission is a file of its own in the application: a copy without it, or with a line in its place, is not handed out.
    const noPermission = packaged(['ADDITIONAL-PERMISSION.txt']).resources
    notices.putElectronNotices(engine(), noPermission)
    expect(notices.shippedNoticeProblems({ engine: noPermission, project: noPermission })).toEqual(['ADDITIONAL-PERMISSION.txt: missing'])
    writeFileSync(join(noPermission, 'ADDITIONAL-PERMISSION.txt'), 'see NOTICE')
    expect(notices.shippedNoticeProblems({ engine: noPermission, project: noPermission })).toEqual(['ADDITIONAL-PERMISSION.txt: 10 bytes, less than the 1500 the real text has'])
  })

  it('have, in the repository, the size the check asks of the copy in the application', () => {
    for (const { shipped, minBytes } of notices.PROJECT_NOTICES) expect(Buffer.byteLength(read(shipped)), shipped).toBeGreaterThanOrEqual(minBytes)
  })

  it('are copied into the application by electron-builder.yml, each under its own name', () => {
    const builder = read('electron-builder.yml')
    for (const { shipped } of notices.PROJECT_NOTICES) expect(builder).toMatch(new RegExp(`- from: ${shipped.replaceAll('.', '\\.')}\\n\\s+to: ${shipped.replaceAll('.', '\\.')}\\n`))
    expect(builder).toMatch(/^afterPack: scripts\/after-pack\.cjs$/m)
  })
})

describe('scripts/after-pack.cjs', () => {
  it('puts the notices of the engine handed to electron-builder (the castLabs build) in the application, and the languages', async () => {
    const dist = engine()
    const { appOutDir, resources } = packaged()
    await afterPack(context(appOutDir, dist))
    expect(existsSync(join(resources, 'LICENSE.electron.txt'))).toBe(true)
    expect(existsSync(join(resources, 'LICENSES.chromium.html'))).toBe(true)
    expect(existsSync(join(resources, 'fr.lproj'))).toBe(true)
  })

  it('takes the demonstration application of Electron out of the package, and nothing else', async () => {
    const { appOutDir, resources } = packaged()
    writeFileSync(join(resources, 'default_app.asar'), 'demo')
    writeFileSync(join(resources, 'app.asar'), 'lucium')
    await afterPack(context(appOutDir, engine()))
    expect(existsSync(join(resources, 'default_app.asar'))).toBe(false)
    expect(existsSync(join(resources, 'app.asar'))).toBe(true)
    // The other systems keep it in `resources`, beside app.asar too.
    const linux = tempDir('lucium-notices-linux-demo-')
    mkdirSync(join(linux, 'resources'))
    for (const { shipped, minBytes } of notices.PROJECT_NOTICES) writeFileSync(join(linux, 'resources', shipped), 'x'.repeat(minBytes))
    writeFileSync(join(linux, 'resources', 'default_app.asar'), 'demo')
    await afterPack(context(linux, engine(), 'linux'))
    expect(existsSync(join(linux, 'resources', 'default_app.asar'))).toBe(false)
    // A package that has none is left alone (the stock Electron: electron-builder already takes it out).
    const plain = packaged()
    await expect(afterPack(context(plain.appOutDir, engine()))).resolves.toBeUndefined()
  })

  // The Electron archive of a Linux build carries 0666 and 0777 files, and the first .deb made from it had 68 files writable by every user, the executable among them.
  // Windows: the modes of a Linux package are POSIX modes (chmod 0777, a setuid bit): Windows keeps none, and a Linux package is not made there.
  it.skipIf(onWindows)('puts the files of a Linux package back to the modes of a package: nothing writable by group or others, 0755 for folders and executables, 0644 for the rest', async () => {
    const appOutDir = tempDir('lucium-notices-linux-modes-')
    mkdirSync(join(appOutDir, 'resources', 'sub'), { recursive: true })
    for (const { shipped, minBytes } of notices.PROJECT_NOTICES) writeFileSync(join(appOutDir, 'resources', shipped), 'x'.repeat(minBytes))
    const files: Record<string, number> = { lucium: 0o777, 'chrome-sandbox': 0o4777, 'libffmpeg.so': 0o666, 'icudtl.dat': 0o666, 'resources/app.asar': 0o666, 'resources/sub/data.bin': 0o640, 'resources/sub/run.sh': 0o700 }
    for (const [name, mode] of Object.entries(files)) {
      writeFileSync(join(appOutDir, name), 'x')
      chmodSync(join(appOutDir, name), mode)
    }
    chmodSync(join(appOutDir, 'resources', 'sub'), 0o777)
    symlinkSync('lucium', join(appOutDir, 'launcher'))
    await afterPack(context(appOutDir, engine(), 'linux'))
    const mode = (name: string): number => statSync(join(appOutDir, name)).mode & 0o7777
    expect(mode('lucium')).toBe(0o755)
    expect(mode('chrome-sandbox'), 'no setuid bit: the post-install script of the .deb sets it where it is needed').toBe(0o755)
    expect(mode('resources/sub/run.sh')).toBe(0o755)
    for (const name of ['libffmpeg.so', 'icudtl.dat', 'resources/app.asar', 'resources/sub/data.bin', 'resources/LICENSE']) expect(mode(name), name).toBe(0o644)
    for (const name of ['.', 'resources', 'resources/sub']) expect(mode(name), name).toBe(0o755)
    // The link is left alone: it still points at `lucium`.
    expect(lstatSync(join(appOutDir, 'launcher')).isSymbolicLink()).toBe(true)
    // Nothing in the tree is writable by group or others any more.
    const writable: string[] = []
    const walk = (folder: string): void => {
      for (const name of readdirSync(folder)) {
        const path = join(folder, name)
        if (lstatSync(path).isSymbolicLink()) continue
        if (statSync(path).mode & 0o022) writable.push(path)
        if (statSync(path).isDirectory()) walk(path)
      }
    }
    walk(appOutDir)
    expect(writable).toEqual([])
  })

  it('does not touch the modes of the other systems: a macOS bundle is signed after this, and its modes are the ones the signature seals', async () => {
    const { appOutDir, resources } = packaged()
    writeFileSync(join(resources, 'asset.bin'), 'x')
    chmodSync(join(resources, 'asset.bin'), 0o666)
    await afterPack(context(appOutDir, engine()))
    expect(statSync(join(resources, 'asset.bin')).mode & 0o7777).toBe(0o666)
  })

  it('never takes the notices of the stock Electron for a custom engine that has none: the build stops', async () => {
    const { appOutDir } = packaged()
    await expect(afterPack(context(appOutDir, engine({})))).rejects.toThrow(/no usable LICENSE \(missing\)/)
  })

  it('stops a build whose resources lack a text electron-builder.yml should have copied', async () => {
    const { appOutDir } = packaged(['THIRD-PARTY-NOTICES.txt'])
    await expect(afterPack(context(appOutDir, engine()))).rejects.toThrow(/lacks licence texts it must carry.*THIRD-PARTY-NOTICES\.txt: missing/)
  })

  it('checks the builds of the other systems too: the notices of the engine beside the executable, the texts of the project in `resources`', async () => {
    const appOutDir = tempDir('lucium-notices-linux-')
    mkdirSync(join(appOutDir, 'resources'))
    for (const { shipped, minBytes } of notices.PROJECT_NOTICES) writeFileSync(join(appOutDir, 'resources', shipped), 'x'.repeat(minBytes))
    await afterPack(context(appOutDir, engine(), 'linux'))
    expect(existsSync(join(appOutDir, 'LICENSE.electron.txt'))).toBe(true)
    expect(existsSync(join(appOutDir, 'LICENSES.chromium.html'))).toBe(true)
    expect(notices.shippedNoticeProblems(notices.noticesDirs(appOutDir, 'linux', 'Lucium'))).toEqual([])
    expect(existsSync(join(appOutDir, 'fr.lproj'))).toBe(false)
    // The texts of the project left beside the executable are not where electron-builder.yml puts them: refused.
    const misplaced = tempDir('lucium-notices-linux-')
    for (const { shipped, minBytes } of notices.PROJECT_NOTICES) writeFileSync(join(misplaced, shipped), 'x'.repeat(minBytes))
    await expect(afterPack(context(misplaced, engine(), 'linux'))).rejects.toThrow(/NOTICE: missing/)
  })
})

describe('scripts/package-drm.mjs', () => {
  const script = read('scripts/package-drm.mjs')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')

  it('refuses an engine folder without the notices before the build, and reads the texts of the application before any signature', () => {
    const engineCheck = script.indexOf('const engineNotices = engineNoticeProblems(ecsDist)')
    const build = script.indexOf("run('node_modules/.bin/electron-builder'")
    const shippedCheck = script.indexOf("const shippedNotices = shippedNoticeProblems({ engine: join(app, 'Contents', 'Resources'), project: join(app, 'Contents', 'Resources') })")
    const firstSignature = script.indexOf("'sign-pkg'")
    expect(engineCheck).toBeGreaterThan(-1)
    expect(script).toMatch(/if \(engineNotices\.length > 0\) fail\(/)
    expect(build).toBeGreaterThan(engineCheck)
    expect(shippedCheck).toBeGreaterThan(build)
    // After the move of `mac` to `mac-arm64`: the folder read is the one that is signed.
    expect(shippedCheck).toBeGreaterThan(script.indexOf('renameSync(packaged, shipped)'))
    expect(script).toMatch(/if \(shippedNotices\.length > 0\) fail\(/)
    expect(firstSignature).toBeGreaterThan(shippedCheck)
  })
})
