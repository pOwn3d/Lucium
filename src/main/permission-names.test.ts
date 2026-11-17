// Every permission the engine can hand to the handlers of a session (`setPermissionRequestHandler`, `setPermissionCheckHandler`) has a fate
// that was chosen: a device (the hardware service), granted or refused without a question, or asked in words of the catalogue, with a name for
// the site panel when the answer may be kept. The list is read from the typings of the installed Electron: a name a new version adds fails
// here until someone decides, where it used to become the question « exemple.com souhaite utiliser « screen-wake-lock » ».
// Here because it reads a file (the shared tests also build for the renderer, which has no `node:fs`).

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { en } from '@shared/i18n-en'
import { fr } from '@shared/i18n-fr'
import { t } from '@shared/i18n'
import { ALWAYS_REFUSED_PERMISSIONS, GRANTED_PERMISSIONS, REFUSED_PERMISSIONS, mayRemember, permissionName, permissionPhrase, routePermission } from '@shared/permissions'
import { HARDWARE_PERMISSIONS } from '@shared/web-hardware'

const SITE = 'https://site.example'

/** The names of the `permission` argument of a handler, as the typings of Electron list them. */
function namesOf(typings: string, handler: string): string[] {
  const at = typings.indexOf(`    ${handler}(handler: `)
  const union = /permission: ((?:'[^']+'(?: \| )?)+)/.exec(typings.slice(at, typings.indexOf('\n', at)))
  return union ? [...union[1]!.matchAll(/'([^']+)'/g)].map((name) => name[1]!) : []
}

const typings = readFileSync(join(dirname(createRequire(import.meta.url).resolve('electron/package.json')), 'electron.d.ts'), 'utf8')
const names = [...new Set([...namesOf(typings, 'setPermissionRequestHandler'), ...namesOf(typings, 'setPermissionCheckHandler')])]

describe('the permissions the engine can ask about', () => {
  it('are read from the typings of the installed Electron', () => {
    expect(names.length).toBeGreaterThanOrEqual(40)
    for (const known of ['media', 'screen-wake-lock', 'storage-access', 'fileSystem', 'openExternal', 'unknown']) expect(names, known).toContain(known)
  })

  it('each have one fate: a device, granted, refused, or a question in words', () => {
    const jargon: string[] = []
    for (const name of names) {
      const route = routePermission(name, `${SITE}/page`)
      if (HARDWARE_PERMISSIONS.has(name)) expect(route, name).toEqual({ kind: 'hardware' })
      else if (ALWAYS_REFUSED_PERMISSIONS.has(name)) expect(route, name).toEqual({ kind: 'deny' })
      else if (GRANTED_PERMISSIONS.has(name)) expect(route, name).toEqual({ kind: 'grant' })
      else if (REFUSED_PERMISSIONS.has(name)) expect(route, name).toEqual({ kind: 'deny', notOffered: true })
      else {
        expect(route, name).toEqual({ kind: 'policy', origin: SITE })
        if (permissionPhrase(name) === t('permissions.utiliser-permission', { permission: name })) jargon.push(name)
      }
    }
    expect(jargon, `asked by the name the engine gives them: ${jargon.join(', ')}`).toEqual([])
  })

  it('have a name for the site panel when their answer may be kept', () => {
    const asked = names.filter((name) => routePermission(name, `${SITE}/page`).kind === 'policy' && mayRemember(SITE, name))
    expect(asked).toContain('storage-access')
    expect(asked.filter((name) => permissionName(name) === name)).toEqual([])
  })

  it('are not refused or granted under a name the engine does not have (a name mistyped decides nothing)', () => {
    expect([...GRANTED_PERMISSIONS, ...REFUSED_PERMISSIONS, ...ALWAYS_REFUSED_PERMISSIONS].filter((name) => !names.includes(name))).toEqual([])
  })

  it('are asked in words of their own in English too', () => {
    const keys = Object.keys(fr).filter((key) => key.startsWith('permissions.')) as Array<keyof typeof fr>
    // A text left in French in the English catalogue reads the same in both; « Notifications » is the one word that does.
    const same = keys.filter((key) => en[key] === fr[key] && !['permissions.notifications'].includes(key))
    expect(same).toEqual([])
  })
})
