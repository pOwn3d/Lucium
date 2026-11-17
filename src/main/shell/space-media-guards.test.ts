// The background media of a space: the space is checked before anything is written, and a private window writes nothing.
// The real service and the real handler of the feature IPC run on a folder made for the test: what is checked is what is left on disk.
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Channel } from '@shared/ipc'
import { t } from '@shared/i18n'
import { runSpaceBackgroundMediaRequest } from './space-background-media-service'

// feature-ipc.ts asks Electron for the folder of the user's data when a request arrives.
const electron = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => new Proxy({ app: { getPath: () => electron.userData, getAppPath: () => electron.userData } } as Record<string, unknown>, { get: (target, name: string) => (name in target ? target[name] : {}) }))

const { registerFeatureIpc } = await import('./feature-ipc')

// A PNG header is enough for the storage: it checks the first bytes, not the picture.
// The bytes go as they are over the IPC (no base64 text).
const upload = (spaceId: string) => ({ op: 'upload', spaceId, data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]), mimeType: 'image/png' }) as const

let userData = ''
beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'lucium-space-media-'))
  electron.userData = userData
})
afterEach(() => {
  rmSync(userData, { recursive: true, force: true })
})

describe('the background media of a space', () => {
  it('checks the space before the file is written', async () => {
    const env = { state: () => ({ spaces: [{ id: 'known' }] }) as never, userDataPath: userData }
    expect(await runSpaceBackgroundMediaRequest(env, upload('unknown'))).toEqual({ ok: false, message: t('space-media.espace-introuvable') })
    // Not even the folder of the media is made: a refused request leaves nothing behind.
    expect(existsSync(join(userData, 'media'))).toBe(false)
    // The same request for a space that exists is written.
    const reply = await runSpaceBackgroundMediaRequest(env, upload('known'))
    expect(reply).toMatchObject({ ok: true })
    expect(readdirSync(join(userData, 'media'))).toEqual([(reply as { filename: string }).filename])
  })

  describe('« Supprimer » of a background', () => {
    const space = (id: string, value: string) => ({ id, background: { type: 'image', value } })
    const env = (spaces: unknown[]) => ({ state: () => ({ spaces }) as never, userDataPath: userData })
    const media = () => readdirSync(join(userData, 'media'))
    // The name the storage gave the picture of the space « s ».
    let name = ''
    beforeEach(async () => {
      name = ((await runSpaceBackgroundMediaRequest(env([{ id: 's' }]), upload('s'))) as { filename: string }).filename
    })

    it('leaves the file on disk: the panel that asked may still put the background back, and the sweep of a later launch deletes what nothing names', async () => {
      expect(await runSpaceBackgroundMediaRequest(env([space('s', name)]), { op: 'delete', spaceId: 's' })).toEqual({ ok: true })
      expect(media()).toEqual([name])
      // Escape in the editor names the file again: it is still read.
      expect(await runSpaceBackgroundMediaRequest(env([space('s', name)]), { op: 'read', filename: name })).toMatchObject({ ok: true, mimeType: 'image/png' })
      // Once the space has dropped it for good, the launch sweep is what deletes it.
      const { sweepBackgroundMedia } = await import('./background-media-sweep')
      expect(sweepBackgroundMedia(userData, [{ id: 's' }] as never, [])).toBe(1)
      expect(media()).toEqual([])
    })

    it('answers that there is nothing to delete for a space without a background, or one that does not exist', async () => {
      const nothing = { ok: false, message: t('space-media.rien-a-supprimer') }
      expect(await runSpaceBackgroundMediaRequest(env([{ id: 's' }]), { op: 'delete', spaceId: 's' })).toEqual(nothing)
      expect(await runSpaceBackgroundMediaRequest(env([space('s', name)]), { op: 'delete', spaceId: 'other' })).toEqual(nothing)
      expect(media()).toEqual([name])
    })
  })

  describe('from the interface of a window', () => {
    /** The handler of the channel, as the window registered it, over a state with one space and a window that is private or not. */
    function handlerOf(isPrivate: boolean) {
      const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
      const ipc = { on: (channel: string, handler: never) => void handlers.set(channel, handler), handle: (channel: string, handler: never) => void handlers.set(channel, handler) }
      const browser = new Proxy({ isPrivate: () => isPrivate }, { get: (target, name) => (name in target ? (target as Record<string | symbol, unknown>)[name] : () => undefined) })
      registerFeatureIpc(ipc as never, () => true, browser as never, { get: () => ({ spaces: [{ id: 'known' }] }) } as never, {} as never)
      return (request: unknown) => handlers.get(Channel.spaceBackgroundMedia)!({ sender: {} }, request)
    }

    it('refuses an upload from a private window before the request is handled', async () => {
      expect(await handlerOf(true)(upload('known'))).toEqual({ ok: false, message: t('space-media.pas-en-prive') })
      expect(existsSync(join(userData, 'media'))).toBe(false)
    })

    it('writes the upload of a window that is not private', async () => {
      const reply = await handlerOf(false)(upload('known'))
      expect(reply).toMatchObject({ ok: true })
      expect(readdirSync(join(userData, 'media'))).toHaveLength(1)
    })
  })
})
