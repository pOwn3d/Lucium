// The Electron side of the pictures of spaces: the decoder, the folder, the file dialog. Built when the first picture is asked for and not
// before, so that a browser that never uses the function does nothing for it.
//
// Why a decoder page and not `nativeImage`: Electron's `nativeImage.createFromBuffer` reads PNG and JPEG but returns an empty image for WebP
// (checked on Electron 45). A hostile picture is also better decoded where a crash costs nothing: the bytes go to a page that is sandboxed,
// has no preload and no network, in a session of its own that lives in memory, and that is thrown away after the one picture. What it
// returns is a PNG of 128 px at most, which the store checks again before keeping it.

import { app, dialog, session, WebContentsView, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import type { SidebarState } from '@shared/model'
import { SpaceImageStore, type ImageCodec } from './space-images'
import { sweepStoredImages } from './space-image-sweep'
import { t } from '@shared/i18n'
import { assertTestRun } from '../test-seam'

/** A picture that does not decode within this long is given up on. */
const DECODE_TIMEOUT_MS = 15_000
const DECODER_PARTITION = 'space-image-decoder'

/** The script that runs in the decoder page: crop the middle square, shrink it, hand back the PNG as base64. */
function decodeScript(base64: string, size: number): string {
  return `(async () => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(base64)}), (c) => c.charCodeAt(0))
    const bitmap = await createImageBitmap(new Blob([bytes]))
    const side = Math.min(bitmap.width, bitmap.height)
    const canvas = new OffscreenCanvas(${size}, ${size})
    const context = canvas.getContext('2d')
    context.imageSmoothingQuality = 'high'
    context.drawImage(bitmap, Math.floor((bitmap.width - side) / 2), Math.floor((bitmap.height - side) / 2), side, side, 0, 0, ${size}, ${size})
    bitmap.close()
    const png = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer())
    let text = ''
    for (let i = 0; i < png.length; i += 0x8000) text += String.fromCharCode(...png.subarray(i, i + 0x8000))
    return btoa(text)
  })()`
}

export const decoderCodec: ImageCodec = {
  async shrink(bytes, size) {
    const ses = session.fromPartition(DECODER_PARTITION)
    // Nothing leaves this page, and it asks for nothing: no request but its own blank page, no permission.
    ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('about:') }))
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    const view = new WebContentsView({ webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false } })
    let timer: NodeJS.Timeout | undefined
    try {
      await view.webContents.loadURL('about:blank')
      const answer = await Promise.race([
        view.webContents.executeJavaScript(decodeScript(bytes.toString('base64'), size)) as Promise<unknown>,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('the decoder did not answer in time')), DECODE_TIMEOUT_MS)
        })
      ])
      if (typeof answer !== 'string') throw new Error('the decoder answered with something that is not text')
      return Buffer.from(answer, 'base64')
    } catch (error) {
      // The page rejects with a plain object for a file it cannot decode: keep its words, not "[object Object]".
      const detail = error instanceof Error ? error.message : typeof error === 'object' && error !== null && 'message' in error ? String((error as { message: unknown }).message) : String(error)
      throw new Error(detail)
    } finally {
      if (timer) clearTimeout(timer)
      if (!view.webContents.isDestroyed()) view.webContents.close()
    }
  }
}

let service: SpaceImageStore | null = null

/** The store of the application, made at the first use. */
export function spaceImages(): SpaceImageStore {
  service ??= new SpaceImageStore(join(app.getPath('userData'), 'space-images'), decoderCodec)
  return service
}

/** Deletes the pictures that neither the state nor a copy of the session refers to. */
export function sweepSpaceImages(state: Pick<SidebarState, 'spaces' | 'sessions' | 'tabs'>): number {
  return sweepStoredImages(spaceImages(), state, app.getPath('userData'))
}

/** The engine test replaces the dialog (a native sheet cannot be clicked from a test) with a path of its own. The interface's request still carries none. */
let testChooser: ((win: BrowserWindow | undefined) => Promise<string | null>) | null = null
export function setImageChooserForTest(chooser: typeof testChooser): void {
  assertTestRun('setImageChooserForTest')
  testChooser = chooser
}

/** The file dialog of "Choisir une image…": a single image, in the window it was asked from, for a space or a tab (its title says which). */
export async function chooseImageFile(win: BrowserWindow | undefined, target: 'space' | 'tab' = 'space'): Promise<string | null> {
  if (testChooser) return testChooser(win)
  const options = {
    title: target === 'tab' ? t('space-images-electron.choisir-une-image-pour-l-onglet') : t('space-images-electron.choisir-une-image-pour-l-espace'),
    buttonLabel: t('space-images-electron.choisir'),
    properties: ['openFile' as const],
    filters: [{ name: t('space-images-electron.images-png-jpeg-webp'), extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
  }
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  return result.canceled || result.filePaths.length === 0 ? null : (result.filePaths[0] ?? null)
}
