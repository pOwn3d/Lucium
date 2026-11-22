import { describe, expect, it } from 'vitest'
import type { ExtensionInfo } from './ipc'
import { managementGetAll } from './extension-management'

const info = (over: Partial<ExtensionInfo>): ExtensionInfo => ({ id: 'a'.repeat(32), name: 'Alpha', version: '1.0', profileId: 'default', source: 'store', enabled: true, ...over })

describe('managementGetAll', () => {
  it('lists the extensions of the profile of the caller and of no other', () => {
    const list = [info({ id: 'a'.repeat(32) }), info({ id: 'b'.repeat(32), name: 'Beta', profileId: 'work' })]
    expect(managementGetAll(list, 'default').map((item) => item.id)).toEqual(['a'.repeat(32)])
    expect(managementGetAll(list, 'work').map((item) => item.name)).toEqual(['Beta'])
  })

  it('gives sober fields only: no permission, no folder, no path', () => {
    const [item] = managementGetAll([info({ sidePanelPath: 'panel.html', omniboxKeyword: 'x', grantedCount: 2, update: { version: '2.0' } })], 'default')
    expect(Object.keys(item as object).sort()).toEqual(['enabled', 'id', 'installType', 'isApp', 'mayDisable', 'name', 'offlineEnabled', 'shortName', 'type', 'version'])
  })

  it('tells a folder from the store, and a switched-off extension', () => {
    const [store, folder] = managementGetAll([info({ source: 'store' }), info({ id: 'c'.repeat(32), source: 'unpacked', enabled: false })], 'default')
    expect(store).toMatchObject({ installType: 'normal', enabled: true, type: 'extension', isApp: false, mayDisable: false })
    expect(folder).toMatchObject({ installType: 'development', enabled: false })
  })
})
