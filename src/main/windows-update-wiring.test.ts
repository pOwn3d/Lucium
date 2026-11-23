// How main() wires the update of Windows (index.ts), read from its text as the other wiring tests do (launch-wiring.test.ts): the system picks the installer, the look
// and the preparation before a quit see only an installer that installs at a quit, and an installer that was downloaded and not run goes when the application ends.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const index = readFileSync(join(__dirname, 'index.ts'), 'utf8')

describe('main(): the installer of the system', () => {
  it('makes the one of Windows on Windows, the AppImage’s on an AppImage (a .deb or another Linux copy installs nothing) and Squirrel’s elsewhere', () => {
    expect(index).toMatch(/process\.platform === 'win32'\s*\?\s*createWindowsUpdateInstaller\(installFeed,[^)]*\)[\s\S]{0,200}:\s*process\.platform === 'linux'\s*\?\s*linuxInstall\.packaging === 'appimage'\s*\?\s*createAppImageUpdateInstaller\(linuxInstall\.file, installFeed,[^)]*\)[\s\S]{0,100}:\s*null\s*:\s*createUpdateInstaller\(installFeed,/)
  })

  it('tells a .deb the command and only on a .deb, and takes away the copy an update kept once the new AppImage runs', () => {
    expect(index).toMatch(/setDebAdviser\(process\.platform === 'linux' && linuxInstall\.packaging === 'deb' \? createDebAdviser\(sendsGpc\) : null\)/)
    expect(index).toMatch(/if \(linuxInstall\.packaging === 'appimage'\) void removePreviousAppImage\(linuxInstall\.file,/)
  })

  it('gives the look before a quit and the preparation before a quit only the installer that installs at a quit', () => {
    expect(index).toMatch(/installUpdateQuitCheck\(\{\s*app,\s*installer: installerAtQuit,/)
    expect(index).toMatch(/installPrepareBeforeQuit\(\{\s*app,\s*installer: installerAtQuit,/)
  })

  it('removes an installer that was downloaded and not run when the application ends, before the quit flow installs its last write', () => {
    const leave = index.indexOf("app.on('will-quit', () => updateInstaller()?.leave())")
    expect(leave).toBeGreaterThan(-1)
    expect(leave).toBeLessThan(index.indexOf('installQuitFlow({'))
  })
})
