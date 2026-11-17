import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PackManifest } from '@shared/translate-local'
import { Worker } from 'node:worker_threads'
import { BERGAMOT_GLUE, WORKER_MAIN, createBergamotEngine, transferable, workerSource, type StartWorker, type WorkerLike } from './bergamot'
import { RUNTIME_FOLDER, writeManifest } from './pack-store'

const sha = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex')
const dirs: string[] = []
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'lucium-bergamot-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// The real engine cannot run here: its binary comes from Mozilla's server and nothing is downloaded by the tests. What runs instead is the worker's own
// code (WORKER_MAIN) in a real worker thread, with a small stand-in for the glue: the same calls (loadBergamot, AlignedMemory, TranslationModel,
// BlockingService, VectorString…) on a "model" that is a dictionary. It checks the plumbing, not the translation.
const STUB_GLUE = `
function loadBergamot(Module) {
  const text = new TextDecoder().decode(Module.wasmBinary)
  if (text !== 'STUB-WASM') { setTimeout(() => Module.onAbort('not the binary: ' + text.slice(0, 20))); return Module }
  class Vector { constructor() { this.items = []; this.deleted = false } push_back(x) { this.items.push(x) } size() { return this.items.length } get(i) { return this.items[i] } delete() { this.deleted = true } }
  Module.VectorString = Vector
  Module.VectorResponseOptions = Vector
  Module.AlignedMemoryList = Vector
  Module.AlignedMemory = class { constructor(size, alignment) { this.bytes = new Uint8Array(size); this.alignment = alignment } getByteArrayView() { return this.bytes } size() { return this.bytes.length } }
  Module.TranslationModel = class {
    constructor(from, to, config, model, lex, vocabs) {
      if (model.alignment !== 256 || vocabs.size() !== 1 || (lex && lex.alignment !== 64)) throw new Error('memory not aligned as the engine needs')
      this.words = JSON.parse(new TextDecoder().decode(model.bytes))
      this.config = config
    }
  }
  Module.BlockingService = class {
    translate(model, messages, options) {
      const out = new Vector()
      messages.items.forEach((text, i) => {
        if (options.items[i].html !== false) throw new Error('html asked')
        if (text === 'CRASH') throw new Error('engine crash')
        if (text === 'CONFIG') { out.push_back({ getTranslatedText: () => model.config }); return }
        if (text === 'SPIN') { for (;;) {} }
        out.push_back({ getTranslatedText: () => text.split(' ').map((word) => model.words[word.toLowerCase()] || word).join(' ') })
      })
      return out
    }
  }
  setTimeout(() => Module.onRuntimeInitialized())
  return Module
}
`

const DICTIONARY = JSON.stringify({ bonjour: 'hello', le: 'the', monde: 'world' })

/** A runtime folder with a binary, and a pack folder with a model, as a download leaves them. */
async function install(wasm = 'STUB-WASM'): Promise<{ runtimeDir: string; dir: string; manifest: PackManifest }> {
  const runtimeDir = join(tmp(), 'translation-engine')
  mkdirSync(join(runtimeDir, RUNTIME_FOLDER), { recursive: true })
  writeFileSync(join(runtimeDir, RUNTIME_FOLDER, 'bergamot-translator.wasm'), wasm)
  await writeManifest(join(runtimeDir, RUNTIME_FOLDER), { schema: 1, version: '4.0', release: 'v0.6.0', file: { name: 'bergamot-translator.wasm', size: Buffer.byteLength(wasm), sha256: sha(wasm) } })
  const dir = join(tmp(), 'fr-en')
  mkdirSync(dir)
  const files = { 'model.fren.intgemm.alphas.bin': ['model', DICTIONARY], 'lex.50.50.fren.s2t.bin': ['lex', 'LEX'], 'vocab.fren.spm': ['vocab', 'VOCAB'] } as const
  for (const [name, [, data]] of Object.entries(files)) writeFileSync(join(dir, name), data)
  const manifest: PackManifest = { schema: 1, engine: 'bergamot', from: 'fr', to: 'en', version: '3.1', files: Object.entries(files).map(([name, [role, data]]) => ({ role, name, size: Buffer.byteLength(data), sha256: sha(data) })) }
  await writeManifest(dir, manifest)
  return { runtimeDir, dir, manifest }
}

const live = new AbortController().signal

describe('the vendored glue', () => {
  it('is the upstream file, unchanged, under its licence, of the version it says', () => {
    const glue = readFileSync(new URL(`./${BERGAMOT_GLUE.file}`, import.meta.url))
    expect(sha(glue)).toBe(BERGAMOT_GLUE.sha256)
    const text = glue.toString('utf8')
    expect(text).toContain('This Source Code Form is subject to the terms of the Mozilla Public\n * License, v. 2.0.')
    expect(text).toContain(`var BERGAMOT_VERSION_FULL = "${BERGAMOT_GLUE.release}"`)
    expect(text).toMatch(/^\/\* AUTO-GENERATED\. DO NOT MODIFY\./)
    // Given the binary, it never looks for it: the only fetches it has are for a binary it was not given.
    expect(text).toContain('if (!wasmBinary && (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER))')
    expect(BERGAMOT_GLUE.runtimeMajor).toBe(4)
  })

  it('is put before the worker’s own code, which has nothing that reaches the network', () => {
    expect(workerSource('/* glue */').startsWith('/* glue */\n;')).toBe(true)
    expect(WORKER_MAIN).not.toMatch(/fetch|XMLHttpRequest|require\('node:(?:http|https|net|fs|child_process)'\)/)
  })
})

describe('the Bergamot engine', () => {
  it('is ready once its binary is there, and not before', async () => {
    const engine = createBergamotEngine({ glue: async () => STUB_GLUE })
    expect(await engine.ready!({ runtimeDir: join(tmp(), 'none') })).toBe(false)
    expect(await engine.ready!({ runtimeDir: (await install()).runtimeDir })).toBe(true)
  })

  it('runs the worker’s code in a worker thread: the binary and the files in aligned memory, plain texts back in order, empty ones left as they are', async () => {
    const { runtimeDir, dir, manifest } = await install()
    const engine = createBergamotEngine({ glue: async () => STUB_GLUE })
    const model = await engine.load(manifest, dir, { runtimeDir })
    try {
      expect(await model.translate(['Bonjour le monde', '', '  ', 'monde'], live)).toEqual(['hello the world', '', '  ', 'world'])
      // The upstream configuration, with the precision its model's name asks for.
      const [config] = await model.translate(['CONFIG'], live)
      expect(config).toContain('gemm-precision: int8shiftAlphaAll')
      expect(config).toContain('beam-size: 1')
      // An error of the engine is an error of the translation, and the worker still answers after it.
      await expect(model.translate(['CRASH'], live)).rejects.toThrow('engine: engine crash')
      expect(await model.translate(['le monde'], live)).toEqual(['the world'])
    } finally {
      model.dispose()
    }
    await expect(model.translate(['monde'], live)).rejects.toThrow('worker ended')
  })

  it('moves the binary and the files of the model to the worker instead of copying them: the process holds them twice while it loads, not three times', async () => {
    const { runtimeDir, dir, manifest } = await install()
    const sent: Array<{ wasm: Uint8Array; files: Record<string, Uint8Array> }> = []
    // A real worker thread, whose messages are also kept here to see what is left of them on this side.
    const startWorker: StartWorker = (source) => {
      const worker = new Worker(source, { eval: true })
      return {
        on: (event: string, listener: (value: unknown) => void) => worker.on(event, listener as (...args: unknown[]) => void),
        terminate: () => worker.terminate(),
        postMessage: (message, transfer) => {
          sent.push(message as (typeof sent)[number])
          worker.postMessage(message, transfer)
        }
      } as WorkerLike
    }
    const model = await createBergamotEngine({ startWorker, glue: async () => STUB_GLUE }).load(manifest, dir, { runtimeDir })
    try {
      // Moved: the views of this side are empty. Copied, they would still hold the bytes, for as long as the load lasts.
      expect(sent[0]!.wasm.byteLength).toBe(0)
      expect(Object.values(sent[0]!.files).map((bytes) => bytes.byteLength)).toEqual([0, 0, 0])
      // …and the worker got every byte: the model translates.
      expect(await model.translate(['Bonjour le monde'], live)).toEqual(['hello the world'])
    } finally {
      model.dispose()
    }
  })

  it('moves only a view that is the whole of an ordinary buffer, each buffer once', () => {
    const whole = new Uint8Array([1, 2, 3])
    const part = new Uint8Array(new ArrayBuffer(8), 2, 4)
    const shared = new Uint8Array(new SharedArrayBuffer(4))
    expect(transferable([whole, part, shared, new Uint8Array(0), whole])).toEqual([whole.buffer])
  })

  it('stops a translation at once when told to, by ending its worker', async () => {
    const { runtimeDir, dir, manifest } = await install()
    const model = await createBergamotEngine({ glue: async () => STUB_GLUE }).load(manifest, dir, { runtimeDir })
    const stop = new AbortController()
    const running = model.translate(['SPIN'], stop.signal)
    setTimeout(() => stop.abort(), 50)
    await expect(running).rejects.toThrow('stopped')
    await expect(model.translate(['monde'], live)).rejects.toThrow('worker ended')
  })

  it('stops the start of the engine when told to, by ending its worker, and starts none for a translation already stopped', async () => {
    const { runtimeDir, dir, manifest } = await install()
    // A glue whose engine never finishes starting: only the stop, or the limit, ends the load.
    const never = 'function loadBergamot(Module) { return Module }'
    const ended = vi.fn()
    const startWorker: StartWorker = (source) => {
      const worker = new Worker(source, { eval: true })
      return {
        on: (event: string, listener: (value: unknown) => void) => worker.on(event, listener as (...args: unknown[]) => void),
        terminate: () => (ended(), worker.terminate()),
        postMessage: (message, transfer) => worker.postMessage(message, transfer)
      } as WorkerLike
    }
    const engine = createBergamotEngine({ startWorker, glue: async () => never, limits: { loadMs: 3_000, batchMs: 3_000 } })
    const stop = new AbortController()
    const loading = engine.load(manifest, dir, { runtimeDir }, stop.signal)
    setTimeout(() => stop.abort(), 50)
    // « stopped », not « timeout »: the stop ended it, the limit did not have to.
    await expect(loading).rejects.toThrow('stopped')
    expect(ended).toHaveBeenCalled()
    const started = vi.fn<StartWorker>(startWorker)
    await expect(createBergamotEngine({ startWorker: started, glue: async () => never }).load(manifest, dir, { runtimeDir }, stop.signal)).rejects.toThrow('stopped')
    expect(started).not.toHaveBeenCalled()
  })

  it('gives up on a worker that takes longer than its limit', async () => {
    const { runtimeDir, dir, manifest } = await install()
    const model = await createBergamotEngine({ glue: async () => STUB_GLUE, limits: { loadMs: 10_000, batchMs: 100 } }).load(manifest, dir, { runtimeDir })
    await expect(model.translate(['SPIN'], live)).rejects.toThrow('timeout')
  })

  it('says why it cannot start: an engine that aborts on its binary, a worker that dies', async () => {
    const aborting = await install('NOT-THE-STUB')
    await expect(createBergamotEngine({ glue: async () => STUB_GLUE }).load(aborting.manifest, aborting.dir, { runtimeDir: aborting.runtimeDir })).rejects.toThrow('engine: aborted: not the binary')
    const { runtimeDir, dir, manifest } = await install()
    await expect(createBergamotEngine({ glue: async () => 'throw new Error("broken glue")' }).load(manifest, dir, { runtimeDir })).rejects.toThrow(/worker/)
  })

  // What the engine is given is what was checked: the bytes are read once, and checked on that read.
  it('refuses a binary or a file of the model that is not what its manifest says, before any worker starts', async () => {
    const started = vi.fn<StartWorker>(() => ({ on: () => undefined, postMessage: () => undefined, terminate: () => undefined }) as WorkerLike)
    const engine = createBergamotEngine({ startWorker: started, glue: async () => STUB_GLUE })
    const one = await install()
    writeFileSync(join(one.runtimeDir, RUNTIME_FOLDER, 'bergamot-translator.wasm'), 'STUB-WASN')
    await expect(engine.load(one.manifest, one.dir, { runtimeDir: one.runtimeDir })).rejects.toThrow('runtime-fingerprint')
    const two = await install()
    writeFileSync(join(two.dir, 'vocab.fren.spm'), 'VOCAX')
    await expect(engine.load(two.manifest, two.dir, { runtimeDir: two.runtimeDir })).rejects.toThrow('model-fingerprint')
    writeFileSync(join(two.dir, 'vocab.fren.spm'), 'VOCAB, longer')
    await expect(engine.load(two.manifest, two.dir, { runtimeDir: two.runtimeDir })).rejects.toThrow('model-size')
    await expect(engine.load(two.manifest, two.dir, { runtimeDir: join(tmp(), 'none') })).rejects.toThrow('runtime-missing')
    expect(started).not.toHaveBeenCalled()
  })
})
