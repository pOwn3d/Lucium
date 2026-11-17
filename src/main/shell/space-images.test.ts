import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { referencedImages, SPACE_IMAGE_FILE_MAX, SPACE_IMAGE_SIZE, SPACE_IMAGE_STORED_MAX, spaceImageUnreadable } from '@shared/space-image'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import type { SidebarState, TabItem } from '@shared/model'
import { frenchSpaces } from '@shared/french-typography'
import { SpaceImageError, SpaceImageStore, runSpaceImageRequest, type ImageCodec, type SpaceImageHost } from './space-images'
import { tempDir } from '../temp-dir'

// Faults and counters on the file system: a rename that can be made to fail (the copy is written under another name first, so a failure
// there must leave nothing behind), and a count of the files that are really read (a file past the weight limit must not be).
const faults = vi.hoisted(() => ({ failRename: false, reads: 0 }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      if (faults.failRename) throw new Error('forced: the rename failed')
      return actual.renameSync(from, to)
    },
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      faults.reads++
      return actual.readFileSync(...args)
    }) as typeof actual.readFileSync
  }
})

// ---------- fixtures: headers are all the code reads, so a header with a few bytes of body is a picture ----------

function png(width: number, height: number, extra = 0): Buffer {
  const b = Buffer.alloc(33 + extra)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(b)
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  return b
}

const A = 'aaaaaaaaaaaaaaaaaaaaaaaa.png'
const B = 'bbbbbbbbbbbbbbbbbbbbbbbb.png'

/** A codec that answers with a 128 px PNG, and remembers what it was given. */
function codec(answer: () => Buffer | Promise<Buffer> = () => png(SPACE_IMAGE_SIZE, SPACE_IMAGE_SIZE, 40)) {
  const calls: Array<{ length: number; size: number }> = []
  const instance: ImageCodec = {
    async shrink(bytes, size) {
      calls.push({ length: bytes.length, size })
      return answer()
    }
  }
  return { instance, calls }
}

let root: string
let dir: string
let warnings: unknown[][]
let errors: unknown[][]
beforeEach(() => {
  faults.failRename = false
  faults.reads = 0
  root = tempDir('lucium-space-images-')
  dir = join(root, 'space-images')
  warnings = []
  errors = []
  vi.spyOn(console, 'warn').mockImplementation((...args) => void warnings.push(args))
  vi.spyOn(console, 'error').mockImplementation((...args) => void errors.push(args))
})
afterEach(() => vi.restoreAllMocks())

const choose = (name: string, bytes: Buffer): string => {
  const path = join(root, name)
  writeFileSync(path, bytes)
  return path
}

describe('SpaceImageStore.importFile', () => {
  it('stores a shrunk copy under a name of its own, and leaves the chosen file and its path out of it', async () => {
    const { instance, calls } = codec()
    const store = new SpaceImageStore(dir, instance)
    const original = png(1600, 900, 5000)
    const path = choose('holiday.png', original)
    const name = await store.importFile(path)
    expect(name).toMatch(/^[0-9a-f]{24}\.png$/)
    expect(calls).toEqual([{ length: original.length, size: SPACE_IMAGE_SIZE }])
    // Only the copy is in the folder: no temporary file, nothing named after the original.
    expect(readdirSync(dir)).toEqual([name])
    expect(readFileSync(join(dir, name)).equals(png(SPACE_IMAGE_SIZE, SPACE_IMAGE_SIZE, 40))).toBe(true)
    expect(readFileSync(join(dir, name)).includes(Buffer.from(path))).toBe(false)
    expect(statSync(join(dir, name)).mode & 0o077).toBe(0)
    expect(readFileSync(path).equals(original)).toBe(true)
  })

  it('gives a different name to every picture', async () => {
    const store = new SpaceImageStore(dir, codec().instance)
    const path = choose('a.png', png(10, 10))
    const names = new Set([await store.importFile(path), await store.importFile(path), await store.importFile(path)])
    expect(names.size).toBe(3)
  })

  it('refuses what it should not decode, with a sentence, before the decoder is asked and before the folder exists', async () => {
    const { instance, calls } = codec()
    const store = new SpaceImageStore(dir, instance)
    const heavy = join(root, 'heavy.png')
    writeFileSync(heavy, png(10, 10))
    truncateSync(heavy, SPACE_IMAGE_FILE_MAX + 1)
    const cases: Array<[string, string, RegExp]> = [
      ['a folder', root, /Ce n’est pas un fichier/],
      ['a missing file', join(root, 'absent.png'), /ouvert/],
      ['an empty file', choose('empty.png', Buffer.alloc(0)), /vide/],
      ['a file past the weight limit', heavy, /lourde/],
      ['a script named like an image', choose('script.png', Buffer.from('<script>alert(1)</script>')), /PNG, JPEG ou WebP/],
      ['an svg', choose('vector.png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), /PNG, JPEG ou WebP/],
      ['a picture with a huge side', choose('huge.png', png(20_000, 10)), /trop grande/],
      ['a picture with too many pixels', choose('pixels.png', png(7000, 6000)), /trop grande/]
    ]
    for (const [what, path, message] of cases) {
      const reads = faults.reads
      const error = await store.importFile(path).catch((e: unknown) => e)
      expect(error, what).toBeInstanceOf(SpaceImageError)
      expect((error as Error).message, what).toMatch(message)
      // A file past the weight limit is never read.
      if (path === heavy) expect(faults.reads, what).toBe(reads)
    }
    expect(calls).toEqual([])
    expect(existsSync(dir)).toBe(false)
  })

  it('says so, and stores nothing, when the decoder cannot read the picture', async () => {
    const store = new SpaceImageStore(dir, codec(() => Promise.reject(new Error('EncodingError: the source image cannot be decoded'))).instance)
    const error = await store.importFile(choose('broken.png', png(300, 200))).catch((e: unknown) => e)
    expect((error as Error).message).toBe(spaceImageUnreadable())
    expect(warnings.flat().join(' ')).toContain('the source image cannot be decoded')
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([])
  })

  it('does not trust what the decoder hands back: it must be a small PNG no bigger than asked', async () => {
    const wrong: Array<[string, Buffer]> = [
      ['text', Buffer.from('not a picture')],
      ['a JPEG', Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 128, 0, 128, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])],
      ['a picture bigger than asked', png(SPACE_IMAGE_SIZE + 1, SPACE_IMAGE_SIZE)],
      ['an empty picture', png(0, 0)],
      ['a heavy picture', png(SPACE_IMAGE_SIZE, SPACE_IMAGE_SIZE, SPACE_IMAGE_STORED_MAX)]
    ]
    for (const [what, answer] of wrong) {
      const store = new SpaceImageStore(dir, codec(() => answer).instance)
      const error = await store.importFile(choose('ok.png', png(300, 200))).catch((e: unknown) => e)
      expect((error as Error).message, what).toBe(spaceImageUnreadable())
    }
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([])
    expect(warnings.length).toBe(wrong.length)
  })

  it('removes the temporary copy and reports the failure when the copy cannot be put in its place', async () => {
    const store = new SpaceImageStore(dir, codec().instance)
    faults.failRename = true
    const error = await store.importFile(choose('ok.png', png(300, 200))).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SpaceImageError)
    expect((error as Error).message).toMatch(/enregistrée/)
    expect(errors.flat().join(' ')).toContain('forced: the rename failed')
    // Nothing is left in the folder: neither the picture nor the file it was written to first.
    expect(readdirSync(dir)).toEqual([])
  })

  it('leaves no half-written file and reports the failure when the folder cannot be written', async () => {
    // The pictures folder is a file: it cannot be made.
    writeFileSync(dir, 'in the way')
    const store = new SpaceImageStore(dir, codec().instance)
    const error = await store.importFile(choose('ok.png', png(300, 200))).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SpaceImageError)
    expect((error as Error).message).toMatch(/enregistrée/)
    expect(errors.flat().join(' ')).toContain('cannot store the picture')
    expect(readFileSync(dir, 'utf8')).toBe('in the way')
  })
})

describe('SpaceImageStore.read', () => {
  async function stored(): Promise<{ store: SpaceImageStore; name: string }> {
    const store = new SpaceImageStore(dir, codec().instance)
    return { store, name: await store.importFile(choose('ok.png', png(300, 200))) }
  }

  it('gives the picture as a data URL', async () => {
    const { store, name } = await stored()
    const result = store.read(name)
    expect(result.kind).toBe('ok')
    const url = (result as { dataUrl: string }).dataUrl
    expect(url.startsWith('data:image/png;base64,')).toBe(true)
    expect(Buffer.from(url.slice('data:image/png;base64,'.length), 'base64').equals(readFileSync(join(dir, name)))).toBe(true)
  })

  it('reports a picture that is gone, and a name that is not one of ours, without touching the disk for the second', async () => {
    const { store } = await stored()
    expect(store.read(A)).toEqual({ kind: 'missing' })
    expect(store.read('../ok.png')).toEqual({ kind: 'missing' })
    expect(store.read('/etc/passwd')).toEqual({ kind: 'missing' })
  })

  it('reports a damaged file instead of returning it: not a PNG, too heavy, too big a picture, not a file', async () => {
    const { store } = await stored()
    writeFileSync(join(dir, A), 'GIF89a not a png at all')
    writeFileSync(join(dir, B), png(SPACE_IMAGE_SIZE, SPACE_IMAGE_SIZE, SPACE_IMAGE_STORED_MAX))
    writeFileSync(join(dir, 'cccccccccccccccccccccccc.png'), png(4000, 4000))
    mkdirSync(join(dir, 'dddddddddddddddddddddddd.png'))
    for (const name of [A, B, 'cccccccccccccccccccccccc.png', 'dddddddddddddddddddddddd.png']) expect(store.read(name), name).toEqual({ kind: 'damaged' })
  })
})

describe('SpaceImageStore.remove and sweep', () => {
  it('removes a picture, and says nothing is wrong about one that is not there', async () => {
    const store = new SpaceImageStore(dir, codec().instance)
    const name = await store.importFile(choose('ok.png', png(300, 200)))
    expect(store.remove(name)).toBe(true)
    expect(existsSync(join(dir, name))).toBe(false)
    expect(store.remove(name)).toBe(true)
    expect(errors).toEqual([])
  })

  it('never deletes a name that is not one of ours', async () => {
    const store = new SpaceImageStore(dir, codec().instance)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(root, 'precious.png'), 'x')
    writeFileSync(join(dir, 'notes.txt'), 'x')
    expect(store.remove('../precious.png')).toBe(false)
    expect(store.remove('notes.txt')).toBe(false)
    expect(existsSync(join(root, 'precious.png'))).toBe(true)
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true)
  })

  it('reports, with a log, a picture the system will not let go of', () => {
    const store = new SpaceImageStore(dir, codec().instance)
    // A folder with the name of a picture: unlink refuses.
    mkdirSync(join(dir, A), { recursive: true })
    writeFileSync(join(dir, A, 'inside'), 'x')
    expect(store.remove(A)).toBe(false)
    expect(errors.flat().join(' ')).toContain('cannot delete')
  })

  it('sweeps the pictures nothing refers to and the leftovers of an unfinished import, and nothing else', () => {
    const store = new SpaceImageStore(dir, codec().instance)
    mkdirSync(dir, { recursive: true })
    for (const file of [A, B, `${B}.tmp`, 'cccccccccccccccccccccccc.png.tmp', 'notes.txt', '.DS_Store']) writeFileSync(join(dir, file), 'x')
    expect(store.sweep(new Set([A]))).toBe(3)
    expect(readdirSync(dir).sort()).toEqual(['.DS_Store', A, 'notes.txt'].sort())
  })

  it('has nothing to sweep when the folder does not exist, and says so when it cannot be listed', () => {
    expect(new SpaceImageStore(dir, codec().instance).sweep(new Set())).toBe(0)
    expect(errors).toEqual([])
    writeFileSync(dir, 'a file where the folder should be')
    expect(new SpaceImageStore(dir, codec().instance).sweep(new Set())).toBe(0)
    expect(errors.flat().join(' ')).toContain('cannot list')
  })
})

// ---------- the requests of the interface, over the real reducer ----------

function harness(over: { priv?: boolean; picks?: Array<string | null> } = {}) {
  let state: SidebarState = createInitialState({ now: 0, newId: () => 'sp' })
  state = reduce(state, { type: 'space/create', name: 'Travail', emoji: '💼', hue: 200 }, { now: 0, newId: () => 'sp2' })
  // A tab of the space, and a private one (written nowhere), for the picture of a tab.
  const tab = (id: string, extra: Partial<TabItem> = {}): TabItem => ({ id, spaceId: 'sp2', url: `https://${id}.example/`, title: id, pinned: false, createdAt: 0, lastActiveAt: 0, ...extra })
  state = { ...state, tabs: [tab('t1', { icon: '🔥' }), tab('t-private', { private: true })] }
  const dispatched: Action[] = []
  const targets: string[] = []
  const picks = [...(over.picks ?? [])]
  let chosen = 0
  let sweeps = 0
  const { instance, calls } = codec()
  const store = new SpaceImageStore(dir, instance)
  const host: SpaceImageHost = {
    spaces: () => state.spaces,
    tabs: () => state.tabs,
    dispatch: (action) => {
      dispatched.push(action)
      state = reduce(state, action, { now: 0, newId: () => 'z' })
    },
    chooseFile: async (target) => {
      targets.push(target)
      chosen++
      return picks.shift() ?? null
    },
    sweep: () => {
      sweeps++
      store.sweep(referencedImages(state))
    },
    isPrivate: () => over.priv === true
  }
  return { store, host, calls, dispatched, targets, state: () => state, chosen: () => chosen, sweeps: () => sweeps }
}

describe('runSpaceImageRequest', () => {
  it('picks a file, stores its copy and gives it to the space', async () => {
    const h = harness({ picks: [choose('me.png', png(640, 480))] })
    const reply = await runSpaceImageRequest(h.store, h.host, { op: 'pick', spaceId: 'sp2' })
    expect(reply).toEqual({ ok: true })
    const image = h.state().spaces.find((s) => s.id === 'sp2')!.image!
    expect(readdirSync(dir)).toEqual([image])
    expect(h.dispatched).toEqual([{ type: 'space/image', id: 'sp2', image }])
    // The space's state names the copy alone: no trace of where the original was.
    expect(JSON.stringify(h.state())).not.toContain('me.png')
  })

  it('replaces a picture and deletes the old copy', async () => {
    const h = harness({ picks: [choose('one.png', png(300, 300)), choose('two.png', png(300, 300))] })
    await runSpaceImageRequest(h.store, h.host, { op: 'pick', spaceId: 'sp2' })
    const first = h.state().spaces.find((s) => s.id === 'sp2')!.image!
    await runSpaceImageRequest(h.store, h.host, { op: 'pick', spaceId: 'sp2' })
    const second = h.state().spaces.find((s) => s.id === 'sp2')!.image!
    expect(second).not.toBe(first)
    expect(readdirSync(dir)).toEqual([second])
  })

  it('no longer waits for a setting: the picker offers the picture whatever the Settings say', async () => {
    // The state of an installation that never switched "Choisir une image pour un espace" on, or switched it off.
    const h = harness({ picks: [choose('me.png', png(640, 480))] })
    h.host.dispatch({ type: 'settings/update', patch: { spaceImages: false } })
    expect(await runSpaceImageRequest(h.store, h.host, { op: 'pick', spaceId: 'sp2' })).toEqual({ ok: true })
    expect(h.chosen()).toBe(1)
    expect(h.state().spaces.find((s) => s.id === 'sp2')!.image).toBeDefined()
  })

  it('writes nothing from a private window', async () => {
    const h = harness({ priv: true, picks: [choose('me.png', png(640, 480))] })
    const reply = await runSpaceImageRequest(h.store, h.host, { op: 'pick', spaceId: 'sp2' })
    expect(reply.ok).toBe(false)
    expect(h.chosen()).toBe(0)
    expect(existsSync(dir)).toBe(false)
  })

  it('says nothing when the user closes the dialog', async () => {
    const h = harness({ picks: [null] })
    expect(await runSpaceImageRequest(h.store, h.host, { op: 'pick', spaceId: 'sp2' })).toEqual({ ok: false, message: '' })
    expect(h.dispatched).toEqual([])
  })

  it('refuses an unreadable file with the reason, leaves the space as it was, and cleans up', async () => {
    const h = harness({ picks: [choose('notes.png', Buffer.from('just text'))] })
    const reply = await runSpaceImageRequest(h.store, h.host, { op: 'pick', spaceId: 'sp2' })
    expect(reply).toMatchObject({ ok: false })
    expect((reply as { message: string }).message).toMatch(/PNG, JPEG ou WebP/)
    expect(h.dispatched).toEqual([])
    expect(h.state().spaces.every((s) => s.image === undefined)).toBe(true)
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([])
  })

  it('says so, and logs, when something unexpected goes wrong after the copy is made (here the state refuses to change)', async () => {
    const h = harness({ picks: [choose('me.png', png(640, 480))] })
    h.host.dispatch = () => {
      throw new Error('forced: the state is gone')
    }
    const reply = await runSpaceImageRequest(h.store, h.host, { op: 'pick', spaceId: 'sp2' })
    expect(reply).toEqual({ ok: false, message: 'L’image n’a pas pu être importée.' })
    expect(errors.flat().join(' ')).toContain('forced: the state is gone')
    // The copy that was made is not left behind.
    expect(readdirSync(dir)).toEqual([])
  })

  it('refuses a space that no longer exists', async () => {
    const h = harness({ picks: [choose('me.png', png(640, 480))] })
    expect(await runSpaceImageRequest(h.store, h.host, { op: 'pick', spaceId: 'gone' })).toMatchObject({ ok: false })
    expect(h.chosen()).toBe(0)
  })

  it('does not keep a copy the state refused (the space was deleted while the picture was made)', async () => {
    const h = harness({ picks: [choose('me.png', png(640, 480))] })
    const dispatch = h.host.dispatch
    h.host.dispatch = (action) => {
      // The user deletes the space between the dialog and the end of the import.
      dispatch({ type: 'space/delete', id: 'sp2' })
      dispatch(action)
    }
    const reply = await runSpaceImageRequest(h.store, h.host, { op: 'pick', spaceId: 'sp2' })
    expect(reply.ok).toBe(false)
    expect(h.state().spaces.every((s) => s.image === undefined)).toBe(true)
    expect(readdirSync(dir)).toEqual([])
  })

  it('takes the picture away, and the copy with it', async () => {
    const h = harness({ picks: [choose('me.png', png(640, 480))] })
    await runSpaceImageRequest(h.store, h.host, { op: 'pick', spaceId: 'sp2' })
    expect(await runSpaceImageRequest(h.store, h.host, { op: 'clear', spaceId: 'sp2' })).toEqual({ ok: true })
    expect(h.state().spaces.find((s) => s.id === 'sp2')!.image).toBeUndefined()
    expect(readdirSync(dir)).toEqual([])
  })

  it('reads a stored picture', async () => {
    const h = harness({ picks: [choose('me.png', png(640, 480))] })
    await runSpaceImageRequest(h.store, h.host, { op: 'pick', spaceId: 'sp2' })
    const name = h.state().spaces.find((s) => s.id === 'sp2')!.image!
    const reply = await runSpaceImageRequest(h.store, h.host, { op: 'read', name })
    expect(reply).toMatchObject({ ok: true })
    expect((reply as { dataUrl: string }).dataUrl.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('lets go of a picture that is damaged: the space shows its emoji again and the file is deleted', async () => {
    const h = harness({ picks: [choose('me.png', png(640, 480))] })
    await runSpaceImageRequest(h.store, h.host, { op: 'pick', spaceId: 'sp2' })
    const name = h.state().spaces.find((s) => s.id === 'sp2')!.image!
    writeFileSync(join(dir, name), 'damaged on the disk')
    const reply = await runSpaceImageRequest(h.store, h.host, { op: 'read', name })
    expect(reply).toEqual({ ok: false, message: spaceImageUnreadable() })
    expect(h.state().spaces.find((s) => s.id === 'sp2')!.image).toBeUndefined()
    expect(existsSync(join(dir, name))).toBe(false)
  })

  it('lets go of a picture whose file is gone, too', async () => {
    const h = harness({ picks: [choose('me.png', png(640, 480))] })
    await runSpaceImageRequest(h.store, h.host, { op: 'pick', spaceId: 'sp2' })
    const name = h.state().spaces.find((s) => s.id === 'sp2')!.image!
    h.store.remove(name)
    expect(await runSpaceImageRequest(h.store, h.host, { op: 'read', name })).toMatchObject({ ok: false })
    expect(h.state().spaces.find((s) => s.id === 'sp2')!.image).toBeUndefined()
  })
})

describe('the picture of a tab', () => {
  const tabOf = (h: ReturnType<typeof harness>, id: string) => h.state().tabs.find((t) => t.id === id)!

  it('is picked in the dialog of a tab, stored like a space’s and given to the tab in place of its emoji', async () => {
    const h = harness({ picks: [choose('logo.png', png(640, 480))] })
    expect(await runSpaceImageRequest(h.store, h.host, { op: 'pick-tab', tabId: 't1' })).toEqual({ ok: true })
    const image = tabOf(h, 't1').image!
    expect(h.targets).toEqual(['tab'])
    expect(readdirSync(dir)).toEqual([image])
    expect(tabOf(h, 't1').icon).toBeUndefined()
    expect(JSON.stringify(h.state())).not.toContain('logo.png')
  })

  it('is kept by the sweep while the tab names it, and swept once the site’s icon is taken back', async () => {
    const h = harness({ picks: [choose('logo.png', png(640, 480))] })
    await runSpaceImageRequest(h.store, h.host, { op: 'pick-tab', tabId: 't1' })
    const image = tabOf(h, 't1').image!
    h.host.sweep()
    expect(readdirSync(dir)).toEqual([image])
    h.host.dispatch({ type: 'tab/icon', id: 't1', icon: '' })
    expect(tabOf(h, 't1').image).toBeUndefined()
    h.host.sweep()
    expect(readdirSync(dir)).toEqual([])
  })

  it('is refused for a private tab (written nowhere) and for a tab that is gone, before any dialog', async () => {
    const h = harness({ picks: [choose('logo.png', png(640, 480))] })
    expect(await runSpaceImageRequest(h.store, h.host, { op: 'pick-tab', tabId: 't-private' })).toEqual({ ok: false, message: 'Un onglet privé ne garde pas d’image.' })
    expect(await runSpaceImageRequest(h.store, h.host, { op: 'pick-tab', tabId: 'gone' })).toEqual({ ok: false, message: 'Cet onglet n’existe plus.' })
    expect(h.chosen()).toBe(0)
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([])
  })

  it('is let go of when its file is damaged: the tab shows its site’s icon again', async () => {
    const h = harness({ picks: [choose('logo.png', png(640, 480))] })
    await runSpaceImageRequest(h.store, h.host, { op: 'pick-tab', tabId: 't1' })
    const name = tabOf(h, 't1').image!
    writeFileSync(join(dir, name), 'damaged on the disk')
    expect(await runSpaceImageRequest(h.store, h.host, { op: 'read', name })).toEqual({ ok: false, message: spaceImageUnreadable() })
    expect(tabOf(h, 't1').image).toBeUndefined()
  })
})

describe('the picture of a locked space', () => {
  const LOCKED = frenchSpaces('Cet espace est verrouillé : déverrouillez-le d’abord.')

  it('is not chosen: no dialog opens, no file is copied, and the reply says why', async () => {
    const h = harness({ picks: [choose('me.png', png(640, 480))] })
    h.host.lockedSpaces = () => ['sp2']
    expect(await runSpaceImageRequest(h.store, h.host, { op: 'pick', spaceId: 'sp2' })).toEqual({ ok: false, message: LOCKED })
    expect(h.chosen()).toBe(0)
    expect(h.dispatched).toEqual([])
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([])
  })

  it('is not taken away either', async () => {
    const h = harness({ picks: [choose('me.png', png(640, 480))] })
    await runSpaceImageRequest(h.store, h.host, { op: 'pick', spaceId: 'sp2' })
    const name = h.state().spaces.find((s) => s.id === 'sp2')!.image!
    h.host.lockedSpaces = () => ['sp2']
    expect(await runSpaceImageRequest(h.store, h.host, { op: 'clear', spaceId: 'sp2' })).toEqual({ ok: false, message: LOCKED })
    expect(h.state().spaces.find((s) => s.id === 'sp2')!.image).toBe(name)
    expect(existsSync(join(dir, name))).toBe(true)
  })

  it('stays named, with its file, when it is found damaged: the space is changed once unlocked, not before', async () => {
    const h = harness({ picks: [choose('me.png', png(640, 480))] })
    await runSpaceImageRequest(h.store, h.host, { op: 'pick', spaceId: 'sp2' })
    const name = h.state().spaces.find((s) => s.id === 'sp2')!.image!
    writeFileSync(join(dir, name), 'damaged on the disk')
    h.host.lockedSpaces = () => ['sp2']
    h.dispatched.length = 0
    expect(await runSpaceImageRequest(h.store, h.host, { op: 'read', name })).toEqual({ ok: false, message: spaceImageUnreadable() })
    expect(h.dispatched).toEqual([])
    expect(h.state().spaces.find((s) => s.id === 'sp2')!.image).toBe(name)
    expect(existsSync(join(dir, name))).toBe(true)
    h.host.lockedSpaces = () => []
    await runSpaceImageRequest(h.store, h.host, { op: 'read', name })
    expect(h.state().spaces.find((s) => s.id === 'sp2')!.image).toBeUndefined()
    expect(existsSync(join(dir, name))).toBe(false)
  })
})
