import { describe, expect, it, vi } from 'vitest'
import type { ExtensionInfo } from '@shared/ipc'
import type { ExtensionDetail } from '@shared/extension-page'
import { createInitialState, reduce } from '@shared/sidebar'
import { ExtensionDevError } from '../engine/extension-dev'
import { ExtensionsService, type ExtensionsServiceEnv } from './extensions-service'
import { frenchSpaces } from '@shared/french-typography'

// extension-dev.ts reads Electron at load: only its error class is used here.
vi.mock('electron', () => ({ app: {}, nativeImage: {}, webContents: {} }))

const A = 'a'.repeat(32)
const B = 'b'.repeat(32)
const GOOD = JSON.stringify({ manifest_version: 3, name: 'Folder ext', version: '1.0', background: { service_worker: 'sw.js' }, options_page: 'o.html' })
/** A Manifest V2 folder, as Settings › Extensions loads one (compat/mv2-blocking-probe is the same shape). */
const LEGACY = JSON.stringify({ manifest_version: 2, name: 'Old ext', version: '1.0', background: { scripts: ['bg.js'] }, browser_action: { default_popup: 'popup.html' }, permissions: ['webRequest', 'webRequestBlocking', '<all_urls>'] })
const LEGACY_NOTE = 'Cette extension est au format Manifest V2, un format ancien : Lucium la charge, mais certaines de ses fonctions peuvent manquer ou ne pas marcher comme prévu.'

const unpacked = (over: Partial<ExtensionInfo> = {}): ExtensionInfo => ({ id: A, name: 'Dev', version: '1.0', profileId: 'default', source: 'unpacked', enabled: true, ...over })
const store = (over: Partial<ExtensionInfo> = {}): ExtensionInfo => ({ id: B, name: 'Vimium', version: '1.0', profileId: 'default', source: 'store', enabled: true, ...over })

function setup(options: { infos?: ExtensionInfo[]; manifest?: string | null; files?: string[]; confirm?: boolean; folder?: string | null; loadFailure?: string | null; isPrivate?: boolean; pack?: boolean } = {}) {
  let state = createInitialState({ now: 1, newId: () => 'x' })
  state = { ...state, settings: { ...state.settings, extensionPaths: ['/work/dev'], profileNames: { default: 'Perso' } } }
  const infos = options.infos ?? [unpacked(), store()]
  const failed = vi.fn((_profile: string, _path: string, _id: string | undefined, _reason: unknown) => '')
  const tools = {
    details: vi.fn(async (): Promise<ExtensionDetail[]> => [{ profileId: 'default', id: A, path: '/work/dev', facts: { optionsPage: 'o.html' } as never, workerRunning: false }]),
    failureOf: vi.fn((_profile: string, _id: string): string | undefined => undefined),
    folderOf: vi.fn((_profile: string, id: string) => (id === A ? { path: '/work/dev', name: 'Dev', version: '1.0', source: 'unpacked' as const } : null)),
    reload: vi.fn(async (_profile: string, _id: string): Promise<ExtensionInfo> => unpacked()),
    removeFolder: vi.fn((id: string) => (id === A ? { path: '/work/dev', name: 'Dev' } : null)),
    removeFolderAt: vi.fn((path: string) => (path === '/work/dev' ? { path, name: 'Dev' } : null)),
    watchConsoles: vi.fn(() => () => undefined),
    isWatching: vi.fn(() => false),
    readJournal: vi.fn(() => []),
    lastJournalId: vi.fn(() => 7),
    clearJournal: vi.fn(() => 0),
    removeJournalEntries: vi.fn((_ids: readonly number[]) => undefined),
    failed,
    revokeGranted: vi.fn((_profile: string, _id: string, name: string) => name === 'history')
  }
  const env: ExtensionsServiceEnv = {
    engine: { listAllExtensions: () => infos, uninstallExtension: vi.fn(async () => undefined), extensionTools: tools },
    state: () => state,
    dispatch: vi.fn((action) => void (state = reduce(state, action, { now: 1, newId: () => 'x' }))),
    isPrivate: () => options.isPrivate === true,
    confirm: vi.fn(async () => options.confirm !== false),
    chooseFolder: vi.fn(async () => (options.folder === undefined ? '/work/new' : options.folder)),
    readManifest: vi.fn(async () => (options.manifest === undefined ? GOOD : options.manifest)),
    fileExists: vi.fn(async (_folder: string, file: string) => (options.files ?? ['sw.js', 'o.html']).includes(file)),
    loadFolder: vi.fn(async () => options.loadFailure ?? null),
    openExtensionTab: vi.fn(async () => undefined),
    copyText: vi.fn(),
    ...(options.pack === false ? {} : { pack: vi.fn(async () => ({ crx: '/out/dev.crx', key: '/out/dev.pem', newKey: true })) })
  }
  return { service: new ExtensionsService(env), env, tools, failed, state: () => state }
}

describe('the Extensions page service', () => {
  it('gives nothing to a private window: it has no extensions', async () => {
    const t = setup({ isPrivate: true })
    const reply = await t.service.handle({ op: 'reload', profileId: 'default', extensionId: A })
    expect(reply.ok).toBe(false)
    expect(reply.message).toMatch(/extensions/i)
    expect(t.tools.reload).not.toHaveBeenCalled()
  })

  it('answers the details, and the journal from the number it was given', async () => {
    const t = setup()
    expect((await t.service.handle({ op: 'details' })).details).toHaveLength(1)
    const reply = await t.service.handle({ op: 'journal', since: 3 })
    expect(t.tools.readJournal).toHaveBeenCalledWith({ since: 3 })
    expect(reply).toMatchObject({ ok: true, lastId: 7 })
  })

  it('clears the journal of one extension, or of all', async () => {
    const t = setup()
    await t.service.handle({ op: 'clear-journal', extensionId: A, profileId: 'default' })
    expect(t.tools.clearJournal).toHaveBeenLastCalledWith({ extensionId: A, profileId: 'default' })
    await t.service.handle({ op: 'clear-journal' })
    expect(t.tools.clearJournal).toHaveBeenLastCalledWith({})
  })

  it('forgets the lines it is given by their numbers and no other: the journals of the extensions and of the other profiles stay', async () => {
    const t = setup()
    expect(await t.service.handle({ op: 'clear-journal', ids: [3, 5] })).toMatchObject({ ok: true, lastId: 7 })
    expect(t.tools.removeJournalEntries).toHaveBeenCalledWith([3, 5])
    expect(t.tools.clearJournal).not.toHaveBeenCalled()
  })

  describe('switching', () => {
    it('switches an extension off in a profile through the state, as Settings does', async () => {
      const t = setup()
      expect(await t.service.handle({ op: 'set-enabled', profileId: 'default', extensionId: A, enabled: false })).toEqual({ ok: true })
      expect(t.state().settings.profiles['default']?.disabledExtensions).toEqual([A])
    })

    it('refuses an extension that is not in that profile, and says so', async () => {
      const t = setup()
      const reply = await t.service.handle({ op: 'set-enabled', profileId: 'work', extensionId: A, enabled: false })
      expect(reply).toMatchObject({ ok: false, message: expect.stringContaining('pas installée') })
      expect(t.env.dispatch).not.toHaveBeenCalled()
    })
  })

  describe('the capture of the sound of a tab', () => {
    it('lets an extension capture it in a profile through the state, and takes it back', async () => {
      const t = setup()
      expect(await t.service.handle({ op: 'set-tab-capture', profileId: 'default', extensionId: A, allowed: true })).toEqual({ ok: true })
      expect(t.state().settings.profiles['default']?.tabCaptureExtensions).toEqual([A])
      expect(await t.service.handle({ op: 'set-tab-capture', profileId: 'default', extensionId: A, allowed: false })).toEqual({ ok: true })
      expect(t.state().settings.profiles['default']?.tabCaptureExtensions).toBeUndefined()
    })

    it('refuses an extension that is not in that profile, and says so, without touching the state', async () => {
      const t = setup()
      const reply = await t.service.handle({ op: 'set-tab-capture', profileId: 'work', extensionId: A, allowed: true })
      expect(reply).toMatchObject({ ok: false, message: expect.stringContaining('pas installée') })
      expect(t.env.dispatch).not.toHaveBeenCalled()
    })
  })

  describe('reload', () => {
    it('reloads the extension from its folder and says so', async () => {
      const t = setup()
      const reply = await t.service.handle({ op: 'reload', profileId: 'default', extensionId: A })
      expect(t.tools.reload).toHaveBeenCalledWith('default', A)
      expect(reply).toEqual({ ok: true, message: frenchSpaces('« Dev » est rechargée.') })
    })

    it('reloads a Manifest V2 folder: the first look no longer stops it before the engine', async () => {
      const t = setup({ manifest: LEGACY, files: ['bg.js', 'popup.html'] })
      const reply = await t.service.handle({ op: 'reload', profileId: 'default', extensionId: A })
      expect(t.tools.reload).toHaveBeenCalledWith('default', A)
      expect(reply).toEqual({ ok: true, message: frenchSpaces('« Dev » est rechargée.') })
      expect(t.failed).not.toHaveBeenCalled()
    })

    it('does not unload the extension when the edit broke the manifest: it keeps running, and the sentence names what is wrong, in the journal too', async () => {
      const t = setup({ manifest: '{ "manifest_version": 3, ' })
      const reply = await t.service.handle({ op: 'reload', profileId: 'default', extensionId: A })
      expect(t.tools.reload).not.toHaveBeenCalled()
      expect(reply.ok).toBe(false)
      expect(reply.message).toMatch(/pas du JSON valide/)
      expect(t.failed).toHaveBeenCalledWith('default', '/work/dev', A, reply.message)
    })

    it('names the file the manifest cites that is gone', async () => {
      const t = setup({ files: ['o.html'] })
      const reply = await t.service.handle({ op: 'reload', profileId: 'default', extensionId: A })
      expect(reply).toMatchObject({ ok: false, message: expect.stringContaining(frenchSpaces('« sw.js »')) })
      expect(t.tools.reload).not.toHaveBeenCalled()
    })

    it('says that a folder with no manifest has none', async () => {
      const t = setup({ manifest: null })
      expect((await t.service.handle({ op: 'reload', profileId: 'default', extensionId: A })).message).toMatch(/manifest\.json/)
    })

    it('says why when Chromium refuses the folder or the engine has a sentence', async () => {
      const t = setup()
      t.tools.reload.mockRejectedValueOnce(new Error('Invalid value for content_scripts[0].matches'))
      expect((await t.service.handle({ op: 'reload', profileId: 'default', extensionId: A })).message).toBe(frenchSpaces('Le moteur a refusé l’extension : Invalid value for content_scripts[0].matches'))
      t.tools.reload.mockRejectedValueOnce(new ExtensionDevError('Activez l’extension avant de la recharger.'))
      expect((await t.service.handle({ op: 'reload', profileId: 'default', extensionId: A })).message).toBe('Activez l’extension avant de la recharger.')
    })

    it('refuses an extension that is switched off, with the reason, before touching anything', async () => {
      const t = setup({ infos: [unpacked({ enabled: false })] })
      const reply = await t.service.handle({ op: 'reload', profileId: 'default', extensionId: A })
      expect(reply).toMatchObject({ ok: false, message: expect.stringContaining('Activez') })
      expect(t.env.readManifest).not.toHaveBeenCalled()
      expect(t.tools.reload).not.toHaveBeenCalled()
    })

    it('tries again an extension that is not loaded because its last load failed: the developer fixed the folder', async () => {
      const t = setup({ infos: [unpacked({ enabled: false })] })
      t.tools.failureOf.mockReturnValue('Le moteur a refusé l’extension : bad pattern')
      const reply = await t.service.handle({ op: 'reload', profileId: 'default', extensionId: A })
      expect(reply).toEqual({ ok: true, message: frenchSpaces('« Dev » est rechargée.') })
      expect(t.tools.reload).toHaveBeenCalledWith('default', A)
    })

    it('refuses an extension the engine has no folder for, whatever the list says', async () => {
      const t = setup()
      t.tools.folderOf.mockReturnValueOnce(null)
      expect((await t.service.handle({ op: 'reload', profileId: 'default', extensionId: A })).ok).toBe(false)
      expect(t.tools.reload).not.toHaveBeenCalled()
    })

    it('refuses an extension the profile does not have', async () => {
      const t = setup()
      expect((await t.service.handle({ op: 'reload', profileId: 'work', extensionId: A })).ok).toBe(false)
      expect((await t.service.handle({ op: 'reload', profileId: 'default', extensionId: 'c'.repeat(32) })).ok).toBe(false)
      expect(t.tools.reload).not.toHaveBeenCalled()
    })
  })

  describe('uninstall', () => {
    it('asks first, naming the profile, and removes the extension once confirmed', async () => {
      const t = setup()
      const reply = await t.service.handle({ op: 'uninstall', profileId: 'default', extensionId: B })
      expect(t.env.confirm).toHaveBeenCalledWith({ message: frenchSpaces('Désinstaller « Vimium » ?'), detail: expect.stringContaining(frenchSpaces('« Perso »')), ok: 'Désinstaller' })
      expect(t.env.engine.uninstallExtension).toHaveBeenCalledWith('default', B)
      expect(reply).toEqual({ ok: true, message: frenchSpaces('« Vimium » est désinstallée.') })
    })

    it('does nothing, and says nothing, when the person gives up', async () => {
      const t = setup({ confirm: false })
      expect(await t.service.handle({ op: 'uninstall', profileId: 'default', extensionId: B })).toEqual({ ok: true })
      expect(t.env.engine.uninstallExtension).not.toHaveBeenCalled()
    })

    // The panel of the site asks « Retirer ? » in place, with « Annuler » as the answer of a Return: a second question in a box would ask it twice.
    it('asks nothing more when the interface asked in place, and still refuses a folder', async () => {
      const t = setup({ confirm: false })
      const reply = await t.service.handle({ op: 'uninstall', profileId: 'default', extensionId: B, asked: true })
      expect(t.env.confirm).not.toHaveBeenCalled()
      expect(t.env.engine.uninstallExtension).toHaveBeenCalledWith('default', B)
      expect(reply).toEqual({ ok: true, message: frenchSpaces('« Vimium » est désinstallée.') })
      expect(await t.service.handle({ op: 'uninstall', profileId: 'default', extensionId: A, asked: true })).toMatchObject({ ok: false })
      expect(t.env.engine.uninstallExtension).toHaveBeenCalledTimes(1)
    })

    it('tells why it failed, and logs the cause', async () => {
      const t = setup()
      vi.mocked(t.env.engine.uninstallExtension).mockRejectedValueOnce(new Error('disk full'))
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      const reply = await t.service.handle({ op: 'uninstall', profileId: 'default', extensionId: B })
      expect(reply).toMatchObject({ ok: false, message: expect.stringContaining('disk full') })
      expect(error).toHaveBeenCalled()
      error.mockRestore()
    })

    it('does not uninstall a folder: that is « Supprimer » on its card, which asks nothing and can be undone', async () => {
      const t = setup()
      const reply = await t.service.handle({ op: 'uninstall', profileId: 'default', extensionId: A })
      expect(reply).toMatchObject({ ok: false, message: expect.stringContaining(frenchSpaces('utilisez « Supprimer »')) })
      expect(t.env.confirm).not.toHaveBeenCalled()
      expect(t.env.engine.uninstallExtension).not.toHaveBeenCalled()
    })
  })

  describe('removing a folder, and putting it back', () => {
    it('takes the folder out of the settings and offers to put it back', async () => {
      const t = setup()
      const reply = await t.service.handle({ op: 'remove-folder', extensionId: A })
      expect(reply).toEqual({ ok: true, message: frenchSpaces('« Dev » est retirée ; le dossier n’est pas touché.'), undo: true })
      expect(t.state().settings.extensionPaths).toEqual([])
    })

    it('puts the same folder back, once, from what it remembers and not from anything the page sends', async () => {
      const t = setup()
      await t.service.handle({ op: 'remove-folder', extensionId: A })
      expect(await t.service.handle({ op: 'undo-remove' })).toEqual({ ok: true, message: frenchSpaces('« Dev » est remise.') })
      expect(t.env.loadFolder).toHaveBeenCalledWith('/work/dev')
      expect(t.state().settings.extensionPaths).toEqual(['/work/dev'])
      expect(await t.service.handle({ op: 'undo-remove' })).toMatchObject({ ok: false, message: expect.stringContaining('rien à remettre') })
    })

    it('does not add to the settings a folder that was only loaded for the run (the environment)', async () => {
      const t = setup()
      t.env.state().settings.extensionPaths.splice(0)
      await t.service.handle({ op: 'remove-folder', extensionId: A })
      await t.service.handle({ op: 'undo-remove' })
      expect(t.state().settings.extensionPaths).toEqual([])
    })

    it('says why when the folder will not load back', async () => {
      const t = setup({ loadFailure: 'Le dossier ne contient pas de manifest.json lisible.' })
      await t.service.handle({ op: 'remove-folder', extensionId: A })
      expect(await t.service.handle({ op: 'undo-remove' })).toMatchObject({ ok: false, message: expect.stringContaining('manifest.json') })
      expect(t.state().settings.extensionPaths).toEqual([])
    })

    it('does not forget the Web Store extension: it is uninstalled, after a question', async () => {
      const t = setup()
      const reply = await t.service.handle({ op: 'remove-folder', extensionId: B })
      expect(reply).toMatchObject({ ok: false, message: expect.stringContaining('désinstallez') })
      expect(t.tools.removeFolder).not.toHaveBeenCalled()
    })
  })

  describe('loading a folder', () => {
    it('loads the folder the person chose, remembers it, and names the extension', async () => {
      const t = setup()
      const reply = await t.service.handle({ op: 'load-unpacked' })
      expect(t.env.loadFolder).toHaveBeenCalledWith('/work/new')
      expect(reply).toEqual({ ok: true, message: frenchSpaces('« Folder ext » est chargée.') })
      expect(t.state().settings.extensionPaths).toEqual(['/work/dev', '/work/new'])
    })

    it('loads a Manifest V2 folder as Settings does, remembers it, and says in the same notice that the format is old', async () => {
      const t = setup({ manifest: LEGACY, files: ['bg.js', 'popup.html'] })
      const reply = await t.service.handle({ op: 'load-unpacked' })
      expect(t.env.loadFolder).toHaveBeenCalledWith('/work/new')
      expect(reply).toEqual({ ok: true, message: frenchSpaces(`« Old ext » est chargée. ${LEGACY_NOTE}`) })
      expect(t.failed).not.toHaveBeenCalled()
      expect(t.state().settings.extensionPaths).toEqual(['/work/dev', '/work/new'])
    })

    it('adds no warning to a Manifest V3 folder, and none when the Manifest V2 folder fails to load (the engine’s sentence is the answer)', async () => {
      expect((await setup().service.handle({ op: 'load-unpacked' })).message).not.toContain('Manifest V2')
      const t = setup({ manifest: LEGACY, files: ['bg.js', 'popup.html'], loadFailure: 'Le moteur a refusé l’extension : bad match pattern' })
      const reply = await t.service.handle({ op: 'load-unpacked' })
      expect(reply).toMatchObject({ ok: false, message: expect.stringContaining('bad match pattern') })
      expect(reply.message).not.toContain('format ancien')
      expect(t.state().settings.extensionPaths).toEqual(['/work/dev'])
    })

    it('names the file a Manifest V2 manifest cites that is gone: its background script, then its popup', async () => {
      const noScript = setup({ manifest: LEGACY, files: ['popup.html'] })
      expect(await noScript.service.handle({ op: 'load-unpacked' })).toMatchObject({ ok: false, message: expect.stringContaining(frenchSpaces('« bg.js »')) })
      expect(noScript.env.loadFolder).not.toHaveBeenCalled()
      expect(noScript.failed).toHaveBeenCalledWith('default', '/work/new', undefined, expect.stringContaining('bg.js'))
      const noPopup = setup({ manifest: LEGACY, files: ['bg.js'] })
      expect(await noPopup.service.handle({ op: 'load-unpacked' })).toMatchObject({ ok: false, message: expect.stringContaining(frenchSpaces('« popup.html »')) })
      expect(noPopup.env.loadFolder).not.toHaveBeenCalled()
    })

    it('does nothing when the box is cancelled', async () => {
      const t = setup({ folder: null })
      expect(await t.service.handle({ op: 'load-unpacked' })).toEqual({ ok: true })
      expect(t.env.readManifest).not.toHaveBeenCalled()
    })

    it('refuses a folder whose manifest lists more than the review reads, in the page and in the journal, and loads nothing', async () => {
      const t = setup({ manifest: JSON.stringify({ manifest_version: 3, name: 'Wide', version: '1.0', permissions: Array.from({ length: 513 }, (_v, i) => `p${i}`) }) })
      const reply = await t.service.handle({ op: 'load-unpacked' })
      expect(reply.ok).toBe(false)
      expect(reply.message).toContain('plus de 512 dans une liste')
      expect(t.env.loadFolder).not.toHaveBeenCalled()
      expect(t.failed).toHaveBeenCalledWith('default', '/work/new', undefined, expect.stringContaining('plus de 512'))
      expect(t.state().settings.extensionPaths).toEqual(['/work/dev'])
    })

    it('says what is wrong with a manifest that is invalid, in the page and in the journal, and loads nothing', async () => {
      const t = setup({ manifest: '{"manifest_version":4,"name":"Odd","version":"1"}' })
      const reply = await t.service.handle({ op: 'load-unpacked' })
      expect(reply.ok).toBe(false)
      expect(reply.message).toMatch(/«\u00a0new\u00a0» n’a pas été chargée\. manifest\.json\u00a0: «\u00a0manifest_version\u00a0» doit valoir 2 ou 3\./)
      expect(t.env.loadFolder).not.toHaveBeenCalled()
      expect(t.failed).toHaveBeenCalledWith('default', '/work/new', undefined, expect.stringContaining('manifest_version'))
      expect(t.state().settings.extensionPaths).toEqual(['/work/dev'])
    })

    it('says the manifest could not be read, with the reason, and logs it', async () => {
      const t = setup()
      vi.mocked(t.env.readManifest).mockRejectedValueOnce(new Error('EACCES: permission denied'))
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      const reply = await t.service.handle({ op: 'load-unpacked' })
      expect(reply).toMatchObject({ ok: false, message: expect.stringContaining('EACCES') })
      expect(error).toHaveBeenCalled()
      error.mockRestore()
    })

    it('says what Chromium said when it refuses the folder, and keeps the folder out of the settings', async () => {
      const t = setup({ loadFailure: 'Le moteur a refusé l’extension : bad match pattern' })
      const reply = await t.service.handle({ op: 'load-unpacked' })
      expect(reply).toMatchObject({ ok: false, message: expect.stringContaining('bad match pattern') })
      expect(t.state().settings.extensionPaths).toEqual(['/work/dev'])
    })

    it('does not add a folder that is already in the settings a second time', async () => {
      const t = setup({ folder: '/work/dev' })
      await t.service.handle({ op: 'load-unpacked' })
      expect(t.state().settings.extensionPaths).toEqual(['/work/dev'])
    })
  })

  describe('packing', () => {
    it('packs a folder the person chose a place for, and says where the key went', async () => {
      const t = setup()
      const reply = await t.service.handle({ op: 'pack', extensionId: A })
      expect(reply.ok).toBe(true)
      expect(reply.message).toContain('dev.crx')
      expect(reply.message).toContain('dev.pem')
    })

    it('packs a Manifest V2 folder too: it is in the list, with its button', async () => {
      const t = setup({ manifest: LEGACY, files: ['bg.js', 'popup.html'] })
      const reply = await t.service.handle({ op: 'pack', extensionId: A })
      expect(t.env.pack).toHaveBeenCalledWith('/work/dev', 'Dev')
      expect(reply.ok).toBe(true)
    })

    it('says nothing when the save box is cancelled', async () => {
      const t = setup()
      vi.mocked(t.env.pack!).mockResolvedValueOnce(null)
      expect(await t.service.handle({ op: 'pack', extensionId: A })).toEqual({ ok: true })
    })

    it('refuses a Web Store extension, and a folder whose manifest is broken', async () => {
      const t = setup()
      expect((await t.service.handle({ op: 'pack', extensionId: B })).message).toMatch(/depuis un dossier/)
      const broken = setup({ manifest: 'nope' })
      expect((await broken.service.handle({ op: 'pack', extensionId: A })).ok).toBe(false)
      expect(broken.env.pack).not.toHaveBeenCalled()
    })

    it('says why packing failed, and logs the cause', async () => {
      const t = setup()
      vi.mocked(t.env.pack!).mockRejectedValueOnce(new Error('no space left'))
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      expect(await t.service.handle({ op: 'pack', extensionId: A })).toMatchObject({ ok: false, message: expect.stringContaining('no space left') })
      expect(error).toHaveBeenCalled()
      error.mockRestore()
    })

    it('says so when packing is not wired', async () => {
      const t = setup({ pack: false })
      expect((await t.service.handle({ op: 'pack', extensionId: A })).message).toMatch(/pas disponible/)
    })
  })

  describe('taking back a permission granted on request', () => {
    it('takes it back in the profile named, and says which extension lost what', async () => {
      const t = setup()
      expect(await t.service.handle({ op: 'revoke-granted', profileId: 'default', extensionId: A, name: 'history' })).toEqual({ ok: true, message: frenchSpaces('« Dev » n’a plus l’autorisation history.') })
      expect(t.tools.revokeGranted).toHaveBeenCalledExactlyOnceWith('default', A, 'history')
    })

    it('says so when the permission was no longer held, and when the extension is not in the profile', async () => {
      const t = setup()
      expect(await t.service.handle({ op: 'revoke-granted', profileId: 'default', extensionId: A, name: 'cookies' })).toEqual({ ok: false, message: frenchSpaces('Cette autorisation n’est plus accordée.') })
      const missing = await t.service.handle({ op: 'revoke-granted', profileId: 'work', extensionId: A, name: 'history' })
      expect(missing.ok).toBe(false)
      expect(t.tools.revokeGranted).toHaveBeenCalledTimes(1)
    })
  })

  it('puts the id of an extension on the clipboard, and says it is copied', async () => {
    const t = setup()
    expect(await t.service.handle({ op: 'copy-id', extensionId: A })).toEqual({ ok: true, message: 'Copié.' })
    expect(t.env.copyText).toHaveBeenCalledWith(A)
  })

  describe('options page', () => {
    it('opens the page of options in a tab of the extension’s profile', async () => {
      const t = setup()
      expect(await t.service.handle({ op: 'open-options', profileId: 'default', extensionId: A })).toEqual({ ok: true })
      expect(t.env.openExtensionTab).toHaveBeenCalledWith('default', `chrome-extension://${A}/o.html`)
    })

    it('says so when there is no page of options, or the tab could not open', async () => {
      const t = setup()
      t.tools.details.mockResolvedValueOnce([{ profileId: 'default', id: A, path: '/work/dev', facts: {} as never, workerRunning: false }])
      expect((await t.service.handle({ op: 'open-options', profileId: 'default', extensionId: A })).message).toMatch(/pas de page d’options/)
      vi.mocked(t.env.openExtensionTab).mockRejectedValueOnce(new Error('There is no space for the profile of this extension.'))
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      expect(await t.service.handle({ op: 'open-options', profileId: 'default', extensionId: A })).toMatchObject({ ok: false, message: expect.stringContaining('no space for the profile') })
      error.mockRestore()
    })

    it('asks to switch the extension on first', async () => {
      const t = setup({ infos: [unpacked({ enabled: false })] })
      expect((await t.service.handle({ op: 'open-options', profileId: 'default', extensionId: A })).message).toMatch(/Activez/)
    })
  })
})
