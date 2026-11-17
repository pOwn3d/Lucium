import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, clipboard, ClipboardItem, Notification, shell } from 'electron'
import { parseAnnotateDone, type AnnotateReply, type PictureSize } from '@shared/annotate'
import type { OverlayRequest } from '@shared/ipc'
import { firstFree } from '../persist'
import type { Browser } from './browser'
import type { HeldCapture } from './capture-shelf'
import { noteFailure } from './failure-notice'
import { renderPortrait } from './portrait'
import { t } from '@shared/i18n'

/**
 * What the capture flow needs of the browser: with "Annoter les captures" on, a capture waits in the browser for the sheet instead of being
 * saved. A test gives its own.
 */
export interface CaptureHost {
  holdCapture(png: Buffer, suffix: string): ({ id: string } & PictureSize) | null
  openOverlay(request: OverlayRequest): void
  currentOverlay(): OverlayRequest | null
  dropCapture(id?: string): void
}

/**
 * Where a fresh capture goes. Without the annotation sheet (the setting is off, or the picture is not one it can take) it is saved and copied
 * at once, as every capture always was: returns the path. With it, the capture is held and the sheet opens: returns null, and nothing is
 * written until the user chooses (see `finishAnnotation`).
 */
export async function deliverCapture(host: CaptureHost, png: Buffer, suffix: string): Promise<string | null> {
  const held = host.holdCapture(png, suffix)
  if (!held) return saveCapture(png, suffix)
  host.openOverlay({ panel: 'annotate', id: held.id, width: held.width, height: held.height })
  const open = host.currentOverlay()
  if (open?.panel === 'annotate' && open.id === held.id) return null
  // Another panel kept the place (a page's box is waiting for an answer): the capture is saved as it always was, not lost with the sheet.
  host.dropCapture(held.id)
  console.warn('[capture] the annotation sheet could not open; the capture was saved as it is')
  return saveCapture(png, suffix)
}

/** Saves a capture of the active page in Pictures/Lucium, copies it to the clipboard and tells the user. In a split view: the pane the user is in. */
export async function captureActivePage(browser: Browser, full: boolean): Promise<string | null> {
  browser.followPaneFocus()
  const png = await browser.capture(full)
  return png ? deliverCapture(browser, png, full ? '-page-entiere' : '') : null
}

/** Same, for a rectangle the user drew over the page. */
export async function captureSelection(browser: Browser, rect: { x: number; y: number; width: number; height: number }): Promise<string | null> {
  const png = await browser.captureRegion(rect)
  return png ? deliverCapture(browser, png, '-zone') : null
}

/**
 * The rectangle the user drew, taken; a capture that fails is told to the user (a toast) and not only written in the journal, like the captures of the menu: the
 * selection layer is already gone, so nothing else would say that the picture was not made.
 */
export async function captureSelectionOrTell(browser: Browser, rect: { x: number; y: number; width: number; height: number }, toast: (message: string) => void): Promise<void> {
  try {
    await captureSelection(browser, rect)
  } catch (error) {
    noteFailure('[capture] region capture failed:', error, toast, t('capture.la-capture-de-la-zone-n-a-pas-pu-etre-faite'))
  }
}

/**
 * The capture asked from the bar of the selection layer (« Page entière », « Fenêtre visible »). The layer goes first, so that the picture is the page and
 * not the layer over it. A capture that fails is told with a toast, like the selection's: the layer is gone, so nothing else would say that no picture was made.
 */
export function captureFromLayer(browser: Browser, full: boolean): Promise<void> {
  browser.closeOverlay()
  return captureActivePage(browser, full).then(
    () => undefined,
    (error: unknown) => noteFailure(`[capture] ${full ? 'full-page' : 'visible-page'} capture failed:`, error, (message) => browser.showToast(message), t('capture.la-capture-de-la-page-n-a-pas-pu-etre-faite'))
  )
}

/** "Capture in Portrait Mode": the visible part of the page on a tall canvas in the colour of the site. */
export async function captureActivePagePortrait(browser: Browser): Promise<string | null> {
  browser.followPaneFocus()
  const png = await browser.capture(false)
  if (!png) return null
  const portrait = await renderPortrait(png, await browser.siteColor())
  return portrait ? deliverCapture(browser, portrait, '-portrait') : null
}

/** `copy: false` writes the file only (the annotation sheet has a button for each); `notify: false` stays silent (the share menu follows). */
export interface SaveOptions {
  copy?: boolean
  notify?: boolean
}

/** The folder of Pictures the captures are saved in. */
export const CAPTURE_FOLDER = 'Lucium'

export async function saveCapture(png: Buffer, suffix: string, { copy = true, notify = true }: SaveOptions = {}): Promise<string> {
  const dir = join(app.getPath('pictures'), CAPTURE_FOLDER)
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  // Two captures of the same kind in the same second would otherwise have the same name, and the second would replace the first.
  const path = firstFree(join(dir, `capture-${stamp}${suffix}`), '.png')
  writeFileSync(path, png)
  if (copy) await copyCapture(png)
  if (notify) {
    const notification = new Notification({ title: t('capture.capture-enregistree'), body: copy ? `${path}\n${t('capture.copiee-dans-le-presse-papiers')}` : path, silent: true })
    notification.on('click', () => shell.showItemInFolder(path))
    notification.show()
  }
  return path
}

export async function copyCapture(png: Buffer): Promise<void> {
  // Electron 45's clipboard is asynchronous and follows the W3C ClipboardItem model.
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })])
}

// ---------- the annotation sheet's choice ----------

export interface AnnotateHost extends CaptureHost {
  heldCapture(id: unknown): HeldCapture | null
  closeOverlay(): void
  showToast(message: string): void
  /** Opens the system share menu for a file. */
  shareFile(path: string): void
  /** Opens a file with the application the system gives it (Aperçu for a picture). */
  openFile(path: string): void
}

const FAILURE: Record<'copy' | 'save' | 'share' | 'open', string> = {
  get copy() { return t('capture.la-capture-n-a-pas-pu-etre-copiee') },
  get save() { return t('capture.la-capture-n-a-pas-pu-etre-enregistree') },
  get share() { return t('capture.la-capture-n-a-pas-pu-etre-partagee') },
  get open() { return t('capture.la-capture-n-a-pas-pu-etre-ouverte') }
}

/**
 * The user chose in the sheet: copy, save or share the picture drawn on. The request is checked against the capture the sheet is open for
 * (its id, the PNG and its size); the answer says how it went, and the sheet closes only on success, so that a failure does not lose the work.
 * Sharing needs a file, so the picture is saved first (in Pictures/Lucium, like any capture) and the share menu is opened on it.
 */
export async function finishAnnotation(host: AnnotateHost, raw: unknown): Promise<AnnotateReply> {
  const id = typeof raw === 'object' && raw !== null ? (raw as { id?: unknown }).id : undefined
  const held = host.heldCapture(id)
  if (!held) return { ok: false, message: t('annotate-sheet.cette-capture-n-est-plus-disponible') }
  const parsed = parseAnnotateDone(raw, held)
  if (!parsed.ok) {
    console.warn(`[capture] the annotation sheet sent a request that was refused (${parsed.reason})`)
    return { ok: false, message: t('capture.l-image-envoyee-par-la-feuille-n-est-pas-valide') }
  }
  const { action } = parsed.request
  const png = Buffer.from(parsed.request.png.buffer, parsed.request.png.byteOffset, parsed.request.png.byteLength)
  const suffix = `${held.suffix}-annote`
  try {
    if (action === 'copy') {
      await copyCapture(png)
      host.showToast(t('capture.capture-copiee-dans-le-presse-papiers'))
    } else if (action === 'save') {
      await saveCapture(png, suffix, { copy: false })
    } else if (action === 'open') {
      // Saved in Images/Lucium, then opened with the application the system gives pictures (Aperçu): the sheet goes first.
      const path = await saveCapture(png, suffix, { copy: false, notify: false })
      host.dropCapture(held.id)
      host.closeOverlay()
      host.openFile(path)
      return { ok: true }
    } else {
      const path = await saveCapture(png, suffix, { copy: false, notify: false })
      // The sheet goes first: the menu opens over the page, not under the dimmed layer.
      host.dropCapture(held.id)
      host.closeOverlay()
      host.shareFile(path)
      return { ok: true }
    }
  } catch (error) {
    console.error(`[capture] annotated capture: ${action} failed:`, error)
    return { ok: false, message: `${FAILURE[action]} ${error instanceof Error ? error.message : ''}`.trim() }
  }
  host.dropCapture(held.id)
  host.closeOverlay()
  return { ok: true }
}
