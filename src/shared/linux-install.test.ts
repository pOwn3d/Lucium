// What a Lucium of Linux is installed as, and what follows (shared/linux-install.ts). Paths are POSIX strings and nothing reads the machine, so the same checks run on
// macOS, Windows and Linux.
import { describe, expect, it } from 'vitest'
import { appImageFiles, debFileName, debInstallCommand, linuxFeedAddress, linuxInstallOf } from './linux-install'

const DEV = '/home/ana/src/lucium/node_modules/electron/dist/electron'

describe('linuxInstallOf: an AppImage is told by APPIMAGE, a .deb by where it runs from', () => {
  it('is an AppImage when APPIMAGE names a plain absolute path, and carries that file', () => {
    expect(linuxInstallOf({ APPIMAGE: '/home/ana/Applications/Lucium-1.2.0-linux-x64.AppImage' }, '/tmp/.mount_Lucium1x2/lucium')).toEqual({ packaging: 'appimage', file: '/home/ana/Applications/Lucium-1.2.0-linux-x64.AppImage' })
    // The mount of an AppImage is not a package root, and the variable wins over where the executable is.
    expect(linuxInstallOf({ APPIMAGE: '/opt/tools/Lucium.AppImage' }, '/usr/bin/lucium')).toEqual({ packaging: 'appimage', file: '/opt/tools/Lucium.AppImage' })
  })

  it('does not believe an APPIMAGE that is not a plain absolute path: a copy that cannot say which file it is replaces none', () => {
    for (const bad of ['Lucium.AppImage', './Lucium.AppImage', '/home/ana/../root/Lucium.AppImage', '/home/ana//Lucium.AppImage', '/home/ana/./Lucium.AppImage', '/home/ana/Apps/', '/', '/home/ana/a\nb.AppImage', '/home/ana/a\0b', '/home/ana/..']) {
      expect(linuxInstallOf({ APPIMAGE: bad }, DEV), JSON.stringify(bad)).toEqual({ packaging: null })
      // And it does not fall back on being a .deb: a copy that claims to be an AppImage and is not believed is none.
      expect(linuxInstallOf({ APPIMAGE: bad }, '/opt/Lucium/lucium'), JSON.stringify(bad)).toEqual({ packaging: null })
    }
  })

  it('is a .deb when there is no APPIMAGE and the executable is under /opt or /usr', () => {
    expect(linuxInstallOf({}, '/opt/Lucium/lucium')).toEqual({ packaging: 'deb' })
    expect(linuxInstallOf({ APPIMAGE: undefined }, '/usr/lib/lucium/lucium')).toEqual({ packaging: 'deb' })
    expect(linuxInstallOf({ APPIMAGE: '' }, '/opt/Lucium/lucium')).toEqual({ packaging: 'deb' })
  })

  it('is neither for a run from the sources, an unpacked build, or a path that only looks like /opt or /usr', () => {
    for (const execPath of [DEV, '/home/ana/dist/linux-unpacked/lucium', '/optional/Lucium/lucium', '/usrlocal/lucium', '/opt', '/opt/../home/ana/lucium', '/opt//Lucium/lucium', 'opt/Lucium/lucium', '']) {
      expect(linuxInstallOf({}, execPath), JSON.stringify(execPath)).toEqual({ packaging: null })
    }
  })
})

describe('linuxFeedAddress: one build, two folders', () => {
  const BUILT = 'https://lucium.app/updates/linux-x64/feed.json'

  it('puts the feed of each packaging in a folder of its own, on both channels and both architectures', () => {
    expect(linuxFeedAddress(BUILT, 'appimage')).toBe('https://lucium.app/updates/linux-x64/appimage/feed.json')
    expect(linuxFeedAddress(BUILT, 'deb')).toBe('https://lucium.app/updates/linux-x64/deb/feed.json')
    expect(linuxFeedAddress('https://test.lucium.app/updates/linux-arm64/feed.json', 'deb')).toBe('https://test.lucium.app/updates/linux-arm64/deb/feed.json')
    expect(linuxFeedAddress(BUILT, 'appimage')).not.toBe(linuxFeedAddress(BUILT, 'deb'))
  })

  it('gives no address to a copy that is neither, and none from an address that is not the system’s feed', () => {
    expect(linuxFeedAddress(BUILT, null)).toBe('')
    for (const bad of ['', 'http://lucium.app/updates/linux-x64/feed.json', 'https://lucium.app/updates/linux-x64/', 'https://lucium.app/updates/linux-x64/other.json', 'https://bad host/feed.json']) {
      expect(linuxFeedAddress(bad, 'appimage'), bad).toBe('')
    }
  })
})

describe('the .deb a person is told about', () => {
  it('is named by Lucium from the signed version and the architecture of this copy, as apt names them', () => {
    expect(debFileName('1.2.0', 'x64')).toBe('Lucium-1.2.0-linux-amd64.deb')
    expect(debFileName('1.2.0', 'arm64')).toBe('Lucium-1.2.0-linux-arm64.deb')
  })

  it('gets no name from a version that is not digits and dots, nor from an architecture no .deb is built for', () => {
    for (const version of ['', 'v1.2.0', '1.2.0-beta', '1.2.0/../x', '1.2.0; rm', '../1.2.0', '1.2.0.4.5']) expect(debFileName(version, 'x64'), version).toBeNull()
    for (const arch of ['ia32', 'arm', '', 'constructor', '__proto__']) expect(debFileName('1.2.0', arch), arch).toBeNull()
  })

  it('is installed with one command, run by the person from the folder that holds the file', () => {
    expect(debInstallCommand('Lucium-1.2.0-linux-amd64.deb')).toBe('sudo apt install ./Lucium-1.2.0-linux-amd64.deb')
  })
})

describe('appImageFiles: what an update leaves beside the AppImage', () => {
  it('names the download, its unfinished form and the copy it replaced from the AppImage’s own name, in its own folder', () => {
    expect(appImageFiles('/home/ana/Apps/Lucium.AppImage')).toEqual({
      part: '/home/ana/Apps/Lucium.AppImage.update.part',
      staged: '/home/ana/Apps/Lucium.AppImage.update',
      previous: '/home/ana/Apps/Lucium.AppImage.previous'
    })
  })
})
