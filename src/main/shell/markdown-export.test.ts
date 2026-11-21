import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { Page } from '../engine/types'

const clipboard = vi.hoisted(() => ({ writeText: vi.fn() }))
vi.mock('electron', () => ({ clipboard, dialog: {}, shell: {} }))

import { copySelection, exportPage, savePage, setMarkdownUi, type MarkdownTarget, type MarkdownUi } from './markdown-export'
import { frenchSpaces } from '@shared/french-typography'

const PAGE = 'https://example.com/docs/a'
const snapshot = (nodes: unknown, extra: object = {}) => ({ nodes, warnings: [], truncated: false, ...extra })
const picked = (action: 'copy' | 'save', scope: 'blocks' | 'selection', nodes: unknown, extra: object = {}) => JSON.stringify({ action, scope, snapshot: snapshot(nodes, extra) })
const WITH_IMAGES = [{ t: 'p', c: ['Un chat ', { t: 'img', a: { src: 'https://img.example.com/cat.png', alt: 'chat' } }, { t: 'img', a: { src: 'https://img.example.com/dog.jpg', alt: 'chien' } }] }]

let dir: string
let page: { focus: ReturnType<typeof vi.fn>; pickMarkdown: ReturnType<typeof vi.fn>; markdownSelection: ReturnType<typeof vi.fn>; markdownPage: ReturnType<typeof vi.fn>; downloadImages: ReturnType<typeof vi.fn> }
let ui: { [K in keyof MarkdownUi]: ReturnType<typeof vi.fn> }
let toasts: Array<{ message: string; action?: { label: string; run: () => void } }>
let restore: () => void

const target = (extra: Partial<MarkdownTarget> = {}): MarkdownTarget => ({
  page: page as unknown as Page,
  win: {} as BrowserWindow,
  url: PAGE,
  title: 'Cours : Markdown',
  toast: (message, action) => toasts.push({ message, action }),
  ...extra
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lucium-md-'))
  toasts = []
  clipboard.writeText.mockReset().mockResolvedValue(undefined)
  page = { focus: vi.fn(), pickMarkdown: vi.fn(), markdownSelection: vi.fn(), markdownPage: vi.fn(), downloadImages: vi.fn() }
  ui = { askImages: vi.fn(), chooseSave: vi.fn(), confirmPrivate: vi.fn(), fail: vi.fn(), reveal: vi.fn() }
  restore = setMarkdownUi(ui as unknown as MarkdownUi)
})

afterEach(() => {
  restore()
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('exportPage', () => {
  it('asks for a web page only, and shows no picker for another', async () => {
    for (const url of ['about:blank', 'file:///tmp/a.html', 'chrome-extension://abc/page.html', '']) {
      await exportPage(target({ url }))
    }
    expect(page.pickMarkdown).not.toHaveBeenCalled()
    expect(toasts.map((t) => t.message)).toEqual(Array(4).fill('L’export en Markdown n’est possible que pour une page web.'))
  })

  it('gives the page the keyboard, then shows the picker', async () => {
    page.pickMarkdown.mockResolvedValue(null)
    await exportPage(target())
    expect(page.focus).toHaveBeenCalledBefore(page.pickMarkdown)
    expect(page.pickMarkdown).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the user leaves the picker', async () => {
    page.pickMarkdown.mockResolvedValue(null)
    await exportPage(target())
    expect(toasts).toEqual([])
    expect(clipboard.writeText).not.toHaveBeenCalled()
    expect(ui.fail).not.toHaveBeenCalled()
    expect(ui.chooseSave).not.toHaveBeenCalled()
  })

  it('tells the user when the page sends something unreadable, or says it failed', async () => {
    for (const reply of ['not json', '{"action":"copy"}', 'x'.repeat(40_000_001)]) {
      page.pickMarkdown.mockResolvedValue(reply)
      await exportPage(target())
    }
    expect(ui.fail).toHaveBeenCalledTimes(3)
    expect(ui.fail).toHaveBeenCalledWith('Export impossible', expect.stringContaining('illisible'))
    page.pickMarkdown.mockResolvedValue(JSON.stringify({ error: 'la page a refusé' }))
    await exportPage(target())
    expect(ui.fail).toHaveBeenLastCalledWith('Export impossible', 'la page a refusé')
    expect(clipboard.writeText).not.toHaveBeenCalled()
  })

  it('tells the user when what was chosen has no text, and copies nothing', async () => {
    page.pickMarkdown.mockResolvedValue(picked('copy', 'blocks', [{ t: 'div', c: [' '] }]))
    await exportPage(target())
    expect(clipboard.writeText).not.toHaveBeenCalled()
    expect(toasts.map((t) => t.message)).toEqual([frenchSpaces('Rien à exporter : ce que vous avez choisi ne contient aucun texte')])
  })

  it('copies blocks with the title of the page first and its address last', async () => {
    page.pickMarkdown.mockResolvedValue(picked('copy', 'blocks', [{ t: 'p', c: ['Bonjour'] }]))
    await exportPage(target())
    expect(clipboard.writeText).toHaveBeenCalledWith('# Cours : Markdown\n\nBonjour\n\nSource\u00a0: <https://example.com/docs/a>\n')
    expect(toasts.map((t) => t.message)).toEqual(['Markdown copié'])
  })

  it('copies a selection as it is, with no title and no address', async () => {
    page.pickMarkdown.mockResolvedValue(picked('copy', 'selection', ['quelques mots']))
    await exportPage(target())
    expect(clipboard.writeText).toHaveBeenCalledWith('quelques mots\n')
  })

  it('says what could not be converted in the notice of a copy', async () => {
    page.pickMarkdown.mockResolvedValue(picked('copy', 'selection', ['x'], { warnings: ['iframe : contenu non converti.'] }))
    await exportPage(target())
    page.pickMarkdown.mockResolvedValue(picked('copy', 'selection', ['x'], { warnings: ['a', 'b', 'c'] }))
    await exportPage(target())
    expect(toasts.map((t) => t.message)).toEqual(['Markdown copié · iframe : contenu non converti.', 'Markdown copié · 3 éléments non convertis'])
  })

  it('tells the user when the clipboard refuses, instead of announcing a copy', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    clipboard.writeText.mockRejectedValue(new Error('clipboard busy'))
    page.pickMarkdown.mockResolvedValue(picked('copy', 'selection', ['x']))
    await exportPage(target())
    expect(ui.fail).toHaveBeenCalledWith('Copie impossible', 'clipboard busy')
    expect(toasts).toEqual([])
    expect(error).toHaveBeenCalledWith('[markdown] cannot write to the clipboard:', expect.any(Error))
  })
})

describe('saving', () => {
  it('writes a .md file named after the page, without asking about images when there are none', async () => {
    const path = join(dir, 'Cours - Markdown.md')
    page.pickMarkdown.mockResolvedValue(picked('save', 'blocks', [{ t: 'h2', c: ['Plan'] }]))
    ui.chooseSave.mockResolvedValue(path)
    await exportPage(target())
    expect(ui.askImages).not.toHaveBeenCalled()
    expect(ui.chooseSave).toHaveBeenCalledWith(expect.anything(), 'Cours - Markdown.md', 'md')
    expect(readFileSync(path, 'utf8')).toBe('# Cours : Markdown\n\n## Plan\n\nSource\u00a0: <https://example.com/docs/a>\n')
    expect(toasts.map((t) => t.message)).toEqual(['Enregistré\u00a0: Cours - Markdown.md'])
    toasts[0]!.action!.run()
    expect(ui.reveal).toHaveBeenCalledWith(path)
  })

  it('writes nothing when the user gives up at the dialog', async () => {
    page.pickMarkdown.mockResolvedValue(picked('save', 'blocks', [{ t: 'p', c: ['x'] }]))
    ui.chooseSave.mockResolvedValue(null)
    await exportPage(target())
    expect(toasts).toEqual([])
    expect(ui.fail).not.toHaveBeenCalled()
  })

  it('asks about the images when the page has some, and writes the text alone with their links when told to', async () => {
    const path = join(dir, 'a.md')
    page.pickMarkdown.mockResolvedValue(picked('save', 'blocks', WITH_IMAGES))
    ui.askImages.mockResolvedValue('md')
    ui.chooseSave.mockResolvedValue(path)
    await exportPage(target())
    expect(ui.askImages).toHaveBeenCalledWith(expect.anything(), 2)
    expect(ui.chooseSave).toHaveBeenCalledWith(expect.anything(), 'Cours - Markdown.md', 'md')
    expect(page.downloadImages).not.toHaveBeenCalled()
    expect(readFileSync(path, 'utf8')).toContain('[image-1]: https://img.example.com/cat.png\n[image-2]: https://img.example.com/dog.jpg\n')
  })

  it('goes no further when the user gives up at the question about the images', async () => {
    page.pickMarkdown.mockResolvedValue(picked('save', 'blocks', WITH_IMAGES))
    ui.askImages.mockResolvedValue(null)
    await exportPage(target())
    expect(ui.chooseSave).not.toHaveBeenCalled()
    expect(page.downloadImages).not.toHaveBeenCalled()
  })

  it('writes an archive with the Markdown, the images, and a report of those that stayed links', async () => {
    const path = join(dir, 'a.zip')
    page.pickMarkdown.mockResolvedValue(picked('save', 'blocks', WITH_IMAGES))
    ui.askImages.mockResolvedValue('zip')
    ui.chooseSave.mockResolvedValue(path)
    page.downloadImages.mockResolvedValue({ files: [{ reference: 'image-1', name: 'images/image-001.png', data: Uint8Array.from([137, 80, 78, 71]) }], failures: [frenchSpaces('https://img.example.com/dog.jpg : HTTP 404. Lien conservé.')] })
    await exportPage(target())
    expect(ui.chooseSave).toHaveBeenCalledWith(expect.anything(), 'Cours - Markdown.zip', 'zip')
    // Only the addresses the page itself lists are asked for, with the page as referrer.
    expect(page.downloadImages).toHaveBeenCalledWith([expect.objectContaining({ reference: 'image-1', url: 'https://img.example.com/cat.png' }), expect.objectContaining({ reference: 'image-2', url: 'https://img.example.com/dog.jpg' })], { referrer: PAGE })
    const zip = readFileSync(path).toString('utf8')
    expect(zip.startsWith('PK')).toBe(true)
    // Stored, not compressed: the names and the texts can be read as they are.
    for (const name of ['page.md', 'images/image-001.png', 'bilan.txt']) expect(zip).toContain(name)
    expect(zip).toContain('[image-1]: images/image-001.png\n[image-2]: https://img.example.com/dog.jpg\n')
    expect(zip).toContain(frenchSpaces('https://img.example.com/dog.jpg : HTTP 404. Lien conservé.'))
    expect(toasts.map((t) => t.message)).toEqual(['Téléchargement de 2 images…', frenchSpaces('Enregistré : a.zip · 1/2 images')])
  })

  it('leaves the report out of an archive when everything came', async () => {
    const path = join(dir, 'b.zip')
    page.pickMarkdown.mockResolvedValue(picked('save', 'blocks', [{ t: 'p', c: [{ t: 'img', a: { src: 'https://img.example.com/cat.png' } }] }]))
    ui.askImages.mockResolvedValue('zip')
    ui.chooseSave.mockResolvedValue(path)
    page.downloadImages.mockResolvedValue({ files: [{ reference: 'image-1', name: 'images/image-001.png', data: Uint8Array.from([1]) }], failures: [] })
    await exportPage(target())
    expect(readFileSync(path).toString('utf8')).not.toContain('bilan.txt')
    expect(toasts.map((t) => t.message)).toEqual(['Téléchargement de l’image…', frenchSpaces('Enregistré : b.zip · 1/1 image')])
  })

  it('tells the user when the file cannot be written, and does not announce a save', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const path = join(dir, 'missing folder', 'a.md')
    page.pickMarkdown.mockResolvedValue(picked('save', 'blocks', [{ t: 'p', c: ['x'] }]))
    ui.chooseSave.mockResolvedValue(path)
    await exportPage(target())
    expect(existsSync(path)).toBe(false)
    expect(ui.fail).toHaveBeenCalledWith('Enregistrement impossible', expect.stringContaining(path))
    expect(toasts).toEqual([])
    expect(error).toHaveBeenCalledWith('[markdown] cannot save the export:', expect.any(Error))
  })

  it('tells the user when the archive cannot be written after the download', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    page.pickMarkdown.mockResolvedValue(picked('save', 'blocks', WITH_IMAGES))
    ui.askImages.mockResolvedValue('zip')
    ui.chooseSave.mockResolvedValue(join(dir, 'nowhere', 'a.zip'))
    page.downloadImages.mockResolvedValue({ files: [], failures: [] })
    await exportPage(target())
    expect(ui.fail).toHaveBeenCalledWith('Enregistrement impossible', expect.any(String))
    expect(toasts.map((t) => t.message)).toEqual(['Téléchargement de 2 images…'])
  })
})

describe('copySelection', () => {
  it('copies the selection of the page as Markdown, with nothing added', async () => {
    page.markdownSelection.mockResolvedValue(JSON.stringify(snapshot([{ t: 'p', c: ['un ', { t: 'b', c: ['mot'] }] }])))
    await copySelection(target())
    expect(clipboard.writeText).toHaveBeenCalledWith('un **mot**\n')
    expect(toasts.map((t) => t.message)).toEqual(['Markdown copié'])
  })

  it('says so when nothing is selected, or the page does not answer', async () => {
    for (const reply of [null, 'not json', '[]']) {
      page.markdownSelection.mockResolvedValue(reply)
      await copySelection(target())
    }
    expect(clipboard.writeText).not.toHaveBeenCalled()
    expect(toasts.map((t) => t.message)).toEqual(Array(3).fill('Aucun texte sélectionné à copier'))
  })

  it('works on web pages only', async () => {
    await copySelection(target({ url: 'about:blank' }))
    expect(page.markdownSelection).not.toHaveBeenCalled()
    expect(toasts).toHaveLength(1)
  })
})

describe('savePage', () => {
  const whole = (nodes: unknown = WITH_IMAGES) => JSON.stringify({ action: 'save', scope: 'blocks', snapshot: snapshot(nodes) })
  const downloaded = (files: Array<{ reference: string; name: string }>, failures: string[] = []) => ({
    files: files.map((f) => ({ ...f, data: new Uint8Array([1, 2, 3]) })),
    failures
  })

  it('asks for a web page only, and reads nothing from another', async () => {
    for (const url of ['about:blank', 'file:///tmp/a.html', '']) await savePage(target({ url }))
    expect(page.markdownPage).not.toHaveBeenCalled()
    expect(toasts).toHaveLength(3)
  })

  it('writes the .md with its images in a folder beside it, linked by relative paths', async () => {
    page.markdownPage.mockResolvedValue(whole())
    ui.chooseSave.mockResolvedValue(join(dir, 'Cours.md'))
    page.downloadImages.mockResolvedValue(downloaded([{ reference: 'image-1', name: 'images/image-001.png' }, { reference: 'image-2', name: 'images/image-002.jpg' }]))
    await savePage(target())
    expect(ui.chooseSave).toHaveBeenCalledWith(expect.anything(), 'Cours - Markdown.md', 'md')
    const markdown = readFileSync(join(dir, 'Cours.md'), 'utf8')
    expect(markdown).toContain('[image-1]: Cours-images/image-001.png')
    expect(markdown).toContain('[image-2]: Cours-images/image-002.jpg')
    expect(markdown).not.toContain('img.example.com')
    expect(readFileSync(join(dir, 'Cours-images', 'image-001.png'))).toHaveLength(3)
    expect(existsSync(join(dir, 'Cours-images', 'images'))).toBe(false)
    expect(toasts.at(-1)!.message).toBe(frenchSpaces('Enregistré : Cours.md · 2/2 images'))
  })

  it('keeps as a link the image that could not be downloaded, and says how many were kept', async () => {
    page.markdownPage.mockResolvedValue(whole())
    ui.chooseSave.mockResolvedValue(join(dir, 'a b.md'))
    page.downloadImages.mockResolvedValue(downloaded([{ reference: 'image-1', name: 'images/image-001.png' }], ['dog: HTTP 404']))
    await savePage(target())
    const markdown = readFileSync(join(dir, 'a b.md'), 'utf8')
    expect(markdown).toContain('[image-1]: a%20b-images/image-001.png')
    expect(markdown).toContain('[image-2]: https://img.example.com/dog.jpg')
    expect(toasts.at(-1)!.message).toBe(frenchSpaces('Enregistré : a b.md · 1/2 images'))
  })

  it('makes no folder when no image could be kept, and none for a page without images', async () => {
    page.markdownPage.mockResolvedValue(whole())
    ui.chooseSave.mockResolvedValue(join(dir, 'none.md'))
    page.downloadImages.mockResolvedValue(downloaded([], ['x']))
    await savePage(target())
    expect(existsSync(join(dir, 'none-images'))).toBe(false)
    page.markdownPage.mockResolvedValue(whole([{ t: 'p', c: ['Seul'] }]))
    ui.chooseSave.mockResolvedValue(join(dir, 'text.md'))
    page.downloadImages.mockClear()
    await savePage(target())
    expect(page.downloadImages).not.toHaveBeenCalled()
    expect(readFileSync(join(dir, 'text.md'), 'utf8')).toContain('Seul')
    expect(toasts.at(-1)!.message).toBe(frenchSpaces('Enregistré : text.md'))
  })

  it('warns before saving a private page, and writes nothing when the user declines', async () => {
    page.markdownPage.mockResolvedValue(whole())
    ui.confirmPrivate.mockResolvedValue(false)
    await savePage(target({ private: true }))
    expect(ui.confirmPrivate).toHaveBeenCalledOnce()
    expect(page.markdownPage).not.toHaveBeenCalled()
    expect(ui.chooseSave).not.toHaveBeenCalled()
    ui.confirmPrivate.mockResolvedValue(true)
    ui.chooseSave.mockResolvedValue(null)
    await savePage(target({ private: true }))
    expect(ui.chooseSave).toHaveBeenCalledOnce()
  })

  it('does not ask about a page that is not private', async () => {
    page.markdownPage.mockResolvedValue(whole())
    ui.chooseSave.mockResolvedValue(null)
    await savePage(target())
    expect(ui.confirmPrivate).not.toHaveBeenCalled()
  })

  it('says so when the page gives nothing readable, when it has no text, and when the disk refuses', async () => {
    page.markdownPage.mockResolvedValue(null)
    await savePage(target())
    expect(ui.fail).toHaveBeenCalledWith('Export impossible', expect.stringContaining('n’a pas renvoyé'))
    page.markdownPage.mockResolvedValue(JSON.stringify({ error: 'boom' }))
    await savePage(target())
    expect(ui.fail).toHaveBeenLastCalledWith('Export impossible', 'boom')
    page.markdownPage.mockResolvedValue(whole([]))
    await savePage(target())
    expect(toasts.at(-1)!.message).toBe(frenchSpaces('Rien à enregistrer : la page ne contient aucun texte'))
    expect(ui.chooseSave).not.toHaveBeenCalled()
    page.markdownPage.mockResolvedValue(whole([{ t: 'p', c: ['x'] }]))
    ui.chooseSave.mockResolvedValue(join(dir, 'missing', 'x.md'))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await savePage(target())
    expect(ui.fail).toHaveBeenLastCalledWith('Enregistrement impossible', expect.stringContaining('x.md'))
  })
})
