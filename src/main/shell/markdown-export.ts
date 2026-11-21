// Export of a page as Markdown (File › Export the page as Markdown…, "Copy as Markdown" in the page menu, the command bar). The page side
// (engine/markdown-picker.ts) lets the user choose what to keep and hands back a snapshot; shared/markdown-export.ts turns it into
// Markdown; this file asks the user where it goes and puts it there: the clipboard, a .md file, or a .zip with the images of the page.
// No state is kept anywhere: nothing here depends on the window being private. Copying writes nothing to disk, and saving writes the one
// file the user chose, as File › Save Page As does; the images, if any, come with the session of the tab (a private window's own).

import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { clipboard, dialog, shell, type BrowserWindow } from 'electron'
import { exportFileName, exportMarkdown, folderImageLink, imagesFolderName, markdownWithImages, parsePick, parseReply, safeUrl, type MdPick, type MdResult } from '@shared/markdown-export'
import { createZip } from '@shared/zip'
import type { Page } from '../engine/types'
import { t } from '@shared/i18n'
import { assertTestRun } from '../test-seam'

/** The tab that is exported, and the window that shows what the export has to say. */
export interface MarkdownTarget {
  page: Page
  win: BrowserWindow
  url: string
  title: string
  /** The tab, or the window, is private: saving its page is said first (see `savePage`). */
  private?: boolean
  toast(message: string, action?: { label: string; run: () => void }): void
}

/** What the user is asked, and what they are told when something goes wrong. A seam for the engine test, which answers without a dialog. */
export interface MarkdownUi {
  /** "With the images?" after a save of a page that has some: an archive, the text alone, or nothing (null: the user gave up). */
  askImages(win: BrowserWindow, count: number): Promise<'zip' | 'md' | null>
  /** The save dialog; null when the user gave up. */
  chooseSave(win: BrowserWindow, name: string, extension: 'md' | 'zip'): Promise<string | null>
  /** Before a page of a private tab is written to disk: the user agrees to leave a trace of it, or not. */
  confirmPrivate(win: BrowserWindow): Promise<boolean>
  fail(title: string, message: string): void
  reveal(path: string): void
}

const realUi: MarkdownUi = {
  async askImages(win, count) {
    const answer = await dialog.showMessageBox(win, {
      type: 'question',
      message: count > 1 ? t('markdown-export.enregistrer-avec-les-images', { count }) : t('markdown-export.enregistrer-avec-l-image'),
      detail: t('markdown-export.avec-ou-sans-les-images-detail'),
      buttons: [t('markdown-export.avec-les-images-zip'), t('markdown-export.texte-seul-md'), t('markdown-export.annuler')],
      defaultId: 0,
      cancelId: 2
    })
    return answer.response === 0 ? 'zip' : answer.response === 1 ? 'md' : null
  },
  async chooseSave(win, name, extension) {
    const saved = await dialog.showSaveDialog(win, {
      get title() { return t('markdown-export.exporter-en-markdown') },
      defaultPath: name,
      filters: [extension === 'md' ? { name: 'Markdown', extensions: ['md'] } : { name: t('markdown-export.archive-zip'), extensions: ['zip'] }]
    })
    return saved.canceled || !saved.filePath ? null : saved.filePath
  },
  async confirmPrivate(win) {
    const answer = await dialog.showMessageBox(win, {
      type: 'warning',
      message: t('markdown-export.page-privee-enregistrer'),
      detail: t('markdown-export.page-privee-enregistrer-detail'),
      buttons: [t('markdown-export.enregistrer-quand-meme'), t('markdown-export.annuler')],
      defaultId: 1,
      cancelId: 1
    })
    return answer.response === 0
  },
  fail: (title, message) => dialog.showErrorBox(title, message),
  reveal: (path) => shell.showItemInFolder(path)
}

let ui: MarkdownUi = realUi

/** Replaces the dialogs (engine test only); returns what puts the real ones back. */
export function setMarkdownUi(replacement: MarkdownUi): () => void {
  assertTestRun('setMarkdownUi')
  ui = replacement
  return () => {
    ui = realUi
  }
}

/** Read when it is shown: the language of the interface can change while the application runs. */
const notAWebPage = (): string => t('markdown-export.export-reserve-aux-pages-web')

/** What a copy tells the user about the parts it could not convert. */
function copiedNotice(result: MdResult): string {
  if (result.warnings.length === 0) return t('markdown-export.markdown-copie')
  return result.warnings.length === 1 ? t('markdown-export.markdown-copie-warning', { warning: result.warnings[0]! }) : t('markdown-export.markdown-copie-length-elements-non-convertis', { length: result.warnings.length })
}

/** The report of what an archive does not hold: images that stayed links, parts of the page that could not be converted. */
function report(failures: readonly string[], warnings: readonly string[]): string {
  return `${t('markdown-export.ressources-non-incluses')}\n\n${[...failures, ...warnings].join('\n')}\n`
}

async function save(target: MarkdownTarget, result: MdResult): Promise<void> {
  let archive = false
  if (result.images.length > 0) {
    const choice = await ui.askImages(target.win, result.images.length)
    if (choice === null) return
    archive = choice === 'zip'
  }
  const extension = archive ? 'zip' : 'md'
  const path = await ui.chooseSave(target.win, exportFileName(target.title, extension), extension)
  if (!path) return
  try {
    if (!archive) {
      await writeFile(path, result.markdown, 'utf8')
      target.toast(t('browser.enregistre-name', { name: basename(path) }), { label: t('browser.afficher'), run: () => ui.reveal(path) })
      return
    }
    target.toast(result.images.length > 1 ? t('markdown-export.telechargement-des-images', { count: result.images.length }) : t('markdown-export.telechargement-de-l-image'))
    const downloaded = await target.page.downloadImages(result.images, { referrer: target.url })
    const local = new Map(downloaded.files.map((file) => [file.reference, file.name]))
    const encoder = new TextEncoder()
    const entries = [{ name: 'page.md', data: encoder.encode(markdownWithImages(result, local)) }, ...downloaded.files.map((file) => ({ name: file.name, data: file.data }))]
    if (downloaded.failures.length > 0 || result.warnings.length > 0) entries.push({ name: 'bilan.txt', data: encoder.encode(report(downloaded.failures, result.warnings)) })
    await writeFile(path, createZip(entries))
    const kept = downloaded.files.length
    const saved = { name: basename(path), kept, total: result.images.length }
    target.toast(result.images.length > 1 ? t('markdown-export.enregistre-name-images', saved) : t('markdown-export.enregistre-name-image', saved), { label: t('browser.afficher'), run: () => ui.reveal(path) })
  } catch (error) {
    console.error('[markdown] cannot save the export:', error)
    ui.fail(t('browser.enregistrement-impossible'), `${path}\n\n${String((error as Error).message ?? error)}`)
  }
}

/** What the user chose in the picker, done: copied, or saved. */
async function finish(target: MarkdownTarget, pick: MdPick): Promise<void> {
  const blocks = pick.scope === 'blocks'
  // A page's own title and address go first and last when whole blocks of it are exported; a few selected words stay a few words.
  const result = exportMarkdown(pick.snapshot, { url: target.url, title: target.title, withTitle: blocks, withSource: blocks })
  if (!result) return ui.fail(t('boostshare.export-impossible'), t('markdown-export.la-page-a-repondu-autre-chose-qu-un-contenu-a'))
  if (!result.markdown) return target.toast(t('markdown-export.rien-a-exporter'))
  if (pick.action === 'copy') {
    try {
      await clipboard.writeText(result.markdown)
    } catch (error) {
      console.error('[markdown] cannot write to the clipboard:', error)
      return ui.fail(t('markdown-export.copie-impossible'), String((error as Error).message ?? error))
    }
    return target.toast(copiedNotice(result))
  }
  await save(target, result)
}

/** File › Export the page as Markdown… : the picker over the page, then the copy or the save the user asks for in its bar. */
export async function exportPage(target: MarkdownTarget): Promise<void> {
  if (!safeUrl(target.url, ['http:', 'https:'])) return target.toast(notAWebPage())
  // The keyboard goes to the page: Escape leaves the picker.
  target.page.focus()
  const reply = await target.page.pickMarkdown()
  // The user left, or the page did.
  if (reply === null) return
  const pick = parsePick(reply)
  if (!pick) return ui.fail(t('boostshare.export-impossible'), t('markdown-export.la-page-n-a-pas-renvoye-un-contenu-lisible-trop'))
  if ('error' in pick) return ui.fail(t('boostshare.export-impossible'), pick.error)
  await finish(target, pick)
}

/** "Copy as Markdown" on a text selection (the page's context menu): no picker, no title, no address, straight to the clipboard. */
export async function copySelection(target: MarkdownTarget): Promise<void> {
  if (!safeUrl(target.url, ['http:', 'https:'])) return target.toast(notAWebPage())
  const snapshot = parseReply(await target.page.markdownSelection())
  if (!snapshot) return target.toast(t('markdown-export.aucun-texte-selectionne-a-copier'))
  await finish(target, { action: 'copy', scope: 'selection', snapshot })
}

/**
 * Creates the images folder beside the .md and says its name. A folder (or a file, or a link) that already has the name is never touched, nor
 * filled: `mkdir` without `recursive` fails on it, and the next free name `<name>-2`, `<name>-3`… is taken instead, so no file of the user is replaced
 * and no file of two saves is mixed.
 */
async function newImagesFolder(parent: string, wanted: string): Promise<string> {
  for (let attempt = 1; attempt <= 1000; attempt++) {
    const name = attempt === 1 ? wanted : `${wanted}-${attempt}`
    try {
      await mkdir(join(parent, name))
      return name
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new Error(`no free folder name for ${wanted}`)
}

/**
 * File › Save the page as Markdown… : the main content of the page, whole, no picker. A .md file with a folder `<name>-images/` beside it, the
 * images linked by relative paths. A private tab is asked about first: the page would leave a trace on disk. The images come from the page's
 * own list, downloaded with the session of the tab, under the same caps as the archive; one that fails stays a link to its site.
 */
export async function savePage(target: MarkdownTarget): Promise<void> {
  if (!safeUrl(target.url, ['http:', 'https:'])) return target.toast(notAWebPage())
  if (target.private === true && !(await ui.confirmPrivate(target.win))) return
  const pick = parsePick(await target.page.markdownPage())
  if (!pick) return ui.fail(t('boostshare.export-impossible'), t('markdown-export.la-page-n-a-pas-renvoye-un-contenu-lisible-trop'))
  if ('error' in pick) return ui.fail(t('boostshare.export-impossible'), pick.error)
  const result = exportMarkdown(pick.snapshot, { url: target.url, title: target.title, withTitle: true, withSource: true })
  if (!result) return ui.fail(t('boostshare.export-impossible'), t('markdown-export.la-page-a-repondu-autre-chose-qu-un-contenu-a'))
  if (!result.markdown) return target.toast(t('markdown-export.rien-a-exporter-page'))
  const path = await ui.chooseSave(target.win, exportFileName(target.title, 'md'), 'md')
  if (!path) return
  try {
    const local = new Map<string, string>()
    let kept = 0
    if (result.images.length > 0) {
      target.toast(result.images.length > 1 ? t('markdown-export.telechargement-des-images', { count: result.images.length }) : t('markdown-export.telechargement-de-l-image'))
      const downloaded = await target.page.downloadImages(result.images, { referrer: target.url })
      if (downloaded.files.length > 0) {
        const folder = await newImagesFolder(dirname(path), imagesFolderName(basename(path)))
        // The archive names its files `images/image-001.png`; here they sit straight in the folder. The folder was just created by us, so nothing of the user's is replaced.
        for (const file of downloaded.files) await writeFile(join(dirname(path), folder, file.name.replace(/^images\//, '')), file.data)
        for (const file of downloaded.files) local.set(file.reference, folderImageLink(folder, file.name))
      }
      kept = downloaded.files.length
      for (const failure of downloaded.failures) console.warn('[markdown] image kept as a link:', failure)
    }
    await writeFile(path, markdownWithImages(result, local), 'utf8')
    const saved = { name: basename(path), kept, total: result.images.length }
    const message = result.images.length === 0 ? t('browser.enregistre-name', { name: saved.name }) : result.images.length > 1 ? t('markdown-export.enregistre-name-images', saved) : t('markdown-export.enregistre-name-image', saved)
    target.toast(message, { label: t('browser.afficher'), run: () => ui.reveal(path) })
  } catch (error) {
    console.error('[markdown] cannot save the page:', error)
    ui.fail(t('browser.enregistrement-impossible'), `${path}\n\n${String((error as Error).message ?? error)}`)
  }
}
