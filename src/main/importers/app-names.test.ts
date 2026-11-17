import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { APP_NAME_MAX, MAX_INFO_PLIST_BYTES, installedAppNames } from './app-names'
import { fakeApplications, infoPlist } from './app-bundles.test-support'

const root = mkdtempSync(join(tmpdir(), 'lucium-app-names-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

let folders = 0
/** A new folder of applications holding these bundles. */
const folderWith = (...bundles: Parameters<typeof fakeApplications>[1]): string => fakeApplications(join(root, `apps-${++folders}`), bundles)
const wanted = (...ids: string[]): Set<string> => new Set(ids)

describe('installedAppNames', () => {
  it('reads the name an application gives itself: the display name in full, the bundle name in short', () => {
    const apps = folderWith({ id: 'test.full', display: 'Navigo Browser', name: 'Navigo' }, { id: 'test.short', name: 'Rapido' })
    const names = installedAppNames([apps], wanted('test.full', 'test.short'))
    expect(names.get('test.full')).toEqual({ display: 'Navigo Browser', short: 'Navigo' })
    // Without a display name, the bundle name is both.
    expect(names.get('test.short')).toEqual({ display: 'Rapido', short: 'Rapido' })
  })

  it('finds the application by its identifier, whatever its folder is called, and reads only the ones asked for', () => {
    const apps = folderWith({ id: 'test.renamed', name: 'Navigo', file: 'Mon navigateur' }, { id: 'test.other', name: 'Autre' })
    const names = installedAppNames([apps], wanted('test.renamed'))
    expect([...names.keys()]).toEqual(['test.renamed'])
    expect(names.get('test.renamed')?.display).toBe('Navigo')
    expect(installedAppNames([apps], wanted()).size).toBe(0)
  })

  it('follows a bundle that is a link, as the system browser is in /Applications', () => {
    const real = folderWith({ id: 'test.linked', name: 'Lié' })
    const apps = join(root, 'apps-linked')
    mkdirSync(apps)
    symlinkSync(join(real, 'Lié.app'), join(apps, 'Lié.app'))
    expect(installedAppNames([apps], wanted('test.linked')).get('test.linked')?.display).toBe('Lié')
  })

  it('keeps the first folder when the same application is in two, and skips a folder that does not exist', () => {
    const first = folderWith({ id: 'test.twice', name: 'Premier' })
    const second = folderWith({ id: 'test.twice', name: 'Second' })
    expect(installedAppNames([join(root, 'nowhere'), first, second], wanted('test.twice')).get('test.twice')?.display).toBe('Premier')
  })

  it('gives no name for a bundle it cannot read: binary, damaged, too big, nameless, or not a file', () => {
    const apps = join(root, 'apps-bad')
    const put = (file: string, content: string | Buffer) => {
      mkdirSync(join(apps, `${file}.app`, 'Contents'), { recursive: true })
      writeFileSync(join(apps, `${file}.app`, 'Contents', 'Info.plist'), content)
    }
    put('Binaire', Buffer.concat([Buffer.from('bplist00'), Buffer.from('test.binary')]))
    put('Abime', '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>test.damaged</string><key>CFBundleName</key><string>Abîmé')
    put('Enorme', infoPlist({ id: 'test.huge', name: 'Énorme' }).replace('</dict>', `<key>Pad</key><string>${'x'.repeat(MAX_INFO_PLIST_BYTES)}</string></dict>`))
    put('Anonyme', infoPlist({ id: 'test.nameless' }))
    mkdirSync(join(apps, 'Dossier.app', 'Contents', 'Info.plist'), { recursive: true })
    const names = installedAppNames([apps], wanted('test.binary', 'test.damaged', 'test.huge', 'test.nameless'))
    expect([...names.keys()]).toEqual([])
    // The control: the same bundle within the bound is read, so the bound is what refused the one above.
    put('Enorme', infoPlist({ id: 'test.huge', name: 'Énorme' }))
    expect(installedAppNames([apps], wanted('test.huge')).get('test.huge')?.display).toBe('Énorme')
  })

  it('keeps a name on one line and of a bounded length: it comes from a file another program wrote', () => {
    const apps = folderWith({ id: 'test.odd', name: `Nom\nsur deux lignes ${'y'.repeat(APP_NAME_MAX * 2)}` })
    const name = installedAppNames([apps], wanted('test.odd')).get('test.odd')!.display
    expect(name).not.toContain('\n')
    expect(name.length).toBeLessThanOrEqual(APP_NAME_MAX)
    expect(name.startsWith('Nom sur deux lignes')).toBe(true)
  })
})
