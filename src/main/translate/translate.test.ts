import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { constants as zlibConstants, zstdCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings, type Settings } from '@shared/model'
import { setLanguage } from '@shared/i18n'
import { ATTACHMENTS_HOST, RUNTIME_CATALOGUE_URL, catalogueUrl, type DownloadPlan, type PackManifest } from '@shared/translate-local'
import { el, fakePage, text as textNode, type FakePage } from '@shared/translate-test-support'
import { createBergamotEngine, type StartWorker, type WorkerLike } from './bergamot'
import { TranslateController, type TranslateDeps } from './controller'
import { TranslationMemory } from './memory'
import { downloadPack, downloadRuntime, sweepStaging, type Fetch } from './download'
import { EngineRegistry, glossaryEngine, parseGlossary, translateWords, type TranslationEngine } from './engines'
import { adoptFolder, fingerprint, listPacks, packDirOf, readManifest, readRuntime, readRuntimeManifest, removePack, verifyPack } from './pack-store'
import { frenchSpaces } from '@shared/french-typography'
import { onWindows } from '../windows.test-support'

const sha = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex')
/** The engines here need no binary of their own. */
const CTX = { runtimeDir: '/nonexistent/translation-engine' }
const dirs: string[] = []
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'lucium-translate-'))
  dirs.push(dir)
  return dir
}
beforeEach(() => setLanguage('fr'))
afterEach(() => {
  setLanguage('fr')
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Writes a pack folder the way an installation does: the files, then the manifest. */
function writePack(root: string, from: string, to: string, engine: 'glossary' | 'bergamot', files: Record<string, { role: string; data: string }>): PackManifest {
  const dir = join(root, `${from}-${to}`)
  mkdirSync(dir, { recursive: true })
  for (const [name, { data }] of Object.entries(files)) writeFileSync(join(dir, name), data)
  const manifest = { schema: 1, engine, from, to, version: '1', files: Object.entries(files).map(([name, { role, data }]) => ({ role, name, size: Buffer.byteLength(data), sha256: sha(data) })) } as PackManifest
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
  return manifest
}
const glossaryPack = (root: string, from: string, to: string, entries: Record<string, string>) => writePack(root, from, to, 'glossary', { [`${from}-${to}.glossary.json`]: { role: 'glossary', data: JSON.stringify({ entries }) } })

describe('the glossary engine', () => {
  it('reads a dictionary file and nothing else', () => {
    expect(parseGlossary({ entries: { Bonjour: 'hello' } })?.get('bonjour')).toBe('hello')
    for (const bad of [null, [], 'x', {}, { entries: [] }, { entries: {} }, { entries: { a: 3 } }, { entries: { '': 'x' } }, { entries: { a: 'x'.repeat(101) } }, { entries: { a: 'x\u0000' } }, { entries: { ['k'.repeat(101)]: 'x' } }]) expect(parseGlossary(bad), JSON.stringify(bad)).toBeNull()
  })

  it('replaces words one by one and keeps the case and the rest', () => {
    const glossary = parseGlossary({ entries: { bonjour: 'hello', monde: 'world', "l'ami": 'the friend' } })!
    expect(translateWords(glossary, frenchSpaces('Bonjour, monde ! BONJOUR le monde.'))).toBe(frenchSpaces('Hello, world ! HELLO le world.'))
    expect(translateWords(glossary, 'bonjour123 inconnu')).toBe('hello123 inconnu')
    expect(translateWords(glossary, '')).toBe('')
  })

  it('says why a pack cannot be loaded, and gives its model back', async () => {
    const root = tmp()
    const manifest = glossaryPack(root, 'fr', 'en', { bonjour: 'hello' })
    const model = await glossaryEngine.load(manifest, join(root, 'fr-en'), CTX)
    expect(await model.translate(['Bonjour'], new AbortController().signal)).toEqual(['Hello'])
    const stopped = new AbortController()
    stopped.abort()
    await expect(model.translate(['Bonjour'], stopped.signal)).rejects.toThrow('stopped')
    model.dispose()
    const broken = writePack(root, 'de', 'en', 'glossary', { 'de-en.glossary.json': { role: 'glossary', data: '{nope' } })
    await expect(glossaryEngine.load(broken, join(root, 'de-en'), CTX)).rejects.toThrow('glossary-json')
    const wrong = writePack(root, 'es', 'en', 'glossary', { 'es-en.glossary.json': { role: 'glossary', data: '[]' } })
    await expect(glossaryEngine.load(wrong, join(root, 'es-en'), CTX)).rejects.toThrow('glossary-shape')
  })
})

describe('the packs on disk', () => {
  it('lists only folders that are a pack of the pair they are named for', async () => {
    const root = tmp()
    glossaryPack(root, 'fr', 'en', { a: 'b' })
    mkdirSync(join(root, 'notes'))
    mkdirSync(join(root, 'de-en'))
    writeFileSync(join(root, 'de-en', 'manifest.json'), 'not json')
    // A manifest of another pair in a folder named for this one is not this pack.
    const other = writePack(root, 'es', 'en', 'glossary', { 'x.glossary.json': { role: 'glossary', data: '{"entries":{"a":"b"}}' } })
    mkdirSync(join(root, 'it-en'))
    writeFileSync(join(root, 'it-en', 'manifest.json'), JSON.stringify(other))
    writeFileSync(join(root, 'stray.txt'), 'x')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect((await listPacks(root)).map((p) => `${p.from}-${p.to}`)).toEqual(['es-en', 'fr-en'])
    // The unreadable manifest is not silent.
    expect(warn).toHaveBeenCalled()
    expect(await listPacks(join(root, 'absent'))).toEqual([])
  })

  it('refuses a manifest that is too big, and one that is not a file', async () => {
    const root = tmp()
    const real = glossaryPack(tmp(), 'fr', 'en', { a: 'b' })
    mkdirSync(join(root, 'fr-en'))
    // A manifest that is valid JSON and a valid manifest, but longer than a manifest has any reason to be: it is not read.
    writeFileSync(join(root, 'fr-en', 'manifest.json'), JSON.stringify(real) + ' '.repeat(70 * 1024))
    expect(await readManifest(join(root, 'fr-en'))).toBeNull()
    writeFileSync(join(root, 'fr-en', 'manifest.json'), JSON.stringify(real))
    expect(await readManifest(join(root, 'fr-en'))).toEqual(real)
    mkdirSync(join(root, 'de-en'))
    mkdirSync(join(root, 'de-en', 'manifest.json'))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(await readManifest(join(root, 'de-en'))).toBeNull()
  })

  it('checks size and fingerprint of every file, and says which one is wrong', async () => {
    const root = tmp()
    const manifest = glossaryPack(root, 'fr', 'en', { a: 'b' })
    const dir = join(root, 'fr-en')
    expect(await verifyPack(dir, manifest)).toEqual({ ok: true })
    const file = join(dir, 'fr-en.glossary.json')
    const original = readFileSync(file, 'utf8')
    // Same size, other content.
    writeFileSync(file, original.replace('"a"', '"z"'))
    expect(await verifyPack(dir, manifest)).toEqual({ ok: false, reason: 'fr-en.glossary.json: fingerprint' })
    writeFileSync(file, `${original} `)
    expect(await verifyPack(dir, manifest)).toEqual({ ok: false, reason: 'fr-en.glossary.json: size' })
    rmSync(file)
    expect(await verifyPack(dir, manifest)).toEqual({ ok: false, reason: 'fr-en.glossary.json: ENOENT' })
  })

  it('adopts the files a person placed: roles from the names, fingerprints from the files, manifest last', async () => {
    const root = tmp()
    const dir = join(root, 'fr-en')
    mkdirSync(dir)
    writeFileSync(join(dir, 'model.fren.intgemm.alphas.bin'), 'MODEL')
    writeFileSync(join(dir, 'vocab.fren.spm'), 'VOCAB')
    writeFileSync(join(dir, 'lex.50.50.fren.s2t.bin'), 'LEX')
    writeFileSync(join(dir, 'readme.txt'), 'ignored')
    const adopted = await adoptFolder(root, 'fr', 'en')
    expect(adopted.ok).toBe(true)
    const manifest = await readManifest(dir, 'fr', 'en')
    expect(manifest?.engine).toBe('bergamot')
    expect(manifest?.files.map((f) => [f.role, f.sha256])).toEqual([['lex', sha('LEX')], ['model', sha('MODEL')], ['vocab', sha('VOCAB')]])
    expect((await listPacks(root))[0]).toMatchObject({ from: 'fr', to: 'en', bytes: 13 })
    expect(await adoptFolder(root, 'de', 'en')).toEqual({ ok: false, reason: 'no-folder' })
    mkdirSync(join(root, 'it-en'))
    writeFileSync(join(root, 'it-en', 'model.iten.bin'), 'M')
    expect(await adoptFolder(root, 'it', 'en')).toEqual({ ok: false, reason: 'incomplete' })
    expect(existsSync(join(root, 'it-en', 'manifest.json'))).toBe(false)
    expect(await adoptFolder(root, '../x', 'en')).toEqual({ ok: false, reason: 'pair' })
  })

  it('does not remove a folder named like a pair that holds no pack: what the person had in the folder they chose stays', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const root = tmp()
    mkdirSync(join(root, 'it-en'))
    writeFileSync(join(root, 'it-en', 'notes.txt'), 'mine')
    expect(await removePack(root, 'it', 'en')).toEqual({ ok: false, reason: 'not-a-pack' })
    expect(readdirSync(join(root, 'it-en'))).toEqual(['notes.txt'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('holds no pack of this application'))
    // A pair with no folder at all has nothing to remove, and that is not a failure.
    expect(await removePack(root, 'de', 'en')).toEqual({ ok: true })
  })

  it('removes the folder of a pair and nothing else', async () => {
    const root = tmp()
    glossaryPack(root, 'fr', 'en', { a: 'b' })
    glossaryPack(root, 'de', 'en', { a: 'b' })
    expect(await removePack(root, 'fr', 'en')).toEqual({ ok: true })
    expect(readdirSync(root)).toEqual(['de-en'])
    expect(await removePack(root, '..', 'en')).toEqual({ ok: false, reason: 'pair' })
    expect(await removePack(root, 'fr', 'fr')).toEqual({ ok: false, reason: 'pair' })
    expect(readdirSync(root)).toEqual(['de-en'])
    expect((await fingerprint(join(root, 'de-en', 'manifest.json'))).size).toBeGreaterThan(10)
  })
})

// ---------- downloads ----------

const FILES = { model: 'MODEL-BYTES-'.repeat(40), vocab: 'VOCAB-BYTES-'.repeat(20) }
function plan(over: Partial<DownloadPlan> = {}): DownloadPlan {
  const files = [
    { role: 'model' as const, name: 'model.fren.bin', url: `https://${ATTACHMENTS_HOST}/main-workspace/models/m.bin`, size: Buffer.byteLength(FILES.model), sha256: sha(FILES.model) },
    { role: 'vocab' as const, name: 'vocab.fren.spm', url: `https://${ATTACHMENTS_HOST}/main-workspace/models/v.spm`, size: Buffer.byteLength(FILES.vocab), sha256: sha(FILES.vocab) }
  ]
  const totalBytes = files.reduce((n, f) => n + f.size, 0)
  return { engine: 'bergamot', from: 'fr', to: 'en', version: '2.1', files, totalBytes, diskBytes: totalBytes, ...over }
}
const body = (data: string | Uint8Array): ReadableStream<Uint8Array> => {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  return new ReadableStream({
    start(controller) {
      // Two chunks, as a network gives them.
      controller.enqueue(bytes.slice(0, Math.ceil(bytes.length / 2)))
      controller.enqueue(bytes.slice(Math.ceil(bytes.length / 2)))
      controller.close()
    }
  })
}
const server = (routes: Record<string, string | Uint8Array | Response>): { fetch: Fetch; calls: Array<{ url: string; redirect: string; credentials: string; cache: string }> } => {
  const calls: Array<{ url: string; redirect: string; credentials: string; cache: string }> = []
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, redirect: init.redirect, credentials: init.credentials, cache: init.cache })
      const found = routes[url]
      if (found === undefined) return new Response('not found', { status: 404 })
      return found instanceof Response ? found : new Response(body(found), { status: 200, headers: { 'content-length': String(typeof found === 'string' ? Buffer.byteLength(found) : found.length) } })
    }
  }
}
const goodRoutes = () => ({ [`https://${ATTACHMENTS_HOST}/main-workspace/models/m.bin`]: FILES.model, [`https://${ATTACHMENTS_HOST}/main-workspace/models/v.spm`]: FILES.vocab })

describe('downloading a pack', () => {
  it('moves beside, and never deletes, a folder of the name of the pair that is not a pack', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const root = tmp()
    mkdirSync(join(root, 'fr-en'))
    writeFileSync(join(root, 'fr-en', 'thesis.txt'), 'mine')
    expect(await downloadPack(plan(), root, server(goodRoutes()).fetch)).toEqual({ ok: true })
    expect((await readManifest(join(root, 'fr-en'), 'fr', 'en'))?.engine).toBe('bergamot')
    const kept = readdirSync(root).filter((name) => name.startsWith('fr-en.kept-'))
    expect(kept).toHaveLength(1)
    expect(readFileSync(join(root, kept[0]!, 'thesis.txt'), 'utf8')).toBe('mine')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('is not a pack of this application'))
    // The folder kept beside is not taken for a pack.
    expect((await listPacks(root)).map((pack) => pack.folder)).toEqual(['fr-en'])
  })

  it('fetches exactly the files of the plan, keeps them only once each is checked, and writes the manifest last', async () => {
    const root = tmp()
    const net = server(goodRoutes())
    const progress: number[] = []
    expect(await downloadPack(plan(), root, net.fetch, { progress: (done) => progress.push(done) })).toEqual({ ok: true })
    expect(net.calls.map((c) => c.url)).toEqual(plan().files.map((f) => f.url))
    // No cookie, no redirect: the address shown is the address used. Nothing kept in the disk cache of the interface's session either.
    expect(net.calls.every((c) => c.redirect === 'error' && c.credentials === 'omit' && c.cache === 'no-store')).toBe(true)
    expect(readdirSync(root)).toEqual(['fr-en'])
    expect(readdirSync(join(root, 'fr-en')).sort()).toEqual(['manifest.json', 'model.fren.bin', 'vocab.fren.spm'])
    expect(await verifyPack(join(root, 'fr-en'), (await readManifest(join(root, 'fr-en'), 'fr', 'en'))!)).toEqual({ ok: true })
    expect(progress.at(-1)).toBe(plan().totalBytes)
  })

  it('sweeps the staging folders a crash left in the models folder, before and by itself, and nothing else; never one of a download running now', async () => {
    const root = tmp()
    glossaryPack(root, 'fr', 'en', { a: 'b' })
    const stale = ['.download-fr-en-0b8e5c1a-6d2f-4c1e-9a77-3d1f2e4b5a60', '.download-de-en-6f1d2c3b-4a5e-4f60-8b71-92a3b4c5d6e7']
    for (const name of stale) {
      mkdirSync(join(root, name))
      writeFileSync(join(root, name, 'model.bin'), 'half a model')
    }
    // Not staging folders: a pack, a file the user keeps there, a folder that only looks alike.
    mkdirSync(join(root, '.download-notes'))
    writeFileSync(join(root, 'stray.txt'), 'x')
    expect(await sweepStaging(root)).toBe(2)
    expect(readdirSync(root).sort()).toEqual(['.download-notes', 'fr-en', 'stray.txt'])
    // A download sweeps the leftovers of an earlier one as it starts.
    mkdirSync(join(root, stale[0]!))
    await downloadPack(plan({ from: 'es', to: 'en' }), root, server(goodRoutes()).fetch)
    expect(readdirSync(root).filter((name) => name === stale[0])).toEqual([])
    // Nothing to look in: nothing said, nothing made.
    expect(await sweepStaging(join(root, 'absent'))).toBe(0)
  })

  it('does not sweep the staging folder of a download that is running', async () => {
    const root = tmp()
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const slow: Fetch = async (url, init) => {
      await gate
      return server(goodRoutes()).fetch(url, init)
    }
    const running = downloadPack(plan(), root, slow)
    await vi.waitFor(() => expect(readdirSync(root).filter((name) => name.startsWith('.download-fr-en-'))).toHaveLength(1))
    expect(await sweepStaging(root)).toBe(0)
    expect(readdirSync(root).filter((name) => name.startsWith('.download-fr-en-'))).toHaveLength(1)
    release()
    expect(await running).toEqual({ ok: true })
  })

  it('keeps nothing when a file does not match its fingerprint, and leaves the pack that was there', async () => {
    const root = tmp()
    glossaryPack(root, 'fr', 'en', { a: 'b' })
    const before = readdirSync(join(root, 'fr-en')).sort()
    const tampered = server({ ...goodRoutes(), [`https://${ATTACHMENTS_HOST}/main-workspace/models/v.spm`]: 'X'.repeat(Buffer.byteLength(FILES.vocab)) })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await downloadPack(plan(), root, tampered.fetch)).toEqual({ ok: false, reason: 'vocab.fren.spm: fingerprint' })
    expect(readdirSync(root).sort()).toEqual(['.partial', 'fr-en'])
    expect(readdirSync(join(root, 'fr-en')).sort()).toEqual(before)
    // The file that was right stays for the next attempt, the one that was wrong does not.
    expect(readdirSync(join(root, '.partial'))).toEqual([`${sha(FILES.model)}.part`])
    const again = server(goodRoutes())
    expect(await downloadPack(plan(), root, again.fetch)).toEqual({ ok: true })
    expect(again.calls.map((c) => c.url)).toEqual([plan().files[1]!.url])
    expect(readdirSync(root).sort()).toEqual(['fr-en', 'fr-en.glossary'])
  })

  it('refuses a file bigger than the plan said, by its declared length and by what actually arrives', async () => {
    const root = tmp()
    const big = FILES.model + 'EXTRA'
    const declared = server({ ...goodRoutes(), [plan().files[0]!.url]: new Response(body(big), { status: 200, headers: { 'content-length': String(big.length) } }) })
    expect(await downloadPack(plan(), root, declared.fetch)).toEqual({ ok: false, reason: 'model.fren.bin: size' })
    // A server that lies about the length: the bytes are counted as they come.
    const lying = server({ ...goodRoutes(), [plan().files[0]!.url]: new Response(body(big), { status: 200, headers: { 'content-length': '10' } }) })
    expect(await downloadPack(plan(), root, lying.fetch)).toEqual({ ok: false, reason: 'model.fren.bin: size' })
    expect(readdirSync(root)).toEqual([])
    // A body that ends early is kept for the next attempt to resume, and is no pack.
    const short = server({ ...goodRoutes(), [plan().files[0]!.url]: FILES.model.slice(0, 50) })
    expect(await downloadPack(plan(), root, short.fetch)).toEqual({ ok: false, reason: 'model.fren.bin: size' })
    expect(readdirSync(root)).toEqual(['.partial'])
    expect(statSync(join(root, '.partial', `${sha(FILES.model)}.part`)).size).toBe(50)
  })

  it('stops reading a file as soon as it goes beyond its size, instead of taking all that a server sends', async () => {
    const root = tmp()
    let pulled = 0
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        controller.enqueue(new Uint8Array(64))
        if (pulled > 10_000) controller.close()
      }
    })
    const flood = server({ ...goodRoutes(), [plan().files[0]!.url]: new Response(endless, { status: 200 }) })
    expect(await downloadPack(plan(), root, flood.fetch)).toEqual({ ok: false, reason: 'model.fren.bin: size' })
    // The plan said 480 bytes: a few reads of 64 bytes reach it, and the rest is never asked for.
    expect(pulled).toBeLessThan(30)
  })

  it('refuses an answer that is not a success, and a failure of the network, saying so and leaving nothing', async () => {
    const root = tmp()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await downloadPack(plan(), root, server({}).fetch)).toEqual({ ok: false, reason: 'model.fren.bin: http 404' })
    const refused: Fetch = async () => {
      throw new TypeError('redirect mode is set to error')
    }
    expect(await downloadPack(plan(), root, refused)).toEqual({ ok: false, reason: 'redirect mode is set to error' })
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('fr-en'), expect.any(TypeError))
    expect(readdirSync(root)).toEqual([])
  })

  it('refuses an address off the attachments server before it asks for anything', async () => {
    const root = tmp()
    const net = server({})
    const hostile = plan({ files: plan().files.map((f, i) => (i === 0 ? { ...f, url: 'https://evil.example/m.bin' } : f)) })
    expect(await downloadPack(hostile, root, net.fetch)).toEqual({ ok: false, reason: 'address' })
    const http = plan({ files: plan().files.map((f) => ({ ...f, url: f.url.replace('https:', 'http:') })) })
    expect(await downloadPack(http, root, net.fetch)).toEqual({ ok: false, reason: 'address' })
    expect(net.calls).toEqual([])
    expect(await downloadPack(plan({ from: '../x' }), root, net.fetch)).toEqual({ ok: false, reason: 'plan' })
    expect(await downloadPack(plan({ totalBytes: 10 ** 12 }), root, net.fetch)).toEqual({ ok: false, reason: 'plan' })
  })

  it('stops when told to, and says it was stopped', async () => {
    const root = tmp()
    const stop = new AbortController()
    const net = server(goodRoutes())
    stop.abort()
    expect(await downloadPack(plan(), root, net.fetch, { signal: stop.signal })).toEqual({ ok: false, reason: 'stopped' })
    expect(net.calls).toEqual([])
    expect(readdirSync(root)).toEqual([])
  })
})

// ---------- the controller ----------

interface Setup {
  controller: TranslateController
  page: FakePage
  root: string
  engineDir: string
  fetchCalls: string[]
  /** The `cache` option of each request, in the same order. */
  fetchCaches: string[]
  saved: string[]
  settings: Settings
  deps: TranslateDeps
}

function setup(over: { settings?: Partial<Settings>; readOnly?: boolean; engines?: EngineRegistry; routes?: Record<string, string | Uint8Array | Response>; chooseFolder?: string | null; url?: string; body?: ReturnType<typeof el> } = {}): Setup {
  const root = tmp()
  const engineDir = join(tmp(), 'translation-engine')
  const settings: Settings = { ...defaultSettings(), translateLocal: true, ...over.settings }
  const page = fakePage(over.body ?? el('BODY', [el('H1', [textNode('Bonjour le monde')]), el('P', [textNode('  Le chat dort ici. ')])]), 'fr')
  const net = server(over.routes ?? {})
  const fetchCalls: string[] = []
  const fetchCaches: string[] = []
  const saved: string[] = []
  const deps: TranslateDeps = {
    settings: () => settings,
    page: () => ({ url: over.url ?? 'https://exemple.org/page', run: (code) => page.run(code) }),
    readOnly: over.readOnly === true,
    defaultDir: root,
    engineDir,
    engines: over.engines ?? new EngineRegistry([glossaryEngine]),
    fetch: async (url, init) => {
      fetchCalls.push(url)
      fetchCaches.push(init.cache)
      return net.fetch(url, init)
    },
    chooseFolder: async () => over.chooseFolder ?? null,
    saveFolder: (path) => void saved.push(path),
    systemLocale: () => 'fr-FR'
  }
  return { controller: new TranslateController(deps), page, root, engineDir, fetchCalls, fetchCaches, saved, settings, deps }
}

describe('translating the page on screen', () => {
  const ORIGINAL = ['Bonjour le monde', '  Le chat dort ici. ']
  const glossary = { bonjour: 'hello', le: 'the', monde: 'world', chat: 'cat', dort: 'sleeps', ici: 'here' }

  it('translates with the pack on the route and puts the original back on request', async () => {
    const t = setup()
    glossaryPack(t.root, 'fr', 'en', glossary)
    const done = await t.controller.handle({ action: 'run', from: 'fr', to: 'en' })
    expect(done.state).toBe('translated')
    expect(done.message).toBe(frenchSpaces('Page traduite : 2 textes.'))
    expect(t.page.texts()).toEqual(['Hello the world', '  The cat sleeps here. '])
    const restored = await t.controller.handle({ action: 'restore' })
    expect(restored.state).toBe('idle')
    expect(t.page.texts()).toEqual(ORIGINAL)
  })

  // What a page answers crossed a process: a renderer that answers something else must not throw in the panel, nor feed an engine.
  it('takes a reply of the page that is not one as no reply: the panel still answers, and nothing is sent to an engine', async () => {
    const t = setup()
    glossaryPack(t.root, 'fr', 'en', glossary)
    const translated: string[][] = []
    const spying: TranslationEngine = { ...glossaryEngine, load: async (...args) => ({ ...(await glossaryEngine.load(...args)), translate: async (texts) => (translated.push([...texts]), texts.map(() => 'x')) }) }
    for (const reply of [{ text: 12, lang: 'fr' }, { nodes: 'abc' }, { nodes: [{ slice: 1 }] }, { nodes: Array(5000).fill('Bonjour le monde') }, { nodes: ['a'.repeat(2000)] }, 7, 'text', ['Bonjour'], null]) {
      const controller = new TranslateController({ ...t.deps, engines: new EngineRegistry([spying]), page: () => ({ url: 'https://exemple.org/page', run: async () => reply }) })
      const view = await controller.view()
      expect(view.state, JSON.stringify(reply)?.slice(0, 40)).toBe('idle')
      const ran = await controller.handle({ action: 'run', from: 'fr', to: 'en' })
      expect(ran.state, JSON.stringify(reply)?.slice(0, 40)).toBe('error')
      expect(ran.message).toBe('La page ne répond plus.')
    }
    expect(translated).toEqual([])
  })

  it('says it in the language of the interface', async () => {
    const t = setup({ settings: { interfaceTranslated: true, language: 'en' } })
    glossaryPack(t.root, 'fr', 'en', glossary)
    expect((await t.controller.handle({ action: 'run', from: 'fr', to: 'en' })).message).toBe('Page translated: 2 texts.')
  })

  it('goes through English when there is no direct pack, one engine after the other', async () => {
    const t = setup()
    glossaryPack(t.root, 'fr', 'en', glossary)
    glossaryPack(t.root, 'en', 'de', { hello: 'hallo', world: 'welt', the: 'die', cat: 'katze', sleeps: 'schläft', here: 'hier' })
    expect((await t.controller.handle({ action: 'run', from: 'fr', to: 'de' })).state).toBe('translated')
    expect(t.page.texts()).toEqual(['Hallo die welt', '  Die katze schläft hier. '])
  })

  it('does nothing to the page, and says what is missing, when there is no route', async () => {
    const t = setup()
    glossaryPack(t.root, 'en', 'de', glossary)
    const view = await t.controller.handle({ action: 'run', from: 'fr', to: 'de' })
    expect(view.state).toBe('error')
    expect(view.message).toBe(frenchSpaces('Il manque des modèles : fr → en.'))
    // The models to look for follow the pair that was asked, not only the one that was detected.
    expect(view.route).toEqual({ ok: false, missing: [['fr', 'en']] })
    expect(view.lookupUrl).toBe(catalogueUrl('fr', 'en'))
    expect(t.page.texts()).toEqual(ORIGINAL)
    expect(t.fetchCalls).toEqual([])
    // Opening the panel again starts from the pair proposed for the page (a French page, French target: into English), not from the one asked before.
    const reopened = await t.controller.handle({ action: 'refresh' })
    expect(reopened.proposed).toEqual({ from: 'fr', to: 'en' })
    expect(reopened.route).toEqual({ ok: false, missing: [['fr', 'en']] })
  })

  // The files of a pack are checked against their fingerprints before any engine reads them.
  it('refuses a pack whose files are not what the manifest says, before an engine sees it', async () => {
    const load = vi.fn()
    const spy: TranslationEngine = { id: 'glossary', load: async (m, d, c) => (load(), glossaryEngine.load(m, d, c)) }
    const t = setup({ engines: new EngineRegistry([spy]) })
    glossaryPack(t.root, 'fr', 'en', glossary)
    writeFileSync(join(t.root, 'fr-en', 'fr-en.glossary.json'), JSON.stringify({ entries: { bonjour: 'HACKED', le: 'the', monde: 'world', chat: 'cat', dort: 'sleeps', ici: 'here' } }))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const view = await t.controller.handle({ action: 'run', from: 'fr', to: 'en' })
    expect(view.state).toBe('error')
    expect(view.message).toContain('ne correspondent pas à leurs empreintes')
    expect(load).not.toHaveBeenCalled()
    expect(t.page.texts()).toEqual(ORIGINAL)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('fr-en'))
  })

  // Checked once is not checked for ever: the check is kept while the files are as they were, and a file written since is checked again.
  it('checks again a pack that was checked and used before, once a file of it has been written', async () => {
    const load = vi.fn()
    const spy: TranslationEngine = { id: 'glossary', load: async (m, d, c) => (load(), glossaryEngine.load(m, d, c)) }
    const t = setup({ engines: new EngineRegistry([spy]) })
    glossaryPack(t.root, 'fr', 'en', glossary)
    expect((await t.controller.handle({ action: 'run', from: 'fr', to: 'en' })).state).toBe('translated')
    expect((await t.controller.handle({ action: 'packs' })).packs[0]?.verified).toBe(true)
    await t.controller.handle({ action: 'restore' })
    // Same size, other content: only the fingerprint can tell.
    const file = join(t.root, 'fr-en', 'fr-en.glossary.json')
    const good = readFileSync(file, 'utf8')
    writeFileSync(file, good.replace('"hello"', '"HACKD"'))
    expect((await t.controller.handle({ action: 'packs' })).packs[0]?.verified).toBe(false)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const refused = await t.controller.handle({ action: 'run', from: 'fr', to: 'en' })
    expect(refused.message).toContain('ne correspondent pas à leurs empreintes')
    expect(load).toHaveBeenCalledTimes(1)
    expect(t.page.texts()).toEqual(ORIGINAL)
    // Put back as it was (written again, so checked again, and found right).
    writeFileSync(file, good)
    expect((await t.controller.handle({ action: 'run', from: 'fr', to: 'en' })).state).toBe('translated')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('says which engine is missing for a pack that needs one this build does not have', async () => {
    const t = setup()
    writePack(t.root, 'fr', 'en', 'bergamot', { 'model.fren.bin': { role: 'model', data: 'M' }, 'vocab.fren.spm': { role: 'vocab', data: 'V' } })
    const view = await t.controller.handle({ action: 'run', from: 'fr', to: 'en' })
    expect(view.message).toBe(frenchSpaces('Ce modèle demande le moteur « bergamot », qui n’est pas inclus dans cette version de Lucium.'))
    expect(view.engines).toEqual(['glossary'])
    expect(t.page.texts()).toEqual(ORIGINAL)
  })

  it('uses an engine that was put in its place, and gives it only what the page holds', async () => {
    const seen: string[][] = []
    const upper: TranslationEngine = { id: 'bergamot', load: async () => ({ translate: async (texts) => (seen.push([...texts]), texts.map((x) => x.toUpperCase())), dispose: () => undefined }) }
    const t = setup({ engines: new EngineRegistry([upper]) })
    writePack(t.root, 'fr', 'en', 'bergamot', { 'model.fren.bin': { role: 'model', data: 'M' }, 'vocab.fren.spm': { role: 'vocab', data: 'V' } })
    expect((await t.controller.handle({ action: 'run', from: 'fr', to: 'en' })).state).toBe('translated')
    expect(seen).toEqual([['Bonjour le monde', 'Le chat dort ici.']])
    expect(t.page.texts()).toEqual(['BONJOUR LE MONDE', '  LE CHAT DORT ICI. '])
  })

  // An engine that misbehaves leaves the page as it was, and the person is told.
  it('puts the page back when an engine answers with the wrong number of texts', async () => {
    const wrong: TranslationEngine = { id: 'glossary', load: async () => ({ translate: async () => ['only one'], dispose: () => undefined }) }
    const t = setup({ engines: new EngineRegistry([wrong]) })
    glossaryPack(t.root, 'fr', 'en', glossary)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const view = await t.controller.handle({ action: 'run', from: 'fr', to: 'en' })
    expect(view).toMatchObject({ state: 'error', message: frenchSpaces('Le moteur a renvoyé une réponse inutilisable : la page est restée telle quelle.') })
    expect(t.page.texts()).toEqual(ORIGINAL)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('one text for each'))
  })

  it('puts the whole page back when an engine fails on a later batch, and releases the model', async () => {
    let batches = 0
    const dispose = vi.fn()
    const flaky: TranslationEngine = {
      id: 'glossary',
      load: async () => ({
        translate: async (texts) => {
          if (++batches === 2) throw new Error('out of memory')
          return texts.map((x) => `[${x}]`)
        },
        dispose
      })
    }
    const long = Array.from({ length: 60 }, (_, i) => el('P', [textNode(`Phrase numéro ${i}`)]))
    const t = setup({ engines: new EngineRegistry([flaky]), body: el('BODY', long) })
    glossaryPack(t.root, 'fr', 'en', glossary)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const view = await t.controller.handle({ action: 'run', from: 'fr', to: 'en' })
    expect(batches).toBe(2)
    expect(view).toMatchObject({ state: 'error', message: frenchSpaces('Le moteur a échoué : la page est restée telle quelle.') })
    expect(t.page.texts()).toEqual(Array.from({ length: 60 }, (_, i) => `Phrase numéro ${i}`))
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('restored'), 'out of memory')
  })

  it('says so when a page has no text, is not a web page, or is already translated', async () => {
    const empty = setup({ body: el('BODY', [el('SCRIPT', [textNode('var x = 1')])]) })
    glossaryPack(empty.root, 'fr', 'en', glossary)
    expect((await empty.controller.handle({ action: 'run', from: 'fr', to: 'en' })).message).toBe('Cette page n’a pas de texte à traduire.')
    const file = setup({ url: 'file:///Users/moi/page.html' })
    glossaryPack(file.root, 'fr', 'en', glossary)
    expect((await file.controller.handle({ action: 'run', from: 'fr', to: 'en' })).message).toBe('Seules les pages web (http ou https) peuvent être traduites.')
    expect(file.page.texts()).toEqual(ORIGINAL)
    const again = setup()
    glossaryPack(again.root, 'fr', 'en', glossary)
    await again.controller.handle({ action: 'run', from: 'fr', to: 'en' })
    expect((await again.controller.handle({ action: 'run', from: 'fr', to: 'en' })).message).toBe(frenchSpaces('Cette page est déjà traduite : affichez d’abord l’original.'))
    expect(again.page.texts()).toEqual(['Hello the world', '  The cat sleeps here. '])
  })

  it('does nothing at all while the function is off', async () => {
    const t = setup({ settings: { translateLocal: false } })
    glossaryPack(t.root, 'fr', 'en', glossary)
    for (const request of [{ action: 'run', from: 'fr', to: 'en' }, { action: 'lookup', from: 'fr', to: 'en' }, { action: 'download', from: 'fr', to: 'en' }, { action: 'remove', from: 'fr', to: 'en' }, { action: 'folder' }] as const) {
      expect((await t.controller.handle(request)).message, request.action).toBe('La traduction de page est désactivée (Réglages › Extensions et outils › Traduction locale).')
    }
    expect(t.page.texts()).toEqual(ORIGINAL)
    expect(t.fetchCalls).toEqual([])
    expect(existsSync(join(t.root, 'fr-en'))).toBe(true)
  })

  it('reads the language of the page and the route when it is shown, and asks the network for nothing', async () => {
    const t = setup({
      body: el('BODY', [el('P', [textNode('Le gouvernement a annoncé hier que les nouvelles mesures seront appliquées dans toutes les régions, et que les habitants pourront les consulter sur le site officiel.')])])
    })
    const view = await t.controller.handle({ action: 'refresh' })
    expect(view.page).toEqual({ host: 'exemple.org', detection: expect.objectContaining({ language: 'fr', source: 'declared' }) })
    expect(view.target).toBe('fr')
    const toEnglish = setup({ settings: { translateTarget: 'en' }, body: t.page.body })
    const shown = await toEnglish.controller.handle({ action: 'refresh' })
    expect(shown.route).toEqual({ ok: false, missing: [['fr', 'en']] })
    expect(shown.lookupUrl).toBe(catalogueUrl('fr', 'en'))
    expect(shown.folder).toEqual({ path: toEnglish.root, isDefault: true })
    expect(toEnglish.fetchCalls).toEqual([])
    // The Settings window asks for the packs only: the page is not read.
    const packs = await toEnglish.controller.handle({ action: 'packs' })
    expect(packs.page).toBeNull()
    expect(packs.route).toBeNull()
  })
})

describe('the order and the memory of a translation, through the controller', () => {
  /** An engine that records each batch it was given and answers in upper case. */
  const recording = () => {
    const seen: string[][] = []
    const engine: TranslationEngine = { id: 'bergamot', load: async () => ({ translate: async (texts) => (seen.push([...texts]), texts.map((x) => x.toUpperCase())), dispose: () => undefined }) }
    return { seen, engine }
  }
  const bergamotPack = (root: string) => writePack(root, 'fr', 'en', 'bergamot', { 'model.fren.bin': { role: 'model', data: 'M' }, 'vocab.fren.spm': { role: 'vocab', data: 'V' } })

  it('translates what is on screen first, and puts each translation in its own node', async () => {
    const { seen, engine } = recording()
    const t = setup({ engines: new EngineRegistry([engine]) })
    bergamotPack(t.root)
    // A page scrolled down: the second paragraph is on screen, the first above it, the third below.
    const page = fakePage(el('BODY', [el('P', [textNode('Tout en haut de la page', { top: -1200, height: 20 })]), el('P', [textNode('Le texte à l’écran', { top: 300, height: 20 })]), el('P', [textNode('Plus bas encore', { top: 900, height: 20 })])]), 'fr', { width: 1000, height: 800 })
    const controller = new TranslateController({ ...t.deps, page: () => ({ url: 'https://exemple.org/page', run: (code) => page.run(code) }) })
    expect((await controller.handle({ action: 'run', from: 'fr', to: 'en' })).state).toBe('translated')
    expect(seen).toEqual([['Le texte à l’écran', 'Plus bas encore', 'Tout en haut de la page']])
    expect(page.texts()).toEqual(['TOUT EN HAUT DE LA PAGE', 'LE TEXTE À L’ÉCRAN', 'PLUS BAS ENCORE'])
  })

  it('remembers the translations of the session: « Afficher l’original » then « Traduire » asks the engine nothing', async () => {
    const { seen, engine } = recording()
    const memory = new TranslationMemory()
    const t = setup({ engines: new EngineRegistry([engine]) })
    bergamotPack(t.root)
    const controller = new TranslateController({ ...t.deps, memory })
    expect((await controller.handle({ action: 'run', from: 'fr', to: 'en' })).message).toBe(frenchSpaces('Page traduite : 2 textes.'))
    await controller.handle({ action: 'restore' })
    expect(t.page.texts()).toEqual(['Bonjour le monde', '  Le chat dort ici. '])
    expect((await controller.handle({ action: 'run', from: 'fr', to: 'en' })).message).toBe(frenchSpaces('Page traduite : 2 textes.'))
    expect(t.page.texts()).toEqual(['BONJOUR LE MONDE', '  LE CHAT DORT ICI. '])
    expect(seen).toHaveLength(1)
    expect(memory.size).toBe(2)
  })

  it('translates again once the files of a pack were replaced, even under the same version (a pack placed by hand is always version 1)', async () => {
    const { seen, engine } = recording()
    const memory = new TranslationMemory()
    const t = setup({ engines: new EngineRegistry([engine]) })
    const first = bergamotPack(t.root)
    const controller = new TranslateController({ ...t.deps, memory })
    await controller.handle({ action: 'run', from: 'fr', to: 'en' })
    await controller.handle({ action: 'restore' })
    // Another model in the same folder, with a manifest that says the same version.
    const second = writePack(t.root, 'fr', 'en', 'bergamot', { 'model.fren.bin': { role: 'model', data: 'ANOTHER MODEL' }, 'vocab.fren.spm': { role: 'vocab', data: 'V' } })
    expect(second.version).toBe(first.version)
    await controller.handle({ action: 'run', from: 'fr', to: 'en' })
    expect(seen).toHaveLength(2)
  })

  it('keeps the translations of a site for that site: a page of another origin neither reads them nor is put in the page ahead of the rest', async () => {
    const { seen, engine } = recording()
    const memory = new TranslationMemory()
    const t = setup({ engines: new EngineRegistry([engine]) })
    bergamotPack(t.root)
    const on = (url: string) => new TranslateController({ ...t.deps, memory, page: () => ({ url, run: (code) => t.page.run(code) }) })
    await on('https://journal.example/article').handle({ action: 'run', from: 'fr', to: 'en' })
    expect(seen).toHaveLength(1)
    expect(memory.size).toBe(2)
    // The same sentences on a page of another site: the engine is asked again, as if nobody had ever translated them.
    const other = on('https://curieux.example/sonde')
    await other.handle({ action: 'restore' })
    await other.handle({ action: 'run', from: 'fr', to: 'en' })
    expect(seen).toHaveLength(2)
    expect(memory.size).toBe(4)
    // Back on a page of the first site (another path, the same origin): the memory answers.
    const again = on('https://journal.example/autre')
    await again.handle({ action: 'restore' })
    await again.handle({ action: 'run', from: 'fr', to: 'en' })
    expect(seen).toHaveLength(2)
  })



  it('keeps nothing of a private window or a private tab, and reads nothing for them', async () => {
    for (const where of ['window', 'tab'] as const) {
      const { seen, engine } = recording()
      const memory = new TranslationMemory()
      // What a normal page translated before is not given to a private one either.
      memory.set('https://exemple.org\u0001bergamot:fr-en@1', 'Bonjour le monde', 'FROM THE MEMORY')
      const t = setup({ engines: new EngineRegistry([engine]), readOnly: where === 'window' })
      bergamotPack(t.root)
      const controller = new TranslateController({ ...t.deps, memory, page: () => ({ url: 'https://exemple.org/page', private: where === 'tab', run: (code) => t.page.run(code) }) })
      await controller.handle({ action: 'run', from: 'fr', to: 'en' })
      await controller.handle({ action: 'restore' })
      await controller.handle({ action: 'run', from: 'fr', to: 'en' })
      expect(t.page.texts(), where).toEqual(['BONJOUR LE MONDE', '  LE CHAT DORT ICI. '])
      expect(seen, where).toHaveLength(2)
      expect(memory.size, where).toBe(1)
    }
  })
})

/** A record of Mozilla's v2 collections for a file: the attachment is the file compressed with zstd, the record says what it decompresses into. */
const ZST = (data: string): Buffer => zstdCompressSync(Buffer.from(data))
const v2Record = (fields: Record<string, unknown>, data: string, location: string) => ({
  ...fields,
  decompressedHash: sha(data),
  decompressedSize: Buffer.byteLength(data),
  filter_expression: '',
  attachment: { hash: sha(ZST(data)), size: ZST(data).length, filename: `${location.split('/').pop()}.zst`, location, mimetype: 'application/zstd' }
})

describe('the models: lookup, download, folder', () => {
  const url = (name: string) => `https://${ATTACHMENTS_HOST}/main-workspace/translations-models/${name}`
  const catalogue = () => ({
    data: [
      ['model', FILES.model],
      ['vocab', FILES.vocab]
    ].map(([fileType, data]) => v2Record({ fromLang: 'fr', toLang: 'en', fileType, version: '3.1', name: `${fileType}.fren.bin` }, data!, `main-workspace/translations-models/${fileType}.bin`))
  })
  const routes = () => ({ [catalogueUrl('fr', 'en')]: JSON.stringify(catalogue()), [url('model.bin')]: ZST(FILES.model), [url('vocab.bin')]: ZST(FILES.vocab) })

  it('asks the catalogue only when told to, shows the files, the addresses and the size, and downloads nothing yet', async () => {
    const t = setup({ routes: routes() })
    const view = await t.controller.handle({ action: 'lookup', from: 'fr', to: 'en' })
    expect(t.fetchCalls).toEqual([catalogueUrl('fr', 'en')])
    // The catalogue is not kept in the disk cache of the interface's session: it would say which languages were looked up.
    expect(t.fetchCaches).toEqual(['no-store'])
    // What goes over the network (the compressed files) and what is kept on disk are both said.
    expect(view.offer).toMatchObject({ from: 'fr', to: 'en', catalogue: catalogueUrl('fr', 'en'), totalBytes: ZST(FILES.model).length + ZST(FILES.vocab).length, diskBytes: Buffer.byteLength(FILES.model) + Buffer.byteLength(FILES.vocab) })
    expect(view.offer!.files.map((f) => f.url)).toEqual([url('model.bin'), url('vocab.bin')])
    expect(view.message).toContain('Rien n’est téléchargé tant que vous ne cliquez pas.')
    expect(readdirSync(t.root)).toEqual([])
  })

  it('downloads what was shown, checks it, and the pack can then be used', async () => {
    const t = setup({ routes: routes() })
    await t.controller.handle({ action: 'lookup', from: 'fr', to: 'en' })
    const view = await t.controller.handle({ action: 'download', from: 'fr', to: 'en' })
    expect(t.fetchCalls).toEqual([catalogueUrl('fr', 'en'), url('model.bin'), url('vocab.bin')])
    expect(view.message).toBe('Modèle fr → en installé et vérifié.')
    expect(view.offer).toBeNull()
    expect(view.packs).toEqual([expect.objectContaining({ from: 'fr', to: 'en', engine: 'bergamot', verified: true, folder: 'fr-en' })])
    // Kept decompressed, under the names of the records.
    expect(readFileSync(join(t.root, 'fr-en', 'model.fren.bin'), 'utf8')).toBe(FILES.model)
  })

  // A folder that cannot be written to is not one a superuser is refused: nothing to force there.
  // Windows: `chmod 500` does not make a folder refuse a removal there (it only sets the read-only flag, which a folder's contents ignore).
  it.skipIf(process.getuid?.() === 0 || onWindows)('says where the temporary folder is when it could not be removed, instead of leaving it unmentioned', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const t = setup({ routes: routes() })
    await t.controller.handle({ action: 'lookup', from: 'fr', to: 'en' })
    const real = t.deps.fetch
    // The last file arrives, then the folder of the packs stops accepting removals: the pack cannot be put in place and the staging folder cannot go.
    t.deps.fetch = async (address, init) => {
      const response = await real(address, init)
      if (address === url('vocab.bin')) chmodSync(t.root, 0o500)
      return response
    }
    try {
      const view = await t.controller.handle({ action: 'download', from: 'fr', to: 'en' })
      expect(view.message).toMatch(/Un dossier temporaire n’a pas pu être supprimé\u00a0: .*\.download-fr-en-/)
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('[translate] cannot clean'), expect.any(String))
    } finally {
      chmodSync(t.root, 0o700)
    }
  })

  it('refuses to download what no lookup showed, and the pair that was not the one shown', async () => {
    const t = setup({ routes: routes() })
    expect((await t.controller.handle({ action: 'download', from: 'fr', to: 'en' })).message).toBe('Cherchez d’abord les modèles fr → en, vérifiez l’adresse et la taille, puis téléchargez.')
    await t.controller.handle({ action: 'lookup', from: 'fr', to: 'en' })
    expect((await t.controller.handle({ action: 'download', from: 'de', to: 'en' })).state).toBe('error')
    expect(t.fetchCalls).toEqual([catalogueUrl('fr', 'en')])
    expect(readdirSync(t.root)).toEqual([])
  })

  it('reports a catalogue that fails, answers something odd, or is too big, and keeps no offer', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const down = setup({ routes: {} })
    expect((await down.controller.handle({ action: 'lookup', from: 'fr', to: 'en' })).message).toBe('Le catalogue n’a pas répondu (404).')
    const odd = setup({ routes: { [catalogueUrl('fr', 'en')]: '{"data": "x"}' } })
    expect((await odd.controller.handle({ action: 'lookup', from: 'fr', to: 'en' })).message).toBe('Le catalogue a répondu quelque chose d’inattendu.')
    const notJson = setup({ routes: { [catalogueUrl('fr', 'en')]: '<html>' } })
    const failed = await notJson.controller.handle({ action: 'lookup', from: 'fr', to: 'en' })
    expect(failed.message).toBe('Le catalogue n’a pas répondu (SyntaxError).')
    expect(failed.offer).toBeNull()
    const huge = setup({ routes: { [catalogueUrl('fr', 'en')]: 'x'.repeat(4 * 1024 * 1024 + 10) } })
    expect((await huge.controller.handle({ action: 'lookup', from: 'fr', to: 'en' })).message).toBe('Le catalogue n’a pas répondu (Le catalogue est trop volumineux.).')
    expect(console.warn).toHaveBeenCalled()
  })

  it('writes nothing from a window that keeps nothing, and asks the network for nothing', async () => {
    const t = setup({ routes: routes(), readOnly: true, chooseFolder: '/Users/moi/Modeles' })
    glossaryPack(t.root, 'fr', 'en', { a: 'b' })
    for (const request of [{ action: 'lookup', from: 'de', to: 'en' }, { action: 'download', from: 'fr', to: 'en' }, { action: 'adopt', from: 'fr', to: 'en' }, { action: 'remove', from: 'fr', to: 'en' }, { action: 'folder' }, { action: 'folder-default' }] as const) {
      const view = await t.controller.handle(request)
      expect(view.state, request.action).toBe('error')
      expect(view.message, request.action).toContain('Une fenêtre privée n’écrit rien sur le disque')
    }
    expect(t.fetchCalls).toEqual([])
    expect(t.saved).toEqual([])
    expect(existsSync(join(t.root, 'fr-en', 'manifest.json'))).toBe(true)
    // It still translates with what is there.
    expect((await t.controller.handle({ action: 'run', from: 'fr', to: 'en' })).state).toBe('translated')
  })

  it('keeps the folder the system box chose, through the main process, and nothing when the box is cancelled', async () => {
    const chosen = setup({ chooseFolder: '/Users/moi/Modeles' })
    expect((await chosen.controller.handle({ action: 'folder' })).message).toBe('Dossier des modèles changé.')
    expect(chosen.saved).toEqual(['/Users/moi/Modeles'])
    const cancelled = setup({ chooseFolder: null })
    await cancelled.controller.handle({ action: 'folder' })
    expect(cancelled.saved).toEqual([])
    await cancelled.controller.handle({ action: 'folder-default' })
    expect(cancelled.saved).toEqual([''])
  })

  it('reads the models in the folder the settings name', async () => {
    const elsewhere = tmp()
    glossaryPack(elsewhere, 'fr', 'en', { a: 'b' })
    const t = setup({ settings: { translateModelsDir: elsewhere } })
    const view = await t.controller.handle({ action: 'packs' })
    expect(view.packs).toHaveLength(1)
    expect(view.folder).toEqual({ path: elsewhere, isDefault: false })
  })

  it('sweeps the leftovers of a download cut short the first time the panel is read, and not from a window that writes nothing', async () => {
    const leftover = '.download-fr-en-0b8e5c1a-6d2f-4c1e-9a77-3d1f2e4b5a60'
    const t = setup()
    mkdirSync(join(t.root, leftover))
    await t.controller.handle({ action: 'packs' })
    expect(readdirSync(t.root)).not.toContain(leftover)
    const readOnly = setup({ readOnly: true })
    mkdirSync(join(readOnly.root, leftover))
    await readOnly.controller.handle({ action: 'packs' })
    expect(readdirSync(readOnly.root)).toContain(leftover)
  })

  it('adopts and removes packs on request', async () => {
    const t = setup()
    const dir = join(t.root, 'fr-en')
    mkdirSync(dir)
    writeFileSync(join(dir, 'fr-en.glossary.json'), JSON.stringify({ entries: { bonjour: 'hello' } }))
    expect((await t.controller.handle({ action: 'adopt', from: 'fr', to: 'en' })).message).toBe(frenchSpaces('Modèle fr → en enregistré : empreintes calculées.'))
    expect((await t.controller.handle({ action: 'refresh' })).packs).toHaveLength(1)
    expect((await t.controller.handle({ action: 'remove', from: 'fr', to: 'en' })).message).toBe('Modèle fr → en supprimé.')
    expect((await t.controller.handle({ action: 'packs' })).packs).toEqual([])
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    // A folder of the name of a pair that is not a pack is said to be one, and stays.
    mkdirSync(join(t.root, 'es-en'))
    const refused = await t.controller.handle({ action: 'remove', from: 'es', to: 'en' })
    expect(refused.state).toBe('error')
    expect(refused.message).toBe(frenchSpaces('Le dossier « es-en » ne contient pas un modèle de Lucium : il n’a pas été supprimé.'))
    expect(existsSync(join(t.root, 'es-en'))).toBe(true)
    expect((await t.controller.handle({ action: 'adopt', from: 'de', to: 'en' })).state).toBe('error')
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('de-en'))
  })

  it('answers "busy" to a second operation while one runs, instead of running two', async () => {
    let release: () => void = () => undefined
    const slow: Fetch = () => new Promise((resolve) => (release = () => resolve(new Response('{"data":[]}'))))
    const t = setup()
    const controller = new TranslateController({ ...t.deps, fetch: slow })
    const first = controller.handle({ action: 'lookup', from: 'fr', to: 'en' })
    await Promise.resolve()
    expect((await controller.handle({ action: 'lookup', from: 'fr', to: 'en' })).message).toBe('Une opération est déjà en cours.')
    release()
    await first
  })
})

// ---------- the transfer of a file: compressed, checked twice, resumed ----------

describe('the transfer of a file: compressed, checked twice, resumed', () => {
  // Text that does not compress to almost nothing, so that a file cut in two is two real halves.
  const MODEL = Array.from({ length: 200 }, (_, i) => sha(`modèle ${i}`)).join('\n')
  const at = `https://${ATTACHMENTS_HOST}/main-workspace/translations-models/model.zst`
  const zplan = (over: Partial<DownloadPlan['files'][number]> = {}): DownloadPlan => {
    const packed = ZST(MODEL)
    const vocab = { role: 'vocab' as const, name: 'vocab.fren.spm', url: `https://${ATTACHMENTS_HOST}/main-workspace/models/v.spm`, size: Buffer.byteLength(FILES.vocab), sha256: sha(FILES.vocab) }
    const model = { role: 'model' as const, name: 'model.fren.bin', url: at, size: Buffer.byteLength(MODEL), sha256: sha(MODEL), transfer: { encoding: 'zstd' as const, size: packed.length, sha256: sha(packed) }, ...over }
    return { engine: 'bergamot', from: 'fr', to: 'en', version: '3.1', files: [model, vocab], totalBytes: packed.length + vocab.size, diskBytes: model.size + vocab.size }
  }
  const zroutes = (model: string | Uint8Array | Response = ZST(MODEL)) => ({ [at]: model, [`https://${ATTACHMENTS_HOST}/main-workspace/models/v.spm`]: FILES.vocab })

  it('decompresses what travelled compressed, after checking the compressed bytes, and keeps the decompressed file', async () => {
    const root = tmp()
    expect(await downloadPack(zplan(), root, server(zroutes()).fetch)).toEqual({ ok: true })
    expect(readFileSync(join(root, 'fr-en', 'model.fren.bin'), 'utf8')).toBe(MODEL)
    // The manifest gives what is on disk: the store checks the decompressed file from then on.
    expect(await verifyPack(join(root, 'fr-en'), (await readManifest(join(root, 'fr-en'), 'fr', 'en'))!)).toEqual({ ok: true })
    expect(readdirSync(root)).toEqual(['fr-en'])
  })

  // The fingerprint of the compressed bytes and the one of the file they give are both the record's: either one that differs refuses the file.
  it('refuses compressed bytes that are not the ones the record names, and a file that does not decompress into what the record says', async () => {
    const root = tmp()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    // Same length, one byte changed on the way.
    const other = Buffer.from(ZST(MODEL))
    other[other.length >> 1]! ^= 0xff
    expect(await downloadPack(zplan(), root, server(zroutes(other)).fetch)).toEqual({ ok: false, reason: 'model.fren.bin: fingerprint' })
    // Other bytes, of the size the record gives, that decompress into the very file: still not the file the record names, refused before the
    // decompressor reads them (only the fingerprint of the compressed bytes can tell).
    const recompressed = zstdCompressSync(Buffer.from(MODEL), { params: { [zlibConstants.ZSTD_c_compressionLevel]: 19, [zlibConstants.ZSTD_c_checksumFlag]: 1 } })
    expect(sha(recompressed)).not.toBe(sha(ZST(MODEL)))
    const sameSize = zplan({ transfer: { encoding: 'zstd', size: recompressed.length, sha256: sha(ZST(MODEL)) } })
    expect(await downloadPack(sameSize, root, server(zroutes(recompressed)).fetch)).toEqual({ ok: false, reason: 'model.fren.bin: fingerprint' })
    // The compressed file is the one named, but the record says it gives another file.
    expect(await downloadPack(zplan({ sha256: sha('another file') }), root, server(zroutes()).fetch)).toEqual({ ok: false, reason: 'model.fren.bin: fingerprint' })
    // Bytes that match their fingerprint and are no zstd at all.
    const junk = Buffer.from('not zstd at all, but these are the bytes the record names')
    expect(await downloadPack(zplan({ transfer: { encoding: 'zstd', size: junk.length, sha256: sha(junk) } }), root, server(zroutes(junk)).fetch)).toEqual({ ok: false, reason: 'model.fren.bin: decompress' })
    // Nothing was kept, not even for another try.
    expect(readdirSync(root)).toEqual([])
  })

  it('stops a file that decompresses into more than the record says (a bomb) at that size', async () => {
    const root = tmp()
    const bomb = zstdCompressSync(Buffer.alloc(50 * 1024 * 1024))
    expect(bomb.length).toBeLessThan(10_000)
    const plan = zplan({ size: 1000, transfer: { encoding: 'zstd', size: bomb.length, sha256: sha(bomb) } })
    expect(await downloadPack(plan, root, server(zroutes(bomb)).fetch)).toEqual({ ok: false, reason: 'model.fren.bin: size' })
    expect(readdirSync(root)).toEqual([])
  })

  it('resumes a download cut short: only the missing bytes are asked for, with a Range the server answers', async () => {
    const root = tmp()
    const packed = ZST(MODEL)
    const half = Math.floor(packed.length / 2)
    // The network goes away after half the file.
    const cut: Fetch = async (url, init) => {
      if (url !== at) return server(zroutes()).fetch(url, init)
      let pulls = 0
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulls++ === 0) controller.enqueue(packed.subarray(0, half))
          else controller.error(new TypeError('terminated'))
        }
      })
      return new Response(stream, { status: 200, headers: { 'content-length': String(packed.length) } })
    }
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await downloadPack(zplan(), root, cut)).toEqual({ ok: false, reason: 'terminated' })
    expect(statSync(join(root, '.partial', `${sha(packed)}.part`)).size).toBe(half)
    const asked: Array<string | undefined> = []
    const resuming: Fetch = async (url, init) => {
      if (url !== at) return server(zroutes()).fetch(url, init)
      const range = init.headers?.['range']
      asked.push(range)
      const start = Number(/^bytes=(\d+)-$/.exec(range ?? '')?.[1] ?? 0)
      return new Response(body(packed.subarray(start)), { status: 206, headers: { 'content-range': `bytes ${start}-${packed.length - 1}/${packed.length}`, 'content-length': String(packed.length - start) } })
    }
    expect(await downloadPack(zplan(), root, resuming)).toEqual({ ok: true })
    expect(asked).toEqual([`bytes=${half}-`])
    expect(readFileSync(join(root, 'fr-en', 'model.fren.bin'), 'utf8')).toBe(MODEL)
    // Once the pack is in place, nothing partial is left.
    expect(readdirSync(root)).toEqual(['fr-en'])
  })

  it('starts again when the server sends the whole file instead, or a range that is not the one asked', async () => {
    const packed = ZST(MODEL)
    const seed = (root: string) => {
      mkdirSync(join(root, '.partial'), { recursive: true })
      writeFileSync(join(root, '.partial', `${sha(packed)}.part`), packed.subarray(0, 100))
    }
    // A server that ignores Range answers 200 with everything: the file is read from the start.
    const whole = tmp()
    seed(whole)
    expect(await downloadPack(zplan(), whole, server(zroutes()).fetch)).toEqual({ ok: true })
    expect(readFileSync(join(whole, 'fr-en', 'model.fren.bin'), 'utf8')).toBe(MODEL)
    // A server that resumes somewhere else: refused, and the next attempt starts from zero.
    const wrong = tmp()
    seed(wrong)
    const elsewhere: Fetch = async (url, init) => (url === at ? new Response(body(packed.subarray(50)), { status: 206, headers: { 'content-range': `bytes 50-${packed.length - 1}/${packed.length}` } }) : server(zroutes()).fetch(url, init))
    expect(await downloadPack(zplan(), wrong, elsewhere)).toEqual({ ok: false, reason: 'model.fren.bin: range' })
    expect(readdirSync(wrong)).toEqual([])
    expect(await downloadPack(zplan(), wrong, server(zroutes()).fetch)).toEqual({ ok: true })
  })

  it('sweeps the partial files nobody came back for in a week, and leaves the recent ones', async () => {
    const root = tmp()
    const partial = join(root, '.partial')
    mkdirSync(partial)
    const [old, recent] = [`${'1'.repeat(64)}.part`, `${'2'.repeat(64)}.part`]
    writeFileSync(join(partial, old), 'x')
    writeFileSync(join(partial, recent), 'y')
    const weekAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000
    utimesSync(join(partial, old), weekAgo, weekAgo)
    await sweepStaging(root)
    expect(readdirSync(partial)).toEqual([recent])
  })
})

// ---------- the Bergamot engine in the panel ----------

describe('the Bergamot engine in the panel: its binary, the glossary as fallback, the paths', () => {
  const WASM = 'WASM-BYTES-'.repeat(30)
  const wasmUrl = `https://${ATTACHMENTS_HOST}/main-workspace/translations-wasm/engine.zst`
  const modelUrl = (name: string) => `https://${ATTACHMENTS_HOST}/main-workspace/translations-models/${name}`
  const models = () => ({
    data: [
      ['model', FILES.model],
      ['vocab', FILES.vocab]
    ].map(([fileType, data]) => v2Record({ fromLang: 'fr', toLang: 'en', fileType, version: '3.1', name: `${fileType}.fren.bin` }, data!, `main-workspace/translations-models/${fileType}.bin`))
  })
  const engineList = () => ({ data: [v2Record({ name: 'bergamot-translator', version: '4.0', release: 'v0.6.0' }, WASM, 'main-workspace/translations-wasm/engine.zst')] })
  const routes = () => ({
    [catalogueUrl('fr', 'en')]: JSON.stringify(models()),
    [RUNTIME_CATALOGUE_URL]: JSON.stringify(engineList()),
    [modelUrl('model.bin')]: ZST(FILES.model),
    [modelUrl('vocab.bin')]: ZST(FILES.vocab),
    [wasmUrl]: ZST(WASM)
  })
  /** The real Bergamot engine (its checks of the binary and of the files), with a worker that answers in this process instead of running WebAssembly. */
  const started: string[] = []
  const fakeWorker: StartWorker = (source) => {
    started.push(source)
    const listeners: Record<string, Array<(value: never) => void>> = {}
    return {
      on: (event: string, listener: (value: never) => void) => void (listeners[event] ??= []).push(listener),
      postMessage: (message: unknown) => {
        const job = message as { type: string; id: number; texts?: string[] }
        const reply = job.type === 'load' ? { type: 'loaded' } : { type: 'translated', id: job.id, texts: job.texts!.map((text) => `[en] ${text}`) }
        queueMicrotask(() => listeners['message']?.forEach((listener) => listener(reply as never)))
      },
      terminate: () => undefined
    } as WorkerLike
  }
  const engines = () => new EngineRegistry([createBergamotEngine({ startWorker: fakeWorker, glue: async () => '/* glue */' }), glossaryEngine])
  beforeEach(() => void started.splice(0))

  it('asks the network for nothing before a click, with the engine in the build and its binary absent', async () => {
    const t = setup({ engines: engines(), routes: routes(), settings: { translateTarget: 'en' } })
    writePack(t.root, 'fr', 'en', 'bergamot', { 'model.fren.bin': { role: 'model', data: FILES.model }, 'vocab.fren.spm': { role: 'vocab', data: FILES.vocab } })
    const shown = await t.controller.handle({ action: 'refresh' })
    expect(shown.engines).toEqual(['bergamot', 'glossary'])
    expect(shown.ready).toEqual(['glossary'])
    await t.controller.handle({ action: 'packs' })
    const run = await t.controller.handle({ action: 'run', from: 'fr', to: 'en' })
    expect(run.message).toBe(frenchSpaces('Le moteur de traduction n’est pas encore téléchargé (fr → en) : cherchez les modèles pour l’ajouter.'))
    await t.controller.handle({ action: 'restore' })
    expect(t.fetchCalls).toEqual([])
    expect(started).toEqual([])
    expect(existsSync(t.engineDir)).toBe(false)
  })

  it('looks up the engine with the first model, shows it in the list with its size, and downloads exactly what was shown, the engine first', async () => {
    const t = setup({ engines: engines(), routes: routes() })
    const offer = await t.controller.handle({ action: 'lookup', from: 'fr', to: 'en' })
    expect(t.fetchCalls).toEqual([catalogueUrl('fr', 'en'), RUNTIME_CATALOGUE_URL])
    expect(offer.offer!.files).toEqual([
      { name: 'bergamot-translator.wasm', url: wasmUrl, size: ZST(WASM).length, kind: 'engine' },
      { name: 'model.fren.bin', url: modelUrl('model.bin'), size: ZST(FILES.model).length, kind: 'model' },
      { name: 'vocab.fren.bin', url: modelUrl('vocab.bin'), size: ZST(FILES.vocab).length, kind: 'model' }
    ])
    expect(offer.offer!.totalBytes).toBe(ZST(WASM).length + ZST(FILES.model).length + ZST(FILES.vocab).length)
    expect(offer.offer!.diskBytes).toBe(Buffer.byteLength(WASM) + Buffer.byteLength(FILES.model) + Buffer.byteLength(FILES.vocab))
    // Nothing is on disk before the second click.
    expect(readdirSync(t.root)).toEqual([])
    expect(existsSync(t.engineDir)).toBe(false)
    const done = await t.controller.handle({ action: 'download', from: 'fr', to: 'en' })
    expect(done.message).toBe('Modèle fr → en installé et vérifié.')
    expect(t.fetchCalls).toEqual([catalogueUrl('fr', 'en'), RUNTIME_CATALOGUE_URL, wasmUrl, modelUrl('model.bin'), modelUrl('vocab.bin')])
    expect(done.ready).toEqual(['bergamot', 'glossary'])
    expect(readFileSync(join(t.engineDir, 'bergamot', 'bergamot-translator.wasm'), 'utf8')).toBe(WASM)
    expect(readdirSync(t.engineDir)).toEqual(['bergamot'])
    // And the page is translated by the engine, on the bytes that were checked.
    expect((await t.controller.handle({ action: 'run', from: 'fr', to: 'en' })).state).toBe('translated')
    expect(t.page.texts()).toEqual(['[en] Bonjour le monde', '  [en] Le chat dort ici. '])
    expect(started).toHaveLength(1)
    expect(t.fetchCalls).toHaveLength(5)
  })

  it('does not ask for the engine again once it is there, and offers only what is missing', async () => {
    const t = setup({ engines: engines(), routes: routes() })
    await t.controller.handle({ action: 'lookup', from: 'fr', to: 'en' })
    await t.controller.handle({ action: 'download', from: 'fr', to: 'en' })
    t.fetchCalls.splice(0)
    // The same model and the engine are there: nothing to download.
    const again = await t.controller.handle({ action: 'lookup', from: 'fr', to: 'en' })
    expect(t.fetchCalls).toEqual([catalogueUrl('fr', 'en')])
    expect(again.offer).toBeNull()
    expect(again.message).toBe('Le modèle fr → en et le moteur sont déjà installés.')
    // A model that is right on paper and damaged on disk is offered again.
    const vocabFile = join(t.root, 'fr-en', 'vocab.fren.bin')
    const good = readFileSync(vocabFile)
    writeFileSync(vocabFile, Buffer.from(good).fill(0x41, 0, 4))
    expect((await t.controller.handle({ action: 'lookup', from: 'fr', to: 'en' })).offer!.files.map((f) => f.kind)).toEqual(['model', 'model'])
    writeFileSync(vocabFile, good)
    t.fetchCalls.splice(0)
    // The engine went away (deleted by hand): only it is offered, the models stay.
    rmSync(join(t.engineDir, 'bergamot'), { recursive: true })
    t.fetchCalls.splice(0)
    const engineOnly = await t.controller.handle({ action: 'lookup', from: 'fr', to: 'en' })
    expect(engineOnly.offer!.files.map((f) => f.kind)).toEqual(['engine'])
    expect((await t.controller.handle({ action: 'download', from: 'fr', to: 'en' })).message).toBe('Moteur de traduction installé et vérifié.')
    expect(t.fetchCalls).toEqual([catalogueUrl('fr', 'en'), RUNTIME_CATALOGUE_URL, wasmUrl])
  })

  it('translates with the glossary of the pair while the engine is not downloaded, and with the model once it is', async () => {
    const t = setup({ engines: engines(), routes: routes() })
    glossaryPack(t.root, 'fr', 'en', { bonjour: 'hello', le: 'the', monde: 'world', chat: 'cat', dort: 'sleeps', ici: 'here' })
    expect((await t.controller.handle({ action: 'run', from: 'fr', to: 'en' })).state).toBe('translated')
    expect(t.page.texts()).toEqual(['Hello the world', '  The cat sleeps here. '])
    await t.controller.handle({ action: 'restore' })
    await t.controller.handle({ action: 'lookup', from: 'fr', to: 'en' })
    await t.controller.handle({ action: 'download', from: 'fr', to: 'en' })
    expect((await t.controller.handle({ action: 'run', from: 'fr', to: 'en' })).state).toBe('translated')
    expect(t.page.texts()).toEqual(['[en] Bonjour le monde', '  [en] Le chat dort ici. '])
    await t.controller.handle({ action: 'restore' })
    // The binary goes: the glossary, kept aside, translates again.
    rmSync(join(t.engineDir, 'bergamot'), { recursive: true })
    expect((await t.controller.handle({ action: 'run', from: 'fr', to: 'en' })).state).toBe('translated')
    expect(t.page.texts()).toEqual(['Hello the world', '  The cat sleeps here. '])
  })

  it('keeps a glossary aside when a model of its pair is downloaded, and removes one pack without the other', async () => {
    const t = setup({ engines: engines(), routes: routes() })
    glossaryPack(t.root, 'fr', 'en', { bonjour: 'hello' })
    await t.controller.handle({ action: 'lookup', from: 'fr', to: 'en' })
    const view = await t.controller.handle({ action: 'download', from: 'fr', to: 'en' })
    expect(view.packs.map((p) => [p.folder, p.engine])).toEqual([
      ['fr-en', 'bergamot'],
      ['fr-en.glossary', 'glossary']
    ])
    expect((await t.controller.handle({ action: 'remove', from: 'fr', to: 'en', engine: 'bergamot' })).packs.map((p) => p.folder)).toEqual(['fr-en.glossary'])
    // A remove that names an engine whose pack is not there leaves the other one alone.
    expect((await t.controller.handle({ action: 'remove', from: 'fr', to: 'en', engine: 'bergamot' })).packs.map((p) => p.folder)).toEqual(['fr-en.glossary'])
    expect((await t.controller.handle({ action: 'remove', from: 'fr', to: 'en', engine: 'glossary' })).packs).toEqual([])
  })

  it('refuses a binary that was changed since it was downloaded, before any worker starts, and the page stays as it was', async () => {
    const t = setup({ engines: engines(), routes: routes() })
    await t.controller.handle({ action: 'lookup', from: 'fr', to: 'en' })
    await t.controller.handle({ action: 'download', from: 'fr', to: 'en' })
    writeFileSync(join(t.engineDir, 'bergamot', 'bergamot-translator.wasm'), WASM.replace('WASM', 'EVIL'))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const refused = await t.controller.handle({ action: 'run', from: 'fr', to: 'en' })
    expect(refused).toMatchObject({ state: 'error', message: expect.stringContaining('Le moteur de traduction ne correspond plus à son empreinte') })
    expect(started).toEqual([])
    expect(t.page.texts()).toEqual(['Bonjour le monde', '  Le chat dort ici. '])
  })

  it('keeps the engine in its own folder and a pack in the folder of its pair, never anywhere a name from outside points', async () => {
    const root = tmp()
    for (const bad of ['../fr-en', 'fr-en/../../x', 'fr-fr', 'fr-en.bergamot', '/etc', 'fr-en.glossary/..']) expect(packDirOf(root, bad), bad).toBeNull()
    expect(packDirOf(root, 'fr-en.glossary')).toBe(join(root, 'fr-en.glossary'))
    // A folder set aside holds a glossary or it is not a pack.
    writePack(root, 'fr', 'en', 'bergamot', { 'model.fren.bin': { role: 'model', data: 'M' }, 'vocab.fren.spm': { role: 'vocab', data: 'V' } })
    renameSync(join(root, 'fr-en'), join(root, 'fr-en.glossary'))
    expect(await listPacks(root)).toEqual([])
    // The binary is kept under one fixed name, in the engine folder only.
    const engineDir = join(tmp(), 'translation-engine')
    const net = server(routes())
    const plan = { version: '4.0', release: 'v0.6.0', file: { name: '../../evil.wasm', size: Buffer.byteLength(WASM), sha256: sha(WASM), url: wasmUrl, transfer: { encoding: 'zstd' as const, size: ZST(WASM).length, sha256: sha(ZST(WASM)) } } }
    expect(await downloadRuntime(plan, engineDir, net.fetch)).toEqual({ ok: false, reason: 'plan' })
    expect(await downloadRuntime({ ...plan, file: { ...plan.file, url: 'https://evil.example/engine.zst', name: 'bergamot-translator.wasm' } }, engineDir, net.fetch)).toEqual({ ok: false, reason: 'address' })
    expect(net.calls).toEqual([])
    expect(await downloadRuntime({ ...plan, file: { ...plan.file, name: 'bergamot-translator.wasm' } }, engineDir, net.fetch)).toEqual({ ok: true })
    expect(readdirSync(engineDir)).toEqual(['bergamot'])
    expect(readdirSync(join(engineDir, 'bergamot')).sort()).toEqual(['bergamot-translator.wasm', 'manifest.json'])
    expect((await readRuntimeManifest(engineDir))?.file.sha256).toBe(sha(WASM))
    expect(new TextDecoder().decode(await readRuntime(engineDir))).toBe(WASM)
  })
})
