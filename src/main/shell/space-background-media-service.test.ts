// The background of a space (a picture or a video file): what the service refuses before anything is written.

import { existsSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { frenchSpaces } from '@shared/french-typography'
import { createInitialState } from '@shared/sidebar'
import { tempDir } from '../temp-dir'
import { runSpaceBackgroundMediaRequest, type MediaRequestEnv } from './space-background-media-service'

const LOCKED = frenchSpaces('Cet espace est verrouillé : déverrouillez-le d’abord.')
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

function setup(locked: string[]) {
  const userDataPath = tempDir('lucium-background-')
  const initial = createInitialState({ now: 1, newId: () => 'sp' })
  const state = { spaces: initial.spaces.map((space) => ({ ...space, background: { type: 'image' as const, value: 'kept.png' } })) }
  const env: MediaRequestEnv = { state: () => state, userDataPath, lockedSpaces: () => locked }
  /** Every file under the data folder: a refused upload leaves none. */
  const files = (): string[] => (existsSync(userDataPath) ? (readdirSync(userDataPath, { recursive: true }) as string[]).filter((name) => /\.[a-z0-9]+$/i.test(name)) : [])
  return { env, files, spaceId: initial.spaces[0]!.id }
}

describe('the background of a locked space', () => {
  it('takes no new file: the upload is refused with the reason and nothing is written', async () => {
    const t = setup([])
    const lockedSetup = setup([t.spaceId])
    const reply = await runSpaceBackgroundMediaRequest(lockedSetup.env, { op: 'upload', spaceId: lockedSetup.spaceId, data: PNG, mimeType: 'image/png' })
    expect(reply).toEqual({ ok: false, message: LOCKED })
    expect(lockedSetup.files()).toEqual([])
  })

  it('is not dropped: the request the interface drops it on is refused', async () => {
    const t = setup([])
    expect(await runSpaceBackgroundMediaRequest(t.env, { op: 'delete', spaceId: t.spaceId })).toEqual({ ok: true })
    const lockedSetup = setup([t.spaceId])
    expect(await runSpaceBackgroundMediaRequest(lockedSetup.env, { op: 'delete', spaceId: lockedSetup.spaceId })).toEqual({ ok: false, message: LOCKED })
  })
})
