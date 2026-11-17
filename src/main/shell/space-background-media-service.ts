// IPC handler for space background media operations (upload, delete, read)
import { t } from '@shared/i18n'
import { spaceLookRefusal } from '@shared/lock'
import { MediaStorage, mimeTypeOfMedia } from '../media-storage'
import type { SidebarState } from '@shared/model'
import type { SpaceBackgroundMediaRequest, SpaceBackgroundMediaReply } from '@shared/space-background-media'

export interface MediaRequestEnv {
  state: () => Pick<SidebarState, 'spaces'>
  userDataPath: string
  /** The folder of the videos Lucium comes with (resources/backgrounds), or null where it has none. */
  builtinDir?: string | null
  /** The spaces locked at this moment: their background does not change. Without it none is. */
  lockedSpaces?: () => readonly string[]
}

export async function runSpaceBackgroundMediaRequest(
  env: MediaRequestEnv,
  request: SpaceBackgroundMediaRequest
): Promise<SpaceBackgroundMediaReply> {
  const storage = new MediaStorage(env.userDataPath, env.builtinDir ?? null)

  if (request.op === 'upload') {
    // The space is checked before anything is written: a refused request leaves no file behind.
    const space = env.state().spaces.find((entry) => entry.id === request.spaceId)
    if (!space) return { ok: false, message: t('space-media.espace-introuvable') }
    const refusal = spaceLookRefusal(space.id, env.lockedSpaces?.() ?? [])
    if (refusal !== null) return { ok: false, message: refusal }
    try {
      const { data } = request
      const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
      const filename = await storage.uploadMedia(buffer, request.mimeType)
      return { ok: true, filename }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : t('space-media.envoi-echoue') }
    }
  }

  if (request.op === 'delete') {
    const space = env.state().spaces.find((entry) => entry.id === request.spaceId)
    if (!space || !space.background?.value) return { ok: false, message: t('space-media.rien-a-supprimer') }
    // The interface drops the background on this answer: a locked space gets a refusal instead.
    const refusal = spaceLookRefusal(space.id, env.lockedSpaces?.() ?? [])
    if (refusal !== null) return { ok: false, message: refusal }
    // No file is deleted here: the space only stops naming it (the interface does that on this answer). The panel this comes from promises that
    // Escape and « Réinitialiser » put the background back, and a copy of the session may name it too: a file deleted now would leave the space
    // naming nothing. The sweep of a later launch deletes the file once no space and no copy names it.
    return { ok: true }
  }

  if (request.op === 'read') {
    try {
      // The bytes go as they are (no base64 text): the renderer makes a blob of them.
      const bytes = await storage.readMedia(request.filename)
      return { ok: true, data: new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength), mimeType: mimeTypeOfMedia(request.filename) }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : t('space-background.lecture-impossible') }
    }
  }

  return { ok: false, message: t('space-background.demande-invalide') }
}
