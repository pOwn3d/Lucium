// The Bergamot engine: machine translation with Marian models run by bergamot-translator compiled to WebAssembly, on this computer.
//
//  - The WebAssembly binary is not shipped: it is downloaded once, on the user's click, with the first model (download.ts `downloadRuntime`), and kept in
//    userData/translation-engine. It is read and checked against its fingerprint on the very bytes given to the engine, at every load (pack-store.ts `readRuntime`).
//  - The JavaScript glue that goes with it (Emscripten's loader and the engine's bindings) IS shipped: vendor/bergamot-translator.js, unchanged from its upstream
//    release (MPL-2.0, its header kept; see docs/traduction-locale.md for where it comes from). A glue fits the binaries of one major version only.
//  - The engine runs in a worker thread of the main process, one per model, made when a translation starts and terminated when it ends (or is stopped):
//    a translation is a blocking computation, it must not hold the main process. The worker gets bytes, never a path; it has nothing to fetch (the glue is
//    given the binary, so it never looks for it) and answers texts.

import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { RUNTIME_MAJOR, type PackManifest, type PackRole } from '@shared/translate-local'
import type { EngineContext, EngineModel, TranslationEngine } from './engines'
import { readChecked, readRuntime, readRuntimeManifest } from './pack-store'

/** Where the vendored glue comes from, and what it is: a test checks the file against this, so that it is not changed by accident. */
export const BERGAMOT_GLUE = {
  file: 'vendor/bergamot-translator.js',
  sha256: 'faff1ef6285b0d26f01787776fd49299dfb756ecb9688aa990c250e66797b47d',
  /** `BERGAMOT_VERSION_FULL` in the file. */
  release: 'v0.6.0+eea6e5a8',
  /** The binaries it fits: the major version 4 of `translations-wasm-v2` (TranslationsParent.BERGAMOT_MAJOR_VERSION in the `source` release). */
  runtimeMajor: RUNTIME_MAJOR,
  source: 'Firefox 160.0 (Developer Edition, macOS), omni.ja: chrome/toolkit/content/global/translations/bergamot-translator.js'
} as const

/** The glue, read when a first Bergamot translation starts (a chunk of its own: 100 KB nobody loads while the function is not used). */
const loadGlue = async (): Promise<string> => (await import('./vendor/bergamot-translator.js?raw')).default

/** How long the engine may take to start with a model, and to translate one batch of texts (the controller sends at most 3 000 characters at a time). */
export const BERGAMOT_LIMITS = { loadMs: 120_000, batchMs: 120_000 } as const

/**
 * What runs in the worker, after the glue: the engine is started with the binary it is given, the model's files are copied into its aligned memory, and
 * texts are translated as plain text (no markup), one batch per message. The configuration is the upstream one (translations-engine.worker.js). Kept as text: it
 * is the worker's source, and the tests run it with a stand-in for the glue.
 */
export const WORKER_MAIN = `
const { parentPort } = require('node:worker_threads')
const ALIGNMENT = { model: 256, lex: 64, vocab: 64, srcvocab: 64, trgvocab: 64 }
let engine = null

function startEngine(wasm) {
  return new Promise((resolve, reject) => {
    const module = loadBergamot({
      INITIAL_MEMORY: 41943040,
      print: () => {},
      printErr: () => {},
      onAbort: (what) => reject(new Error('aborted: ' + String(what).slice(0, 200))),
      onRuntimeInitialized: () => { Promise.resolve().then(() => resolve(module)) },
      wasmBinary: wasm
    })
  })
}

function configText(entries) {
  const indent = '            '
  let text = '\\n'
  for (const [key, value] of Object.entries(entries)) text += indent + key + ': ' + value + '\\n'
  return text + indent
}

async function load(job) {
  const bergamot = await startEngine(job.wasm)
  const memory = {}
  for (const [role, bytes] of Object.entries(job.files)) {
    if (!ALIGNMENT[role]) throw new Error('unknown file role ' + role)
    const aligned = new bergamot.AlignedMemory(bytes.byteLength, ALIGNMENT[role])
    aligned.getByteArrayView().set(bytes)
    memory[role] = aligned
  }
  const vocabs = new bergamot.AlignedMemoryList()
  if (memory.vocab) vocabs.push_back(memory.vocab)
  else if (memory.srcvocab && memory.trgvocab) { vocabs.push_back(memory.srcvocab); vocabs.push_back(memory.trgvocab) }
  else throw new Error('no vocabulary')
  const config = configText({
    'beam-size': '1', normalize: '1.0', 'word-penalty': '0', 'max-length-break': '128', 'mini-batch-words': '1024', workspace: '128',
    'max-length-factor': '2.0', 'skip-cost': 'true', 'cpu-threads': '0', quiet: 'true', 'quiet-translation': 'true',
    'gemm-precision': job.modelName.endsWith('intgemm8.bin') ? 'int8shiftAll' : 'int8shiftAlphaAll', alignment: 'soft'
  })
  const model = new bergamot.TranslationModel(job.from, job.to, config, memory.model, memory.lex || null, vocabs, null)
  const service = new bergamot.BlockingService({ cacheSize: 0 })
  engine = { bergamot, model, service }
}

function translate(texts) {
  const { bergamot, model, service } = engine
  const out = texts.slice()
  // An empty text breaks the engine: only texts with something in them are sent, the others come back as they were.
  const positions = []
  const messages = new bergamot.VectorString()
  const options = new bergamot.VectorResponseOptions()
  let responses = null
  try {
    texts.forEach((text, index) => {
      if (/\\S/.test(text)) {
        messages.push_back(text)
        options.push_back({ qualityScores: false, alignment: false, html: false })
        positions.push(index)
      }
    })
    if (positions.length > 0) {
      responses = service.translate(model, messages, options)
      for (let k = 0; k < positions.length; k++) out[positions[k]] = responses.get(k).getTranslatedText()
    }
  } finally {
    messages.delete()
    options.delete()
    if (responses) responses.delete()
  }
  return out
}

parentPort.on('message', async (job) => {
  try {
    if (job.type === 'load') {
      await load(job)
      parentPort.postMessage({ type: 'loaded' })
    } else if (job.type === 'translate') {
      if (!engine) throw new Error('not loaded')
      parentPort.postMessage({ type: 'translated', id: job.id, texts: translate(job.texts) })
    }
  } catch (error) {
    parentPort.postMessage({ type: 'failed', id: job.id, message: String((error && error.message) || error).slice(0, 300) })
  }
})
`

/** The worker's whole source: the glue (which defines `loadBergamot`), then the part above. */
export const workerSource = (glue: string): string => `${glue}\n;${WORKER_MAIN}`

/** What the engine needs of a worker thread (a real one, or the tests' own). */
export interface WorkerLike {
  /** `transfer`: the buffers that go to the worker instead of being copied for it (the sender's views of them are empty afterwards). */
  postMessage(message: unknown, transfer?: readonly ArrayBuffer[]): void
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  terminate(): Promise<number> | void
}
export type StartWorker = (source: string) => WorkerLike

const startWorker: StartWorker = (source) => new Worker(source, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 256 } })

type Reply = { type: 'loaded' } | { type: 'translated'; id: number; texts: unknown } | { type: 'failed'; id?: number; message: string }

/** One worker and the one request it is answering: an answer, an error, the end of the worker, a stop or the time limit settles it. */
class WorkerSession {
  private pending: { resolve: (reply: Reply) => void; reject: (error: Error) => void } | null = null
  private ended = false
  private next = 1

  constructor(private readonly worker: WorkerLike) {
    worker.on('message', (message) => {
      const pending = this.pending
      this.pending = null
      pending?.resolve(message as Reply)
    })
    worker.on('error', (error) => this.fail(new Error(`worker: ${error.message}`)))
    worker.on('exit', (code) => this.fail(new Error(`worker exited (${code})`)))
  }

  private fail(error: Error): void {
    this.ended = true
    const pending = this.pending
    this.pending = null
    pending?.reject(error)
  }

  /** Sends a message and waits for its answer; a stop or the time limit ends the worker (a computation cannot be interrupted otherwise). */
  ask(message: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal, transfer: readonly ArrayBuffer[] = []): Promise<Reply> {
    if (this.ended) return Promise.reject(new Error('worker ended'))
    if (signal?.aborted) return Promise.reject(new Error('stopped'))
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.end()
        reject(new Error('timeout'))
      }, timeoutMs)
      const onAbort = (): void => {
        this.end()
        reject(new Error('stopped'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const settle = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
      this.pending = {
        resolve: (reply) => (settle(), resolve(reply)),
        reject: (error) => (settle(), reject(error))
      }
      this.worker.postMessage({ ...message, id: this.next++ }, transfer)
    })
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    this.pending = null
    void Promise.resolve(this.worker.terminate()).catch((error: unknown) => console.warn('[translate] the Bergamot worker did not end:', error instanceof Error ? error.message : String(error)))
  }
}

const MODEL_ROLES: readonly PackRole[] = ['model', 'lex', 'vocab', 'srcvocab', 'trgvocab']

/** The files of a pack, read once and checked on the bytes that go to the engine (the controller checked the pack already; this closes the gap between that check and this read). */
async function readModelFiles(manifest: PackManifest, dir: string): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {}
  for (const file of manifest.files) {
    if (!MODEL_ROLES.includes(file.role)) continue
    files[file.role] = await readChecked(join(dir, file.name), file.size, file.sha256, 'model')
  }
  return files
}

/**
 * The buffers of what is read for one load (the binary, the files of the model), to hand to the worker instead of copying them for it: the model
 * was then three times in the process while it loaded (the bytes read here, their copy for the worker, their copy in the engine's memory), and is
 * twice now. Only a view that is the whole of an ordinary buffer goes: a part of a larger buffer (one Node shares between small reads) is copied.
 */
export function transferable(views: readonly Uint8Array[]): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>()
  for (const view of views) {
    const { buffer } = view
    if (buffer instanceof ArrayBuffer && view.byteOffset === 0 && view.byteLength === buffer.byteLength && buffer.byteLength > 0) buffers.add(buffer)
  }
  return [...buffers]
}

export interface BergamotOptions {
  startWorker?: StartWorker
  /** The glue's text; the vendored file when not given. */
  glue?: () => Promise<string>
  limits?: { loadMs: number; batchMs: number }
}

export function createBergamotEngine(options: BergamotOptions = {}): TranslationEngine {
  const limits = options.limits ?? BERGAMOT_LIMITS
  return {
    id: 'bergamot',
    /** Ready once its binary is downloaded (it is checked when it is loaded). */
    ready: async (context: EngineContext) => (await readRuntimeManifest(context.runtimeDir)) !== null,
    async load(manifest: PackManifest, dir: string, context: EngineContext, signal?: AbortSignal): Promise<EngineModel> {
      const wasm = await readRuntime(context.runtimeDir)
      const files = await readModelFiles(manifest, dir)
      const model = manifest.files.find((file) => file.role === 'model')!
      const glue = await (options.glue ?? loadGlue)()
      // Stopped while the files were read: no worker is started for a translation nobody waits for.
      if (signal?.aborted) throw new Error('stopped')
      const session = new WorkerSession((options.startWorker ?? startWorker)(workerSource(glue)))
      try {
        // Read for this load alone and not looked at again here: the bytes are moved to the worker, not copied. A stop ends the worker, as it does
        // for a batch: the start of the engine is a computation too, and nothing else interrupts it.
        const reply = await session.ask({ type: 'load', wasm, files, from: manifest.from, to: manifest.to, modelName: model.name }, limits.loadMs, signal, transferable([wasm, ...Object.values(files)]))
        if (reply.type !== 'loaded') throw new Error(reply.type === 'failed' ? `engine: ${reply.message}` : 'engine: unexpected answer')
      } catch (error) {
        session.end()
        throw error
      }
      return {
        async translate(texts, signal) {
          const reply = await session.ask({ type: 'translate', texts: [...texts] }, limits.batchMs, signal)
          if (reply.type === 'failed') throw new Error(`engine: ${reply.message}`)
          if (reply.type !== 'translated') throw new Error('engine: unexpected answer')
          // The controller checks that it is one text for each text sent (checkReply) before anything goes into the page.
          return reply.texts as string[]
        },
        dispose: () => session.end()
      }
    }
  }
}

/** The engine of this build. */
export const bergamotEngine = createBergamotEngine()
