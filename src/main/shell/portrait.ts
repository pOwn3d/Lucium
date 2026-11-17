import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserWindow, nativeImage } from 'electron'
import { PORTRAIT_CANVAS, portraitHtml, portraitLayout } from '@shared/portrait'

const PAINT_TIMEOUT_MS = 8000

/**
 * Sets a capture on the portrait canvas (see shared/portrait.ts) and answers the PNG of the result, or null for an empty capture.
 * The canvas is a page painted off screen: the picture goes through a file because a page this large would not fit in a data: URL.
 */
export async function renderPortrait(png: Buffer, color: string | null): Promise<Buffer | null> {
  const layout = portraitLayout(nativeImage.createFromBuffer(png).getSize())
  if (!layout) return null
  const dir = mkdtempSync(join(tmpdir(), 'lucium-portrait-'))
  const window = new BrowserWindow({
    show: false,
    width: PORTRAIT_CANVAS.width,
    height: PORTRAIT_CANVAS.height,
    useContentSize: true,
    frame: false,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false }
  })
  try {
    writeFileSync(join(dir, 'capture.png'), png)
    writeFileSync(join(dir, 'index.html'), portraitHtml('capture.png', layout, color))
    await window.loadFile(join(dir, 'index.html'))
    await window.webContents.executeJavaScript('Promise.all([...document.images].map((image) => image.decode())).then(() => true)')
    return await new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the portrait never painted')), PAINT_TIMEOUT_MS)
      window.webContents.on('paint', (_event, _dirty, image) => {
        const size = image.getSize()
        // The first frames can be empty or smaller than the canvas, before the page has been laid out.
        if (image.isEmpty() || size.width < PORTRAIT_CANVAS.width || size.height < PORTRAIT_CANVAS.height) return
        clearTimeout(timer)
        resolve(image.toPNG())
      })
      window.webContents.invalidate()
    })
  } finally {
    window.destroy()
    rmSync(dir, { recursive: true, force: true })
  }
}
