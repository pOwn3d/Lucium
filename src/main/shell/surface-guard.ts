// Electron side of @shared/surface-guard: locks a web contents that shows our own interface so that it can only ever show our own
// pages. The surfaces share the preload (`window.lucium`), so a remote page that replaced one would inherit the whole API.
// What is refused: a navigation to anything but our pages (a link or a file dropped on the surface, a redirect, a script), a frame
// that navigates, a new window, a <webview>. The pages of the tabs are not surfaces and are never locked (see electron-engine.ts).

import { pathToFileURL } from 'node:url'
import { sep } from 'node:path'
import type { WebContents } from 'electron'
import { schemeOf } from '@shared/external-links'
import { isAppUrl, rendererDevUrl, type AppRoots } from '@shared/surface-guard'

const locked = new WeakSet<WebContents>()

/** Where the interface is loaded from, given the folder of the built pages (`out/renderer`) and whether the application is packaged. */
export function appRoots(rendererDir: string, packaged: boolean, devUrlEnv: string | undefined = process.env['ELECTRON_RENDERER_URL']): AppRoots {
  return { devUrl: rendererDevUrl(devUrlEnv, packaged), fileRoot: pathToFileURL(`${rendererDir}${sep}`).href }
}

/** Locks `contents` (once: a second call does nothing). Do it before the first load. */
export function lockSurface(contents: WebContents, roots: AppRoots): void {
  if (locked.has(contents)) return
  locked.add(contents)
  const refuse = (event: { preventDefault(): void }, url: string, what: string): void => {
    if (isAppUrl(url, roots)) return
    event.preventDefault()
    console.warn(`[surface] refused ${what} to ${schemeOf(url)} from an interface page`)
  }
  contents.setWindowOpenHandler(({ url }) => {
    console.warn(`[surface] refused a new window to ${schemeOf(url)} from an interface page`)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => refuse(event, url, 'a navigation'))
  contents.on('will-frame-navigate', (event) => refuse(event, event.url, 'a frame navigation'))
  contents.on('will-redirect', (event, url) => refuse(event, url, 'a redirect'))
  contents.on('will-attach-webview', (event) => event.preventDefault())
}

/** True once `lockSurface` has run on this web contents. */
export function isSurfaceLocked(contents: WebContents): boolean {
  return locked.has(contents)
}
