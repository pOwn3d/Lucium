// The castLabs build of Electron (the Widevine variant) is downloaded by scripts/electron-upgrade.mjs (step `ecs`). castLabs signs neither the
// archive nor its sums, so what can be checked is that several records of its SHA-256 agree; the download is refused when one disagrees or is
// missing:
//   1. SHASUMS256.txt, attached to the GitHub release next to the archive (uploaded with it);
//   2. checksums.json, a file of the repository castlabs/electron-releases at the release tag (written by a commit, served from the git tree,
//      not from the release's attachments);
//   3. the sum this repository recorded for that archive (scripts/ecs-checksums.json), when it has one: an archive downloaded once keeps its
//      sum here, and an archive replaced later on castLabs' side is refused.
// The first two are kept under the same GitHub account: they catch an attachment replaced alone, not a takeover of that account. The third
// catches a later replacement of a version already recorded, never the first download of a new one. docs/drm.md says this limit.

const SHA256 = /^[0-9a-f]{64}$/

/** The sum SHASUMS256.txt gives for `name` (lines `<sum> *<name>` or `<sum>  <name>`), or null when it gives none. */
export function sumFromShasums(text: string, name: string): string | null {
  for (const line of text.split('\n')) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(\S.*?)\s*$/.exec(line.trim())
    if (match && match[2] === name) return (match[1] ?? '').toLowerCase()
  }
  return null
}

/** The sum checksums.json gives for `name`, or the reason it gives none (the file is not an object of names and sums). */
export function sumFromChecksumsJson(text: string, name: string): { sum: string | null } | { unreadable: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { unreadable: error instanceof Error ? error.message : String(error) }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { unreadable: 'not an object' }
  const value = Object.hasOwn(parsed, name) ? (parsed as Record<string, unknown>)[name] : undefined
  return { sum: typeof value === 'string' ? value.toLowerCase() : null }
}

/** What this repository recorded: tag → archive name → SHA-256 (scripts/ecs-checksums.json). */
export type PinnedEcsSums = Readonly<Record<string, Readonly<Record<string, string>>>>

/** Reads scripts/ecs-checksums.json; throws on any entry that is not a lower-case SHA-256, so that a typo never weakens the check. */
export function readPinnedEcsSums(text: string): PinnedEcsSums {
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('ecs-checksums.json: not an object')
  const out: Record<string, Record<string, string>> = {}
  for (const [tag, files] of Object.entries(parsed)) {
    if (tag.startsWith('$')) continue // "$comment"
    if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?\+wvcus$/.test(tag)) throw new Error(`ecs-checksums.json: "${tag}" is not a castLabs tag (vX.Y.Z+wvcus)`)
    if (typeof files !== 'object' || files === null || Array.isArray(files)) throw new Error(`ecs-checksums.json: "${tag}" is not an object`)
    const sums: Record<string, string> = {}
    for (const [name, sum] of Object.entries(files)) {
      if (typeof sum !== 'string' || !SHA256.test(sum)) throw new Error(`ecs-checksums.json: the sum of "${name}" (${tag}) is not a lower-case SHA-256`)
      sums[name] = sum
    }
    out[tag] = sums
  }
  return out
}

export type EcsSumCheck = { ok: true; sum: string; recorded: boolean } | { ok: false; reason: string }

export interface EcsSumInput {
  tag: string
  zipName: string
  /** The text of SHASUMS256.txt from the release. */
  shasums: string
  /** The text of checksums.json from the repository at the tag. */
  checksumsJson: string
  pinned: PinnedEcsSums
}

/** The SHA-256 the downloaded archive must have, when every record agrees; otherwise why nothing may be downloaded. Messages in French: printed to the maintainer. */
export function expectedEcsSum({ tag, zipName, shasums, checksumsJson, pinned }: EcsSumInput): EcsSumCheck {
  const fromRelease = sumFromShasums(shasums, zipName)
  if (!fromRelease) return { ok: false, reason: `SHASUMS256.txt de ${tag} ne donne pas la somme de ${zipName}` }
  const fromTree = sumFromChecksumsJson(checksumsJson, zipName)
  if ('unreadable' in fromTree) return { ok: false, reason: `checksums.json de ${tag} est illisible (${fromTree.unreadable})` }
  if (!fromTree.sum || !SHA256.test(fromTree.sum)) return { ok: false, reason: `checksums.json de ${tag} ne donne pas la somme de ${zipName}` }
  if (fromTree.sum !== fromRelease) return { ok: false, reason: `les sommes de ${zipName} diffèrent : ${fromRelease} (SHASUMS256.txt de la version) et ${fromTree.sum} (checksums.json du dépôt au tag)` }
  const sums = Object.hasOwn(pinned, tag) ? pinned[tag] : undefined
  const recorded = sums !== undefined && Object.hasOwn(sums, zipName) ? (sums[zipName] ?? null) : null
  if (recorded !== null && recorded !== fromRelease) return { ok: false, reason: `la somme de ${zipName} publiée par castLabs (${fromRelease}) n'est plus celle que scripts/ecs-checksums.json a enregistrée (${recorded}) : archive remplacée depuis` }
  return { ok: true, sum: fromRelease, recorded: recorded !== null }
}
