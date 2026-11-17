import { afterEach, describe, expect, it, vi } from 'vitest'
import { BOOST_BUNDLE_MAX, BOOST_BUNDLE_MAX_BYTES, SHARE_FILE_MAX_BYTES, THEME_FILE_MAX_BYTES, boostFileText, boostLink, parseBoostFiles, themeFileText, type ImportPreview, type SharedBoost } from '@shared/boost-share'
import type { Boost, SidebarState } from '@shared/model'
import { NEUTRAL_TINT } from '@shared/model'
import { createInitialState, reduce, type Action, type Ctx } from '@shared/sidebar'
import { READY_THEMES } from '@shared/theme-presets'
import { encodeThemeCode } from '@shared/theme-code'
import type { BoundedRead } from './bounded-file'
import { isWideHost } from './boost-host'
import {
  answering,
  copyBoostLink,
  describeTheme,
  exportAllBoostsToFile,
  exportBoostToFile,
  exportThemeToFile,
  importBoostFromClipboard,
  importBoostFromFile,
  importThemeFromFile,
  runBoostShareRequest,
  runThemeFileRequest,
  type ExportChoice,
  type ImportChoice,
  type ShareEnvironment
} from './boost-share'
import { frenchSpaces } from '@shared/french-typography'

const BOOST: SharedBoost = { name: 'Lecture', host: 'example.com', css: 'body { max-width: 40em }', js: '', zoom: 1.2, zap: ['#ad'], tint: NEUTRAL_TINT, fontFamily: 'inter', textCase: 'upper', invert: true }
const SCRIPTED: SharedBoost = { ...BOOST, name: 'Avec script', js: 'document.title = "x"' }

interface Options {
  settings?: Partial<SidebarState['settings']>
  boosts?: Boost[]
  files?: Record<string, BoundedRead | string>
  clipboard?: string | Error
  writeFails?: boolean
  fileWriteFails?: boolean
  openChoice?: string | null
  saveChoice?: string | null
  importChoice?: ImportChoice | (() => Promise<ImportChoice>)
  exportChoice?: ExportChoice
  themeAgrees?: boolean
  isPrivate?: boolean
  dialogFails?: boolean
}

/** A window made of plain values: the state goes through the real reducer; the dialogs, files and clipboard are recorded. */
function environment(options: Options = {}) {
  let n = 0
  const ctx: Ctx = { now: 1, newId: () => `reducer-${++n}` }
  let state = createInitialState(ctx)
  state = { ...state, settings: { ...state.settings, ...options.settings }, boosts: options.boosts ?? [] }
  const log = {
    dispatched: [] as Action[],
    toasts: [] as string[],
    problems: [] as Array<{ title: string; sentence: string }>,
    previews: [] as ImportPreview[],
    exportSheets: [] as Array<{ name: string; warning: string; scripted?: readonly string[] }>,
    themeSheets: [] as Array<{ message: string; detail: string }>,
    chosenToOpen: 0,
    chosenToSave: [] as Array<{ title: string; name: string; extension: string }>,
    reads: [] as Array<{ path: string; max: number }>,
    writes: [] as Array<{ path: string; text: string }>,
    clipboardWrites: [] as string[]
  }
  let isPrivate = options.isPrivate === true
  let ids = 0
  const env: ShareEnvironment = {
    window: {},
    state: () => state,
    dispatch: (action) => {
      log.dispatched.push(action)
      state = reduce(state, action, ctx)
    },
    toast: (message) => void log.toasts.push(message),
    readClipboard: async () => {
      if (options.clipboard instanceof Error) throw options.clipboard
      return options.clipboard ?? ''
    },
    writeClipboard: async (text) => {
      if (options.writeFails) throw new Error('denied')
      log.clipboardWrites.push(text)
    },
    isPrivate: () => isPrivate,
    newId: () => `import-${++ids}`,
    isWideHost,
    chooseOpenFile: async () => {
      log.chosenToOpen++
      return options.openChoice === undefined ? '/tmp/boost.lucium-boost' : options.openChoice
    },
    chooseSaveFile: async (title, name, extension) => {
      log.chosenToSave.push({ title, name, extension })
      return options.saveChoice === undefined ? '/tmp/out.lucium-boost' : options.saveChoice
    },
    readFile: async (path, max) => {
      log.reads.push({ path, max })
      const file = options.files?.[path]
      if (file === undefined) return { ok: false, reason: 'not-found' }
      return typeof file === 'string' ? { ok: true, text: file } : file
    },
    writeFile: async (path, text) => {
      if (options.fileWriteFails) throw new Error('disk full')
      log.writes.push({ path, text })
    },
    confirmImport: async (preview) => {
      log.previews.push(preview)
      const choice = options.importChoice ?? 'install'
      return typeof choice === 'function' ? choice() : choice
    },
    confirmExportScript: async (name, warning, scripted) => {
      log.exportSheets.push({ name, warning, ...(scripted ? { scripted } : {}) })
      return options.exportChoice ?? 'with-script'
    },
    confirmThemeImport: async (message, detail) => {
      log.themeSheets.push({ message, detail })
      return options.themeAgrees !== false
    },
    showProblem: async (title, sentence) => {
      if (options.dialogFails) throw new Error('no window')
      log.problems.push({ title, sentence })
    }
  }
  return { env, log, get state() { return state }, becomePrivate: () => void (isPrivate = true) }
}

const FILE = '/tmp/boost.lucium-boost'
const stored = (over: Partial<Boost> = {}): Boost => ({ id: 'mine', name: 'Ma Retouche', host: 'example.com', enabled: true, css: 'p { color: teal }', js: '', zoom: 1, zap: [], tint: NEUTRAL_TINT, ...over })

afterEach(() => vi.restoreAllMocks())

describe('importing a Tweak from a file', () => {
  it('shows the Tweak, and installs it once the person says yes: switched on, with its script, if any, switched off', async () => {
    const w = environment({ files: { [FILE]: boostFileText(SCRIPTED) } })
    const reply = await importBoostFromFile(w.env)
    expect(reply).toEqual({ ok: true, message: frenchSpaces('Retouche « Avec script » installée · JavaScript désactivé'), boostId: 'import-1' })
    expect(w.log.previews).toHaveLength(1)
    expect(w.log.previews[0]!.message).toBe(frenchSpaces('Installer la Retouche « Avec script » ?'))
    expect(w.log.previews[0]!.detail).toContain('document.title = "x"')
    expect(w.log.dispatched.map((a) => a.type)).toEqual(['boost/import'])
    expect(w.state.boosts).toEqual([
      { id: 'import-1', name: 'Avec script', host: 'example.com', enabled: true, css: BOOST.css, js: 'document.title = "x"', jsEnabled: false, zoom: 1.2, zap: ['#ad'], tint: NEUTRAL_TINT, fontFamily: 'inter', textCase: 'upper', invert: true }
    ])
    expect(w.log.toasts).toEqual([frenchSpaces('Retouche « Avec script » installée · JavaScript désactivé')])
  })

  it('asks for a file of the size limit only: that of a file of all the Tweaks, since "Importer une Retouche…" reads those too', async () => {
    const w = environment({ files: { [FILE]: boostFileText(BOOST) } })
    await importBoostFromFile(w.env)
    expect(w.log.reads).toEqual([{ path: FILE, max: BOOST_BUNDLE_MAX_BYTES }])
  })

  it('says nothing and writes nothing when the person closes the file dialog or the sheet', async () => {
    const closedDialog = environment({ openChoice: null, files: { [FILE]: boostFileText(BOOST) } })
    expect(await importBoostFromFile(closedDialog.env)).toEqual({ ok: false, message: '', cancelled: true })
    expect(closedDialog.log.reads).toEqual([])
    expect(closedDialog.log.problems).toEqual([])

    const closedSheet = environment({ importChoice: 'cancel', files: { [FILE]: boostFileText(BOOST) } })
    expect(await importBoostFromFile(closedSheet.env)).toEqual({ ok: false, message: '', cancelled: true })
    expect(closedSheet.log.dispatched).toEqual([])
    expect(closedSheet.state.boosts).toEqual([])
    expect(closedSheet.log.toasts).toEqual([])
  })

  it('installs without the script when the person asks for that, and the Tweak has none then', async () => {
    const w = environment({ importChoice: 'install-without-script', files: { [FILE]: boostFileText(SCRIPTED) } })
    expect(await importBoostFromFile(w.env)).toMatchObject({ ok: true, message: frenchSpaces('Retouche « Avec script » installée') })
    expect(w.state.boosts[0]).toMatchObject({ js: '', css: BOOST.css })
    expect(w.state.boosts[0]).not.toHaveProperty('jsEnabled')
  })

  it('drops the script under the setting "never", and the sheet says so', async () => {
    const w = environment({ settings: { boostScriptImport: 'never' }, files: { [FILE]: boostFileText(SCRIPTED) } })
    await importBoostFromFile(w.env)
    expect(w.log.previews[0]).toMatchObject({ hasScript: false, scriptDropped: true })
    expect(w.log.previews[0]!.detail).not.toContain('document.title')
    expect(w.state.boosts[0]).toMatchObject({ js: '' })
  })

  describe('refuses, with the reason and without writing anything, a file that', () => {
    const cases: Array<[string, string, RegExp]> = [
      ['is not JSON', 'body { color: red }', /n’est pas du JSON/],
      ['is a theme', themeFileText(READY_THEMES[0]!.theme, 'x'), /contient un thème/],
      ['is of another format', JSON.stringify({ format: 2, kind: 'boost', boost: { host: 'example.com' } }), /format «\u00a02\u00a0»/],
      ['loads another stylesheet', JSON.stringify({ format: 1, kind: 'boost', boost: { host: 'example.com', css: '@import url(https://evil.example/x.css);' } }), /@import/],
      ['loads a picture', JSON.stringify({ format: 1, kind: 'boost', boost: { host: 'example.com', css: 'a { background: url(https://evil.example/?l) }' } }), /url\(…\)/],
      ['hides what it loads by an escape', JSON.stringify({ format: 1, kind: 'boost', boost: { host: 'example.com', css: 'a { background: \\75 rl(https://evil.example/) }' } }), /url\(…\)/],
      ['aims at a bare word', JSON.stringify({ format: 1, kind: 'boost', boost: { host: 'com' } }), /nom de site valide/],
      ['aims at a public suffix', JSON.stringify({ format: 1, kind: 'boost', boost: { host: 'co.uk' } }), /trop large/],
      ['aims at a hosting family', JSON.stringify({ format: 1, kind: 'boost', boost: { host: 'github.io' } }), /trop large/],
      ['has a zoom out of bounds', JSON.stringify({ format: 1, kind: 'boost', boost: { host: 'example.com', zoom: 50 } }), /taille du texte/],
      ['has a script that hides characters', JSON.stringify({ format: 1, kind: 'boost', boost: { host: 'example.com', js: `a${String.fromCharCode(0x202e)}` } }), /caractères invisibles/]
    ]
    it.each(cases)('%s', async (_name, text, sentence) => {
      const w = environment({ files: { [FILE]: text } })
      const before = w.state
      const reply = await importBoostFromFile(w.env)
      expect(reply.ok).toBe(false)
      expect(reply.message).toMatch(sentence)
      expect(w.log.problems).toEqual([{ title: 'Retouche refusée', sentence: reply.message }])
      expect(reply.shown).toBe(true)
      // Nothing was shown as installable, dispatched, toasted or changed.
      expect(w.log.previews).toEqual([])
      expect(w.log.dispatched).toEqual([])
      expect(w.log.toasts).toEqual([])
      expect(w.state).toBe(before)
    })
  })

  it.each<[string, BoundedRead, RegExp]>([
    ['is too big to be read', { ok: false, reason: 'too-large' }, /trop volumineux/],
    ['is gone', { ok: false, reason: 'not-found' }, /n’existe plus/],
    ['is not a regular file', { ok: false, reason: 'not-a-file' }, /pas un fichier ordinaire/],
    ['is not UTF-8 text', { ok: false, reason: 'not-text' }, /UTF-8/],
    ['cannot be opened', { ok: false, reason: 'unreadable', detail: 'EACCES' }, /EACCES/]
  ])('tells why a file that %s was not read', async (_name, read, sentence) => {
    const w = environment({ files: { [FILE]: read } })
    const reply = await importBoostFromFile(w.env)
    expect(reply.ok).toBe(false)
    expect(reply.message).toMatch(sentence)
    expect(w.log.problems).toHaveLength(1)
    expect(w.log.dispatched).toEqual([])
  })

  it('refuses a file whose text is over the limit even when the reader let it through', async () => {
    const w = environment({ files: { [FILE]: 'x'.repeat(BOOST_BUNDLE_MAX_BYTES + 1) } })
    expect((await importBoostFromFile(w.env)).message).toMatch(/trop volumineux/)
    expect(w.log.dispatched).toEqual([])
  })

  it('keeps the limit of one Tweak for a file of one Tweak, though the reader now lets a bigger file of several through', async () => {
    const padded = JSON.stringify({ format: 1, kind: 'boost', boost: BOOST, note: 'x'.repeat(SHARE_FILE_MAX_BYTES) })
    const w = environment({ files: { [FILE]: padded } })
    const reply = await importBoostFromFile(w.env)
    expect(reply.ok).toBe(false)
    expect(reply.message).toMatch(/trop volumineux.*512\u00a0Ko/)
    expect(w.log.dispatched).toEqual([])
    expect(w.state.boosts).toEqual([])
  })

  it('keeps a public suffix out but lets a site of a hosting family, localhost and an address in', async () => {
    for (const host of ['mon-blog.github.io', 'localhost', '127.0.0.1', 'example.co.uk']) {
      const w = environment({ files: { [FILE]: boostFileText({ ...BOOST, host }) } })
      expect((await importBoostFromFile(w.env)).ok, host).toBe(true)
    }
  })

  it('tells the person when the reducer itself refuses, and logs it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const w = environment({ files: { [FILE]: boostFileText(BOOST) } })
    // A reducer that drops the action: nothing lands in the state.
    w.env.dispatch = (action) => void w.log.dispatched.push(action)
    const reply = await importBoostFromFile(w.env)
    expect(reply).toEqual({ ok: false, message: 'Cette Retouche n’a pas pu être installée.', shown: true })
    expect(w.log.problems).toHaveLength(1)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('was not installed'))
    expect(w.log.toasts).toEqual([])
  })

  it('writes nothing when the window turns private while the sheet is open', async () => {
    const w = environment({ files: { [FILE]: boostFileText(BOOST) } })
    w.env.confirmImport = async () => {
      w.becomePrivate()
      return 'install'
    }
    const reply = await importBoostFromFile(w.env)
    expect(reply.ok).toBe(false)
    expect(w.log.dispatched).toEqual([])
  })

  it('serves one request at a time for a window', async () => {
    let release: (choice: ImportChoice) => void = () => {}
    const w = environment({ files: { [FILE]: boostFileText(BOOST) }, importChoice: () => new Promise<ImportChoice>((resolve) => (release = resolve)) })
    const first = importBoostFromFile(w.env)
    await vi.waitFor(() => expect(w.log.previews).toHaveLength(1))
    expect(await importBoostFromFile(w.env)).toEqual({ ok: false, message: frenchSpaces('Un partage est déjà en cours : terminez-le d’abord.') })
    expect(await exportBoostToFile(w.env, 'x')).toMatchObject({ ok: false, message: expect.stringContaining('déjà en cours') })
    release('install')
    expect((await first).ok).toBe(true)
    // And is free again afterwards, also after a request that fails.
    w.env.confirmImport = async () => {
      throw new Error('window closed')
    }
    await expect(importBoostFromFile(w.env)).rejects.toThrow('window closed')
    w.env.confirmImport = async () => 'cancel'
    expect(await importBoostFromFile(w.env)).toMatchObject({ cancelled: true })
  })

  it('still answers, and tells the person another way, when the dialog itself cannot be shown', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const w = environment({ dialogFails: true, files: { [FILE]: 'not json' } })
    const reply = await importBoostFromFile(w.env)
    expect(reply.ok).toBe(false)
    expect(console.error).toHaveBeenCalled()
    expect(w.log.toasts).toEqual([reply.message])
  })

  it('is not available in a private window: no dialog, no read, no change', async () => {
    const w = environment({ isPrivate: true, files: { [FILE]: boostFileText(BOOST) } })
    const reply = await importBoostFromFile(w.env)
    expect(reply).toEqual({ ok: false, message: 'Le partage de Retouches et de thèmes n’est pas disponible dans une fenêtre privée.' })
    expect(w.log.chosenToOpen).toBe(0)
    expect(w.log.reads).toEqual([])
    expect(w.log.dispatched).toEqual([])
  })
})

describe('importing a Tweak from the clipboard', () => {
  it('reads the link on the clipboard and installs the Tweak it holds', async () => {
    const w = environment({ clipboard: ` ${boostLink(SCRIPTED)}\n` })
    const reply = await importBoostFromClipboard(w.env)
    expect(reply).toMatchObject({ ok: true, boostId: 'import-1' })
    expect(w.state.boosts[0]).toMatchObject({ name: 'Avec script', jsEnabled: false, js: 'document.title = "x"' })
  })

  it.each<[string, string, RegExp]>([
    ['nothing', '', /rien à lire/],
    ['words', 'regarde cette Retouche !', /n’est pas un lien de Retouche/],
    ['an address', 'https://example.com/boost', /n’est pas un lien de Retouche/],
    ['a link of another version', 'lucboost9_AAAA', /autre version/],
    ['a link cut short', boostLink(BOOST).slice(0, -3), /(incomplet|n’est pas du JSON)/],
    ['a hostile link', `lucboost1_${btoa(JSON.stringify({ format: 1, kind: 'boost', boost: { host: 'example.com', css: '@import "x"' } })).replace(/=+$/, '')}`, /@import/]
  ])('refuses %s, with the reason', async (_name, clipboard, sentence) => {
    const w = environment({ clipboard })
    const reply = await importBoostFromClipboard(w.env)
    expect(reply.ok).toBe(false)
    expect(reply.message).toMatch(sentence)
    expect(w.log.problems).toHaveLength(1)
    expect(w.log.previews).toEqual([])
    expect(w.log.dispatched).toEqual([])
  })

  it('reports a clipboard that cannot be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const w = environment({ clipboard: new Error('denied') })
    expect(await importBoostFromClipboard(w.env)).toEqual({ ok: false, message: 'Le presse-papiers n’est pas accessible.' })
    expect(console.error).toHaveBeenCalled()
    expect(w.log.dispatched).toEqual([])
  })

  it('is not available in a private window', async () => {
    const w = environment({ isPrivate: true, clipboard: boostLink(BOOST) })
    expect((await importBoostFromClipboard(w.env)).ok).toBe(false)
    expect(w.log.dispatched).toEqual([])
    expect(w.log.previews).toEqual([])
  })
})

describe('exporting a Tweak as a file', () => {
  it('writes a file that reads back as the Tweak, under a name made of its own, without asking about a script it does not have', async () => {
    const w = environment({ boosts: [stored({ name: 'Lecture confortable', zoom: 1.1, fontFamily: 'fraunces' })], saveChoice: '/tmp/choisi.lucium-boost' })
    const reply = await exportBoostToFile(w.env, 'mine')
    expect(reply).toEqual({ ok: true, message: frenchSpaces('Retouche « Lecture confortable » exportée') })
    expect(w.log.exportSheets).toEqual([])
    expect(w.log.chosenToSave).toEqual([{ title: 'Exporter la Retouche', name: 'lecture-confortable.lucium-boost', extension: 'lucium-boost' }])
    expect(w.log.writes).toHaveLength(1)
    expect(w.log.writes[0]!.path).toBe('/tmp/choisi.lucium-boost')
    const again = environment({ files: { [FILE]: w.log.writes[0]!.text } })
    await importBoostFromFile(again.env)
    expect(again.state.boosts[0]).toMatchObject({ name: 'Lecture confortable', host: 'example.com', css: 'p { color: teal }', zoom: 1.1, fontFamily: 'fraunces' })
  })

  it('says that the Tweak has a script before writing it, and writes it only if the person agrees', async () => {
    const boosts = [stored({ js: 'secret()' })]
    const agree = environment({ boosts, exportChoice: 'with-script' })
    await exportBoostToFile(agree.env, 'mine')
    expect(agree.log.exportSheets).toHaveLength(1)
    expect(agree.log.exportSheets[0]!.warning).toContain('lisible par quiconque')
    expect(JSON.parse(agree.log.writes[0]!.text).boost.js).toBe('secret()')

    const without = environment({ boosts, exportChoice: 'without-script' })
    await exportBoostToFile(without.env, 'mine')
    expect(JSON.parse(without.log.writes[0]!.text).boost.js).toBe('')
    expect(without.log.writes[0]!.text).not.toContain('secret()')

    const cancel = environment({ boosts, exportChoice: 'cancel' })
    expect(await exportBoostToFile(cancel.env, 'mine')).toEqual({ ok: false, message: '', cancelled: true })
    expect(cancel.log.chosenToSave).toEqual([])
    expect(cancel.log.writes).toEqual([])
  })

  it('does not put the id, the state or the setting of the script in the file', async () => {
    const w = environment({ boosts: [stored({ id: 'mine', enabled: false, js: 'a()', jsEnabled: false })], exportChoice: 'with-script' })
    await exportBoostToFile(w.env, 'mine')
    expect(w.log.writes[0]!.text).not.toMatch(/"id"|enabled|jsEnabled|mine"/)
  })

  it('does not write what its reader would refuse, and says why before any file dialog', async () => {
    const w = environment({ boosts: [stored({ css: 'body { background: url(https://cdn.example/bg.png) }' })] })
    const reply = await exportBoostToFile(w.env, 'mine')
    expect(reply.ok).toBe(false)
    expect(reply.message).toMatch(/url\(…\)/)
    expect(w.log.problems[0]!.title).toBe('Cette Retouche ne peut pas être partagée')
    expect(w.log.chosenToSave).toEqual([])
    expect(w.log.writes).toEqual([])
  })

  it('does nothing when the person closes the save dialog', async () => {
    const w = environment({ boosts: [stored()], saveChoice: null })
    expect(await exportBoostToFile(w.env, 'mine')).toEqual({ ok: false, message: '', cancelled: true })
    expect(w.log.writes).toEqual([])
    expect(w.log.toasts).toEqual([])
  })

  it('tells the person, and logs, when the file cannot be written, instead of announcing an export that did not happen', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const w = environment({ boosts: [stored()], fileWriteFails: true })
    const reply = await exportBoostToFile(w.env, 'mine')
    expect(reply.ok).toBe(false)
    expect(reply.message).toContain('disk full')
    expect(w.log.problems[0]!.title).toBe('Export impossible')
    expect(w.log.toasts).toEqual([])
    expect(console.error).toHaveBeenCalled()
  })

  it('is not available in a private window, and says a Tweak that is gone is gone', async () => {
    const priv = environment({ isPrivate: true, boosts: [stored()] })
    expect((await exportBoostToFile(priv.env, 'mine')).ok).toBe(false)
    expect(priv.log.chosenToSave).toEqual([])
    const w = environment()
    expect(await exportBoostToFile(w.env, 'gone')).toEqual({ ok: false, message: 'Cette Retouche n’existe plus.' })
  })
})

describe('copying the link of a Tweak', () => {
  it('puts a link on the clipboard that reads back as the Tweak, and says so', async () => {
    const w = environment({ boosts: [stored({ name: 'Lecture' })] })
    expect(await copyBoostLink(w.env, 'mine')).toEqual({ ok: true, message: frenchSpaces('Lien de la Retouche « Lecture » copié') })
    expect(w.log.clipboardWrites).toHaveLength(1)
    const again = environment({ clipboard: w.log.clipboardWrites[0]! })
    expect((await importBoostFromClipboard(again.env)).ok).toBe(true)
    expect(again.state.boosts[0]).toMatchObject({ name: 'Lecture', css: 'p { color: teal }' })
    expect(w.log.toasts).toEqual([frenchSpaces('Lien de la Retouche « Lecture » copié')])
  })

  it('asks about a script before it goes on the clipboard', async () => {
    const boosts = [stored({ js: 'secret()' })]
    const w = environment({ boosts, exportChoice: 'cancel' })
    expect(await copyBoostLink(w.env, 'mine')).toMatchObject({ cancelled: true })
    expect(w.log.clipboardWrites).toEqual([])
    const without = environment({ boosts, exportChoice: 'without-script' })
    await copyBoostLink(without.env, 'mine')
    expect(without.log.clipboardWrites[0]).not.toContain(btoa('secret()'))
    const link = without.log.clipboardWrites[0]!
    const check = environment({ clipboard: link })
    await importBoostFromClipboard(check.env)
    expect(check.state.boosts[0]).toMatchObject({ js: '' })
  })

  it('reports a clipboard that refuses', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const w = environment({ boosts: [stored()], writeFails: true })
    expect(await copyBoostLink(w.env, 'mine')).toEqual({ ok: false, message: 'Le presse-papiers n’est pas accessible.' })
    expect(w.log.toasts).toEqual(['Le presse-papiers n’est pas accessible.'])
    expect(console.error).toHaveBeenCalled()
  })

  it('does not make a link of a Tweak that cannot be shared, nor in a private window', async () => {
    const w = environment({ boosts: [stored({ css: '@import "x";' })] })
    expect((await copyBoostLink(w.env, 'mine')).ok).toBe(false)
    expect(w.log.clipboardWrites).toEqual([])
    const priv = environment({ isPrivate: true, boosts: [stored()] })
    expect((await copyBoostLink(priv.env, 'mine')).ok).toBe(false)
    expect(priv.log.clipboardWrites).toEqual([])
  })
})

describe('with sharing switched off', () => {
  it('refuses every request before it opens a dialog, reads a file, touches the clipboard or changes anything', async () => {
    const w = environment({ settings: { boostSharing: false }, boosts: [stored()], files: { [FILE]: boostFileText(BOOST) }, clipboard: boostLink(BOOST) })
    const before = w.state
    const replies = [
      await importBoostFromFile(w.env),
      await importBoostFromClipboard(w.env),
      await exportBoostToFile(w.env, 'mine'),
      await copyBoostLink(w.env, 'mine'),
      await exportAllBoostsToFile(w.env),
      await exportThemeToFile(w.env, w.state.spaces[0]!.id),
      await importThemeFromFile(w.env, w.state.spaces[0]!.id)
    ]
    for (const reply of replies) expect(reply).toEqual({ ok: false, message: frenchSpaces('Le partage de Retouches et de thèmes est désactivé : Réglages › Extensions et outils › Plus de réglages › Partage des Retouches.') })
    expect(w.log.chosenToOpen + w.log.chosenToSave.length + w.log.reads.length + w.log.writes.length + w.log.clipboardWrites.length + w.log.previews.length + w.log.problems.length).toBe(0)
    expect(w.log.dispatched).toEqual([])
    expect(w.state).toBe(before)
  })

  it('is read at every request: switching it on again brings the feature back at once', async () => {
    const w = environment({ settings: { boostSharing: false }, files: { [FILE]: boostFileText(BOOST) } })
    expect((await importBoostFromFile(w.env)).ok).toBe(false)
    w.env.dispatch({ type: 'settings/update', patch: { boostSharing: true } })
    expect((await importBoostFromFile(w.env)).ok).toBe(true)
  })
})

describe('a share that fails', () => {
  it('is logged with its context, said in a toast, and answered with a sentence', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const toasts: string[] = []
    const reply = await answering(async () => {
      throw new Error('the window is gone')
    }, (message) => void toasts.push(message))
    expect(reply).toEqual({ ok: false, message: frenchSpaces('Le partage a échoué : the window is gone'), shown: true })
    expect(toasts).toEqual([frenchSpaces('Le partage a échoué : the window is gone')])
    expect(console.error).toHaveBeenCalledWith('[share] a share failed:', expect.any(Error))
  })

  it('gives the reply of a share that works as it is, without a toast', async () => {
    const toasts: string[] = []
    expect(await answering(async () => ({ ok: true, message: 'fait' }), (message) => void toasts.push(message))).toEqual({ ok: true, message: 'fait' })
    expect(toasts).toEqual([])
  })
})

describe('the requests of the interface', () => {
  it('reach the five actions', async () => {
    const files = { [FILE]: boostFileText(BOOST) }
    const w = environment({ files, boosts: [stored()], clipboard: boostLink(BOOST) })
    expect((await runBoostShareRequest(w.env, { kind: 'import-file' })).ok).toBe(true)
    expect((await runBoostShareRequest(w.env, { kind: 'import-link' })).ok).toBe(true)
    expect((await runBoostShareRequest(w.env, { kind: 'export-file', boostId: 'mine' })).ok).toBe(true)
    expect((await runBoostShareRequest(w.env, { kind: 'copy-link', boostId: 'mine' })).ok).toBe(true)
    expect(await runBoostShareRequest(w.env, { kind: 'export-all' })).toEqual({ ok: true, message: '3 Retouches exportées' })
    expect(w.state.boosts.map((b) => b.id)).toEqual(['mine', 'import-1', 'import-2'])
  })
})

describe('a theme as a file', () => {
  const DRACULA = READY_THEMES[0]!.theme
  const THEME_PATH = '/tmp/dracula.lucium-theme'

  it('exports the theme of a space under a name made of its own, in a file that reads back as it', async () => {
    const w = environment()
    const space = w.state.spaces[0]!
    const reply = await exportThemeToFile(w.env, space.id)
    expect(reply).toEqual({ ok: true, message: frenchSpaces(`Thème de « ${space.name} » exporté`) })
    expect(w.log.chosenToSave[0]).toMatchObject({ extension: 'lucium-theme', name: expect.stringMatching(/\.lucium-theme$/) })
    expect(JSON.parse(w.log.writes[0]!.text)).toEqual({ format: 1, kind: 'theme', name: space.name, code: encodeThemeCode(space.theme) })
  })

  it('applies the theme of a file to the space, after the person has seen it, and only to that space', async () => {
    const w = environment({ openChoice: THEME_PATH, files: { [THEME_PATH]: themeFileText(DRACULA, 'Dracula') } })
    const space = w.state.spaces[0]!
    const reply = await importThemeFromFile(w.env, space.id)
    expect(reply).toEqual({ ok: true, message: frenchSpaces('Thème « Dracula » appliqué') })
    expect(w.log.themeSheets[0]!.message).toBe(frenchSpaces(`Appliquer le thème « Dracula » à l’espace « ${space.name} » ?`))
    expect(encodeThemeCode(w.state.spaces[0]!.theme)).toBe(encodeThemeCode(DRACULA))
    expect(w.log.dispatched.map((a) => a.type)).toEqual(['space/update'])
    expect(w.log.reads).toEqual([{ path: THEME_PATH, max: THEME_FILE_MAX_BYTES }])
  })

  it('shows the theme in French on the sheet: its colours, harmony, appearance and texture', async () => {
    const w = environment({ openChoice: THEME_PATH, files: { [THEME_PATH]: themeFileText(DRACULA, 'Dracula') } })
    await importThemeFromFile(w.env, w.state.spaces[0]!.id)
    const detail = w.log.themeSheets[0]!.detail
    expect(detail).toContain(frenchSpaces(`Couleurs : ${DRACULA.baseColors.join(', ')}`))
    expect(detail).toMatch(/Harmonie\u00a0: (complémentaire|analogue|triade|monochrome|libre)\n/)
    expect(detail).toMatch(/Apparence\u00a0: (automatique|claire|sombre)\n/)
    expect(detail).toMatch(/Texture\u00a0: (aucune|grain|fine|grossière)\n/)
    expect(detail).toContain('ne contient aucun script ni aucune adresse')
    expect(describeTheme({ ...DRACULA, harmony: 'custom', appearance: 'auto', overlay: 'coarse' })).toBe(frenchSpaces(`Couleurs : ${DRACULA.baseColors.join(', ')}\nHarmonie : libre\nApparence : automatique\nTexture : grossière`))
  })

  it('changes nothing when the person says no or closes the dialog', async () => {
    const refused = environment({ themeAgrees: false, files: { '/tmp/boost.lucium-boost': themeFileText(DRACULA, 'Dracula') } })
    const before = refused.state
    expect(await importThemeFromFile(refused.env, refused.state.spaces[0]!.id)).toMatchObject({ cancelled: true })
    expect(refused.state).toBe(before)
    const closed = environment({ openChoice: null })
    expect(await importThemeFromFile(closed.env, closed.state.spaces[0]!.id)).toMatchObject({ cancelled: true })
  })

  it.each<[string, string, RegExp]>([
    ['a Tweak', boostFileText(BOOST), /contient une Retouche/],
    ['not JSON', 'luc1_bd93f9', /n’est pas du JSON/],
    ['a hostile code', JSON.stringify({ format: 1, kind: 'theme', code: 'luc1_bd93f9;}body{display:none}_custom_155_85_grain_10_light_vivid_dark' }), /code du thème/],
    ['a colour', JSON.stringify({ format: 1, kind: 'theme', code: '#ff0000' }), /code du thème/],
    ['as big as a Tweak', JSON.stringify({ format: 1, kind: 'theme', code: encodeThemeCode(DRACULA), note: 'x'.repeat(THEME_FILE_MAX_BYTES) }), /trop volumineux/]
  ])('refuses %s, with the reason, and changes nothing', async (_name, text, sentence) => {
    const w = environment({ files: { '/tmp/boost.lucium-boost': text } })
    const before = w.state
    const reply = await importThemeFromFile(w.env, w.state.spaces[0]!.id)
    expect(reply.ok).toBe(false)
    expect(reply.message).toMatch(sentence)
    expect(w.state).toBe(before)
    expect(w.log.themeSheets).toEqual([])
    expect(w.log.problems[0]!.title).toBe('Thème refusé')
  })

  it('refuses a file the reader could not read, a space that is gone, and a private window', async () => {
    const big = environment({ files: { '/tmp/boost.lucium-boost': { ok: false, reason: 'too-large' } } })
    expect((await importThemeFromFile(big.env, big.state.spaces[0]!.id)).message).toMatch(/trop volumineux/)
    const w = environment({ files: { '/tmp/boost.lucium-boost': themeFileText(DRACULA, '') } })
    expect(await importThemeFromFile(w.env, 'gone')).toEqual({ ok: false, message: 'Cet espace n’existe plus.' })
    expect(await exportThemeToFile(w.env, 'gone')).toEqual({ ok: false, message: 'Cet espace n’existe plus.' })
    // Said before any dialog is opened for a space that is not there.
    expect(w.log.chosenToOpen + w.log.chosenToSave.length).toBe(0)
    const priv = environment({ isPrivate: true })
    expect((await importThemeFromFile(priv.env, priv.state.spaces[0]!.id)).ok).toBe(false)
    expect((await exportThemeToFile(priv.env, priv.state.spaces[0]!.id)).ok).toBe(false)
    expect(priv.log.chosenToOpen + priv.log.chosenToSave.length).toBe(0)
  })

  it('applies nothing when the window turns private, or the space goes, while the sheet is open', async () => {
    for (const change of ['private', 'gone'] as const) {
      const w = environment({ openChoice: THEME_PATH, files: { [THEME_PATH]: themeFileText(DRACULA, 'Dracula') } })
      const space = w.state.spaces[0]!
      w.env.confirmThemeImport = async () => {
        if (change === 'private') w.becomePrivate()
        else w.env.dispatch({ type: 'space/create', name: 'Autre', emoji: '📁', hue: 10 })
        if (change === 'gone') w.env.dispatch({ type: 'space/delete', id: space.id })
        return true
      }
      const before = w.log.dispatched.length
      const reply = await importThemeFromFile(w.env, space.id)
      expect(reply.ok, change).toBe(false)
      // Only what the test itself dispatched: the import applied no theme.
      expect(w.log.dispatched.slice(before).filter((a) => a.type === 'space/update'), change).toEqual([])
    }
  })

  it('says when the file cannot be written, and logs it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const w = environment({ fileWriteFails: true })
    const reply = await exportThemeToFile(w.env, w.state.spaces[0]!.id)
    expect(reply.ok).toBe(false)
    expect(console.error).toHaveBeenCalled()
    expect(w.log.toasts).toEqual([])
  })

  it('reaches both actions from the requests of the interface', async () => {
    const w = environment({ files: { '/tmp/boost.lucium-boost': themeFileText(DRACULA, 'Dracula') } })
    const id = w.state.spaces[0]!.id
    expect((await runThemeFileRequest(w.env, { kind: 'export-file', spaceId: id })).ok).toBe(true)
    expect((await runThemeFileRequest(w.env, { kind: 'import-file', spaceId: id })).ok).toBe(true)
  })
})

describe('exporting all the Tweaks as one file', () => {
  const A = stored({ id: 'a', name: 'Lecture', host: 'a.example.com', enabled: false })
  const B = stored({ id: 'b', name: 'Avec script', host: 'b.example.com', js: 'document.title = "b"', jsEnabled: true })
  const C = stored({ id: 'c', name: 'Autre', host: 'c.example.com', zoom: 1.4, zap: ['#ad'] })
  const ALL = [A, B, C]
  const written = (w: ReturnType<typeof environment>) => parseBoostFiles(w.log.writes[0]!.text)

  it('writes every Tweak into the one file the person names, and says how many', async () => {
    const w = environment({ boosts: [A, C] })
    expect(await exportAllBoostsToFile(w.env)).toEqual({ ok: true, message: '2 Retouches exportées' })
    expect(w.log.chosenToSave).toEqual([{ title: 'Exporter toutes les Retouches', name: 'retouches-lucium.lucium-boost', extension: 'lucium-boost' }])
    expect(w.log.writes).toHaveLength(1)
    expect(w.log.writes[0]!.path).toBe('/tmp/out.lucium-boost')
    expect(written(w)).toMatchObject({ ok: true, bundle: true, boosts: [{ name: 'Lecture', host: 'a.example.com' }, { name: 'Autre', host: 'c.example.com', zoom: 1.4, zap: ['#ad'] }] })
    expect(w.log.toasts).toEqual(['2 Retouches exportées'])
    // No script: nothing to warn about.
    expect(w.log.exportSheets).toEqual([])
    expect(w.log.problems).toEqual([])
  })

  it('says "1 Retouche exportée" for one', async () => {
    const w = environment({ boosts: [A] })
    expect((await exportAllBoostsToFile(w.env)).message).toBe('1 Retouche exportée')
  })

  it('asks about the scripts once for the whole file, naming the Tweaks that have one', async () => {
    const w = environment({ boosts: [A, B, stored({ id: 'd', name: 'Second script', host: 'd.example.com', js: 'x()' }), C] })
    await exportAllBoostsToFile(w.env)
    expect(w.log.exportSheets).toHaveLength(1)
    expect(w.log.exportSheets[0]).toMatchObject({ scripted: ['Avec script', 'Second script'] })
    expect(w.log.exportSheets[0]!.warning).toContain('lisible par quiconque')
  })

  it('leaves every script out when the person says so, and puts them in when the person says so', async () => {
    const without = environment({ boosts: ALL, exportChoice: 'without-script' })
    expect((await exportAllBoostsToFile(without.env)).ok).toBe(true)
    const noScript = written(without)
    expect(noScript.ok && noScript.boosts.map((b) => b.js)).toEqual(['', '', ''])
    expect(without.log.writes[0]!.text).not.toContain('document.title')

    const withScript = environment({ boosts: ALL, exportChoice: 'with-script' })
    await exportAllBoostsToFile(withScript.env)
    const scripts = written(withScript)
    expect(scripts.ok && scripts.boosts.map((b) => b.js)).toEqual(['', 'document.title = "b"', ''])
  })

  it('writes nothing and asks for no file when the person cancels at the sheet of the scripts', async () => {
    const w = environment({ boosts: ALL, exportChoice: 'cancel' })
    expect(await exportAllBoostsToFile(w.env)).toEqual({ ok: false, message: '', cancelled: true })
    expect(w.log.chosenToSave).toEqual([])
    expect(w.log.writes).toEqual([])
    expect(w.log.toasts).toEqual([])
  })

  it('says nothing and writes nothing when the person closes the dialog of the file', async () => {
    const w = environment({ boosts: ALL, saveChoice: null })
    expect(await exportAllBoostsToFile(w.env)).toEqual({ ok: false, message: '', cancelled: true })
    expect(w.log.writes).toEqual([])
    expect(w.log.toasts).toEqual([])
    expect(w.log.problems).toEqual([])
  })

  it('has nothing to export without a Tweak: a sentence, no dialog', async () => {
    const w = environment({ boosts: [] })
    expect(await exportAllBoostsToFile(w.env)).toEqual({ ok: false, message: 'Aucune Retouche à exporter.' })
    expect(w.log.chosenToSave).toEqual([])
    expect(w.log.exportSheets).toEqual([])
  })

  it('is not available in a private window', async () => {
    const w = environment({ boosts: ALL, isPrivate: true })
    expect(await exportAllBoostsToFile(w.env)).toEqual({ ok: false, message: 'Le partage de Retouches et de thèmes n’est pas disponible dans une fenêtre privée.' })
    expect(w.log.writes).toEqual([])
  })

  it('leaves out a Tweak that cannot be shared, writes the others, and names it with its reason', async () => {
    const hostile = stored({ id: 'u', name: 'Fond distant', host: 'u.example.com', css: 'body { background: url(https://cdn.example/bg.png) }' })
    const w = environment({ boosts: [A, hostile, C] })
    const reply = await exportAllBoostsToFile(w.env)
    expect(reply).toEqual({ ok: true, message: '2 Retouches exportées' })
    expect(written(w)).toMatchObject({ ok: true, boosts: [{ name: 'Lecture' }, { name: 'Autre' }] })
    expect(w.log.problems).toHaveLength(1)
    expect(w.log.problems[0]!.title).toBe('1 Retouche n’est pas dans le fichier')
    expect(w.log.problems[0]!.sentence).toMatch(/^• Fond distant\u00a0: Le CSS contient une adresse url/)
  })

  it('writes no file when no Tweak can be shared, and says why for each', async () => {
    const hostile = (n: number) => stored({ id: `u${n}`, name: `Distant ${n}`, host: `u${n}.example.com`, css: '@import "x.css"' })
    const w = environment({ boosts: [hostile(1), hostile(2)] })
    const reply = await exportAllBoostsToFile(w.env)
    expect(reply).toMatchObject({ ok: false, shown: true })
    expect(w.log.chosenToSave).toEqual([])
    expect(w.log.writes).toEqual([])
    expect(w.log.problems[0]!.sentence).toMatch(/• Distant 1\u00a0: .*\n• Distant 2\u00a0: /s)
  })

  it('writes nothing, and says so, when there are more Tweaks than a file may hold', async () => {
    const many = Array.from({ length: BOOST_BUNDLE_MAX + 1 }, (_, i) => stored({ id: `m${i}`, name: `M ${i}`, host: `m${i}.example.com` }))
    const w = environment({ boosts: many })
    const reply = await exportAllBoostsToFile(w.env)
    expect(reply).toMatchObject({ ok: false, shown: true })
    expect(w.log.problems[0]!.sentence).toContain(`${BOOST_BUNDLE_MAX + 1}`)
    expect(w.log.chosenToSave).toEqual([])
    expect(w.log.writes).toEqual([])
  })

  it('says why when the file cannot be written, and does not announce an export that did not happen', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const w = environment({ boosts: ALL, fileWriteFails: true })
    const reply = await exportAllBoostsToFile(w.env)
    expect(reply).toMatchObject({ ok: false, shown: true })
    expect(w.log.problems[0]).toMatchObject({ title: 'Export impossible' })
    expect(w.log.problems[0]!.sentence).toContain('disk full')
    expect(w.log.toasts).toEqual([])
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('cannot write'), expect.any(Error))
  })
})

describe('a file of all the Tweaks, exported then imported', () => {
  const OUT = '/tmp/all.lucium-boost'
  const mine = [
    stored({ id: 'a', name: 'Lecture', host: 'a.example.com', enabled: false, css: 'p { line-height: 1.7 }', zoom: 1.2, zap: ['#cookies'], fontFamily: 'inter', textCase: 'upper', invert: true }),
    stored({ id: 'b', name: 'Avec script', host: 'b.example.com', js: 'document.title = "b"', jsEnabled: true }),
    stored({ id: 'c', name: 'Lecture', host: 'a.example.com', css: 'h1 { color: tomato }' })
  ]
  /** What the other person's profile has after the file is imported, and the sheet it was shown. */
  const roundTrip = async (exportChoice: ExportChoice, importOptions: Options = {}) => {
    const from = environment({ boosts: mine, exportChoice })
    await exportAllBoostsToFile(from.env)
    const text = from.log.writes[0]!.text
    const to = environment({ ...importOptions, files: { [OUT]: text }, openChoice: OUT })
    const reply = await importBoostFromFile(to.env)
    return { from, to, reply, text }
  }
  const plain = (b: Boost) => ({ name: b.name, host: b.host, css: b.css, js: b.js, zoom: b.zoom, zap: b.zap, fontFamily: b.fontFamily, textCase: b.textCase, invert: b.invert })

  it('gives the other profile the same Tweaks, switched on, with each script switched off, under new ids', async () => {
    const { to, reply } = await roundTrip('with-script')
    expect(reply).toEqual({ ok: true, message: '3 Retouches installées · JavaScript désactivé' })
    expect(to.log.previews).toHaveLength(1)
    expect(to.log.previews[0]).toMatchObject({ message: frenchSpaces('Installer 3 Retouches ?'), hasScript: true })
    expect(to.log.dispatched.map((a) => a.type)).toEqual(['boost/import', 'boost/import', 'boost/import'])
    expect(to.state.boosts.map(plain)).toEqual(mine.map(plain).map((b) => (b.name === 'Lecture' && b.css.startsWith('h1') ? { ...b, name: 'Lecture (2)' } : b)))
    expect(to.state.boosts.every((b) => b.enabled && b.id.startsWith('import-'))).toBe(true)
    // The script came, and does not run until the person has read it and turned it on.
    expect(to.state.boosts.map((b) => b.jsEnabled)).toEqual([undefined, false, undefined])
    expect(to.state.boosts[1]!.js).toBe('document.title = "b"')
    expect(to.log.toasts).toEqual(['3 Retouches installées · JavaScript désactivé'])
  })

  it('gives the other profile no script when it was left out of the file', async () => {
    const { to, reply } = await roundTrip('without-script')
    expect(reply).toEqual({ ok: true, message: '3 Retouches installées' })
    expect(to.log.previews[0]).toMatchObject({ hasScript: false, scriptDropped: false })
    expect(to.state.boosts.map((b) => b.js)).toEqual(['', '', ''])
    expect(to.state.boosts.map((b) => b.jsEnabled)).toEqual([undefined, undefined, undefined])
  })

  it('leaves the scripts out at the sheet when the person asks for that', async () => {
    const { to, reply } = await roundTrip('with-script', { importChoice: 'install-without-script' })
    expect(reply).toEqual({ ok: true, message: '3 Retouches installées' })
    expect(to.state.boosts.map((b) => b.js)).toEqual(['', '', ''])
  })

  it('keeps the scripts out when the setting says never, whatever the file holds', async () => {
    const { to, reply } = await roundTrip('with-script', { settings: { boostScriptImport: 'never' } })
    expect(reply.ok).toBe(true)
    expect(to.log.previews[0]).toMatchObject({ hasScript: false, scriptDropped: true })
    expect(to.state.boosts.map((b) => b.js)).toEqual(['', '', ''])
  })

  it('installs nothing when the person says no at the sheet', async () => {
    const { to, reply } = await roundTrip('with-script', { importChoice: 'cancel' })
    expect(reply).toEqual({ ok: false, message: '', cancelled: true })
    expect(to.log.dispatched).toEqual([])
    expect(to.state.boosts).toEqual([])
  })

  it('installs nothing when the window turns private while the sheet is open', async () => {
    const from = environment({ boosts: mine, exportChoice: 'with-script' })
    await exportAllBoostsToFile(from.env)
    const to = environment({ files: { [OUT]: from.log.writes[0]!.text }, openChoice: OUT })
    to.env.confirmImport = async () => {
      to.becomePrivate()
      return 'install'
    }
    expect((await importBoostFromFile(to.env)).ok).toBe(false)
    expect(to.log.dispatched).toEqual([])
  })

  it('refuses the whole file for one Tweak that is not acceptable, names it, and installs none of the others', async () => {
    const { text } = await roundTrip('with-script')
    const edited = JSON.parse(text) as { boosts: Array<Record<string, unknown>> }
    edited.boosts[1]!['css'] = 'body { background: url(https://cdn.example/bg.png) }'
    const to = environment({ files: { [OUT]: JSON.stringify(edited) }, openChoice: OUT })
    const reply = await importBoostFromFile(to.env)
    expect(reply).toMatchObject({ ok: false, shown: true })
    expect(to.log.problems).toHaveLength(1)
    expect(to.log.problems[0]!.title).toBe('Retouche refusée')
    expect(to.log.problems[0]!.sentence).toMatch(/^Retouche n° 2 «\u00a0Avec script\u00a0»\u00a0: Le CSS contient une adresse url/)
    expect(to.log.previews).toEqual([])
    expect(to.log.dispatched).toEqual([])
    expect(to.state.boosts).toEqual([])
  })

  it('refuses the whole file when one Tweak aims at a whole family of sites, and names it', async () => {
    const { text } = await roundTrip('with-script')
    const edited = JSON.parse(text) as { boosts: Array<Record<string, unknown>> }
    edited.boosts[2]!['host'] = 'co.uk'
    const to = environment({ files: { [OUT]: JSON.stringify(edited) }, openChoice: OUT })
    const reply = await importBoostFromFile(to.env)
    expect(reply).toMatchObject({ ok: false, shown: true })
    expect(to.log.problems[0]!.sentence).toMatch(/^Retouche n° 3 «\u00a0Lecture\u00a0»\u00a0: Le site visé \(«\u00a0co\.uk\u00a0»\) est trop large/)
    expect(to.log.previews).toEqual([])
    expect(to.log.dispatched).toEqual([])
  })

  it('refuses a file of more Tweaks than a file may hold, and one over the size bound, before anything is shown', async () => {
    const entries = Array.from({ length: BOOST_BUNDLE_MAX + 1 }, (_, i) => ({ ...BOOST, host: `site${i}.example.com` }))
    const many = environment({ files: { [OUT]: JSON.stringify({ format: 1, kind: 'boosts', boosts: entries }) }, openChoice: OUT })
    const manyReply = await importBoostFromFile(many.env)
    expect(manyReply).toMatchObject({ ok: false, shown: true })
    expect(many.log.problems[0]!.sentence).toContain('trop de Retouches')
    expect(many.log.previews).toEqual([])

    const huge = environment({ files: { [OUT]: { ok: false, reason: 'too-large' } }, openChoice: OUT })
    expect(await importBoostFromFile(huge.env)).toMatchObject({ ok: false, shown: true })
    expect(huge.log.problems[0]!.sentence).toContain(frenchSpaces(`${BOOST_BUNDLE_MAX_BYTES / 1024} Ko`))
    expect(huge.log.reads).toEqual([{ path: OUT, max: BOOST_BUNDLE_MAX_BYTES }])
    expect(huge.log.dispatched).toEqual([])
  })

  it('installs a full file of the most Tweaks a file may hold', async () => {
    const entries = Array.from({ length: BOOST_BUNDLE_MAX }, (_, i) => ({ ...BOOST, name: `B${i}`, host: `site${i}.example.com` }))
    const to = environment({ files: { [OUT]: JSON.stringify({ format: 1, kind: 'boosts', boosts: entries }) }, openChoice: OUT })
    expect(await importBoostFromFile(to.env)).toEqual({ ok: true, message: `${BOOST_BUNDLE_MAX} Retouches installées` })
    expect(to.state.boosts).toHaveLength(BOOST_BUNDLE_MAX)
  })

  it('says how many were installed when the reducer refuses some, and logs it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { text } = await roundTrip('with-script')
    const to = environment({ files: { [OUT]: text }, openChoice: OUT })
    // A reducer that drops the second Tweak only.
    const dispatch = to.env.dispatch
    to.env.dispatch = (action) => (action.type === 'boost/import' && action.boost.name === 'Avec script' ? void to.log.dispatched.push(action) : dispatch(action))
    const reply = await importBoostFromFile(to.env)
    expect(reply).toEqual({ ok: true, message: '2 Retouches installées sur 3' })
    expect(to.state.boosts).toHaveLength(2)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('1 of the 3 Tweaks'))
  })

  it('says it when the reducer refuses all of them', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { text } = await roundTrip('with-script')
    const to = environment({ files: { [OUT]: text }, openChoice: OUT })
    to.env.dispatch = (action) => void to.log.dispatched.push(action)
    expect(await importBoostFromFile(to.env)).toEqual({ ok: false, message: 'Cette Retouche n’a pas pu être installée.', shown: true })
    expect(to.log.toasts).toEqual([])
  })

  it('is read by "Coller une Retouche" no better than any other text: a link holds one Tweak, not a file of several', async () => {
    const { text } = await roundTrip('with-script')
    const to = environment({ clipboard: text })
    const reply = await importBoostFromClipboard(to.env)
    expect(reply).toMatchObject({ ok: false, shown: true })
    expect(to.log.dispatched).toEqual([])
  })
})

describe('the theme of a locked space and a theme file', () => {
  const LOCKED = frenchSpaces('Cet espace est verrouillé : déverrouillez-le d’abord.')
  const DRACULA = READY_THEMES[0]!.theme

  it('asks for no file and applies nothing while the space is locked', async () => {
    const w = environment({ openChoice: '/tmp/dracula.lucium-theme', files: { '/tmp/dracula.lucium-theme': themeFileText(DRACULA, 'Dracula') } })
    const space = w.state.spaces[0]!
    w.env.lockedSpaces = () => [space.id]
    const before = w.state
    expect(await importThemeFromFile(w.env, space.id)).toEqual({ ok: false, message: LOCKED })
    expect(w.log.chosenToOpen + w.log.reads.length + w.log.themeSheets.length).toBe(0)
    expect(w.log.dispatched).toEqual([])
    expect(w.state).toBe(before)
  })

  it('applies nothing when the space is locked while the sheet is being read', async () => {
    const w = environment({ openChoice: '/tmp/dracula.lucium-theme', files: { '/tmp/dracula.lucium-theme': themeFileText(DRACULA, 'Dracula') } })
    const space = w.state.spaces[0]!
    // Free when the request comes, locked from the moment the sheet has been shown.
    w.env.lockedSpaces = () => (w.log.themeSheets.length > 0 ? [space.id] : [])
    expect(await importThemeFromFile(w.env, space.id)).toEqual({ ok: false, message: LOCKED })
    expect(w.log.themeSheets).toHaveLength(1)
    expect(w.log.dispatched).toEqual([])
  })
})
