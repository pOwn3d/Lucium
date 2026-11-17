// Downloads a pack, or the engine's binary, after the user clicked "Télécharger" on the plan they were shown (shared/translate-local.ts `DownloadPlan`,
// `RuntimePlan`): exactly the files of that plan, from the addresses it lists and no others, each checked for size and SHA-256 fingerprint (transfer.ts:
// the compressed file as it came, then the decompressed file). The files go to a temporary folder next to their place; the manifest is written last and
// the folder renamed into place, so that a download that fails or is stopped leaves no half pack (only the partial files, for the next attempt to resume).
// Redirects are refused: the address shown is the address used.

import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ATTACHMENTS_HOST, PACK_LIMITS, RUNTIME_FILE_NAME, RUNTIME_LIMITS, parseManifest, wireBytes, type DownloadPlan, type RuntimePlan, type TransferFile } from '@shared/translate-local'
import { MANIFEST_NAME, RUNTIME_FOLDER, ensureDir, packDir, setForeignAside, setGlossaryAside, writeManifest, type PackResult } from './pack-store'
import { PARTIAL_DIR, forgetPartials, dropIfEmpty, sweepPartials, transferFile, type Fetch } from './transfer'

export type { Fetch }

export interface DownloadHooks {
  signal?: AbortSignal
  /** Bytes received so far of the whole plan. */
  progress?(received: number, total: number): void
  /** The temporary folder could not be removed at the end: the caller tells the user where it is (nothing sweeps it later). */
  leftover?(folder: string): void
}

/** A staging folder of a download: made in the folder it fills, removed when the download ends. */
const STAGING_NAME = /^\.download-(?:[a-z]{2,3}-[a-z]{2,3}|runtime)-[0-9a-f-]{36}$/
/** The staging folders of the downloads running now: a sweep leaves them alone. */
const liveStaging = new Set<string>()

/**
 * Removes the staging folders a crash or a kill left behind (the folder of a download is removed when it ends, however it ends, but not when the
 * application dies in the middle), and the partial files nobody came back for in a week. Never throws: a folder that stays is only clutter, and the
 * failure is logged with the folder.
 */
export async function sweepStaging(root: string): Promise<number> {
  let names: string[]
  try {
    names = await readdir(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[translate] cannot look for leftover downloads in ${root}:`, error instanceof Error ? error.message : String(error))
    return 0
  }
  let removed = 0
  for (const name of names) {
    const folder = join(root, name)
    if (!STAGING_NAME.test(name) || liveStaging.has(folder)) continue
    try {
      await rm(folder, { recursive: true, force: true })
      removed++
    } catch (error) {
      console.warn(`[translate] cannot remove the leftover download ${folder}:`, error instanceof Error ? error.message : String(error))
    }
  }
  // The partial files are a running download's too: they are swept only while no download fills this folder.
  const running = [...liveStaging].some((folder) => dirname(folder) === root)
  if (names.includes(PARTIAL_DIR) && !running) await sweepPartials(join(root, PARTIAL_DIR))
  return removed
}

const onAttachments = (file: TransferFile): boolean => URL.canParse(file.url) && new URL(file.url).hostname === ATTACHMENTS_HOST && new URL(file.url).protocol === 'https:'

/**
 * The common path of both downloads: a staging folder in `root`, each file transferred into it, `finish` to write the manifest, then the staging folder
 * renamed to `target` (after `beforeReplace`). Never throws: the result says what went wrong, and the cause is logged.
 */
async function stagedDownload(
  what: string,
  stagingTag: string,
  root: string,
  target: string,
  files: readonly TransferFile[],
  fetchFile: Fetch,
  hooks: DownloadHooks,
  finish: (staging: string) => Promise<boolean>,
  beforeReplace: () => Promise<void> = async () => undefined
): Promise<PackResult> {
  const staging = join(root, `.download-${stagingTag}-${randomUUID()}`)
  const partialDir = join(root, PARTIAL_DIR)
  const totalBytes = files.reduce((sum, file) => sum + wireBytes(file), 0)
  let total = 0
  liveStaging.add(staging)
  try {
    await ensureDir(root)
    await sweepStaging(root)
    await mkdir(staging, { mode: 0o700 })
    for (const file of files) {
      // The address was checked when the plan was made; it is checked again here, where it is used.
      if (!onAttachments(file)) return { ok: false, reason: 'address' }
      if (hooks.signal?.aborted) return { ok: false, reason: 'stopped' }
      const outcome = await transferFile(file, join(staging, file.name), {
        fetch: fetchFile,
        signal: hooks.signal ?? new AbortController().signal,
        partialDir,
        spend: (bytes) => {
          total += bytes
          hooks.progress?.(total, totalBytes)
        }
      })
      if (!outcome.ok) return { ok: false, reason: `${file.name}: ${outcome.reason}` }
    }
    if (!(await finish(staging))) return { ok: false, reason: 'plan' }
    await beforeReplace()
    // What was there is replaced only now that the new one is whole.
    await rm(target, { recursive: true, force: true })
    await rename(staging, target)
    await forgetPartials(partialDir, files)
    return { ok: true }
  } catch (error) {
    if (hooks.signal?.aborted) return { ok: false, reason: 'stopped' }
    console.error(`[translate] the download of ${what} failed:`, error)
    return { ok: false, reason: error instanceof Error ? error.message.slice(0, 120) : 'failed' }
  } finally {
    liveStaging.delete(staging)
    await dropIfEmpty(partialDir)
    await rm(staging, { recursive: true, force: true }).catch((error: unknown) => {
      console.warn(`[translate] cannot clean ${staging}:`, error instanceof Error ? error.message : String(error))
      hooks.leftover?.(staging)
    })
  }
}

/**
 * Fetches the files of a plan into the pack folder of the pair. A glossary that was in that folder is kept aside (`<pair>.glossary`), and so is
 * a folder of that name that is not a pack at all (`<pair>.kept-<time>`): only a pack of ours is replaced.
 */
export async function downloadPack(plan: DownloadPlan, root: string, fetchFile: Fetch, hooks: DownloadHooks = {}): Promise<PackResult> {
  const target = packDir(root, plan.from, plan.to)
  if (!target || plan.totalBytes > PACK_LIMITS.totalBytes || plan.files.length === 0) return { ok: false, reason: 'plan' }
  return stagedDownload(
    `the ${plan.from}-${plan.to} pack`,
    `${plan.from}-${plan.to}`,
    root,
    target,
    plan.files,
    fetchFile,
    hooks,
    async (staging) => {
      const manifest = parseManifest({ schema: 1, engine: plan.engine, from: plan.from, to: plan.to, version: plan.version, files: plan.files.map(({ role, name, size, sha256 }) => ({ role, name, size, sha256 })) })
      if (!manifest) return false
      await writeManifest(staging, manifest)
      return true
    },
    async () => {
      await setGlossaryAside(root, plan.from, plan.to)
      await setForeignAside(root, plan.from, plan.to)
    }
  )
}

/** Fetches the engine's binary into the engine folder (`<engineDir>/bergamot/`), with its manifest. */
export async function downloadRuntime(plan: RuntimePlan, engineDir: string, fetchFile: Fetch, hooks: DownloadHooks = {}): Promise<PackResult> {
  if (plan.file.name !== RUNTIME_FILE_NAME || plan.file.size > RUNTIME_LIMITS.bytes || wireBytes(plan.file) > RUNTIME_LIMITS.bytes) return { ok: false, reason: 'plan' }
  return stagedDownload('the engine', 'runtime', engineDir, join(engineDir, RUNTIME_FOLDER), [plan.file], fetchFile, hooks, async (staging) => {
    await writeManifest(staging, { schema: 1, version: plan.version, release: plan.release, file: { name: RUNTIME_FILE_NAME, size: plan.file.size, sha256: plan.file.sha256 } })
    return true
  })
}

export { MANIFEST_NAME }
