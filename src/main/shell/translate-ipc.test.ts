// The controller of the translation of a window is made by the first thing that asks for it (a menu, the panel, a page that loads in a language always translated),
// and the engine test says where its folders are (`translateEnvironment`) well after that, in a run of many suites. The folders are therefore read when a
// request needs them, not when the controller is made: the run of 10 November 2026 read the real ones for the whole chain, and the pack the test placed
// in its own folder was never found.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '@shared/model'
import type { TranslateView } from '@shared/translate-local'

vi.mock('electron', () => ({
  app: { getPath: () => '/real/user-data', getLocale: () => 'fr', getAppPath: () => '/app' },
  BrowserWindow: class {},
  dialog: {},
  net: { fetch: () => Promise.reject(new Error('the network is not part of this test')) },
  shell: { openExternal: () => Promise.resolve() }
}))

const { registerTranslateIpc, translateEnvironment } = await import('./translate-ipc')
type Access = Parameters<InstanceType<typeof import('./browser').Browser>['useTranslator']>[0]

const original = { ...translateEnvironment }
const folders: string[] = []
const folder = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'lucium-translate-ipc-'))
  folders.push(dir)
  return dir
}

afterEach(() => {
  Object.assign(translateEnvironment, original)
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** The window's side of the registration: what it hands the browser to reach its translation. */
function registered(): Access {
  let access: Access | undefined
  const browser = {
    isPrivate: () => false,
    translatePage: () => null,
    translatePageOf: () => null,
    showTabTranslation: () => undefined,
    translationNotice: () => undefined,
    dispatch: () => undefined,
    useTranslator: (given: Access) => void (access = given)
  }
  const store = { get: () => ({ settings: { ...defaultSettings(), translateLocal: true } }) }
  registerTranslateIpc({ handle: () => undefined } as never, () => true, browser as never, store as never, {} as never)
  return access!
}

describe('the folders of the translation', () => {
  it('are those the engine test names, though the controller was made before it did', async () => {
    const access = registered()
    // Made first, as a menu does, with no folder given: the real ones (userData/translation-models and translation-engine).
    const controller = access.get()!
    const before = await controller.handle({ action: 'refresh' })
    expect((before as TranslateView).folder.path).toBe(join('/real/user-data', 'translation-models'))

    const models = folder()
    const engine = folder()
    translateEnvironment.defaultDir = () => models
    translateEnvironment.engineDir = () => engine
    const after = (await controller.handle({ action: 'refresh' })) as TranslateView
    expect(after.folder).toEqual({ path: models, isDefault: true })
    // The folder of the engine's binary: the controller's own dependency, read at the moment of a request too.
    expect((controller as unknown as { deps: { engineDir: string } }).deps.engineDir).toBe(engine)
  })

  it('are the real ones while nothing names others', () => {
    const controller = registered().get()!
    const deps = (controller as unknown as { deps: { defaultDir: string; engineDir: string } }).deps
    expect([deps.defaultDir, deps.engineDir]).toEqual([join('/real/user-data', 'translation-models'), join('/real/user-data', 'translation-engine')])
  })
})
