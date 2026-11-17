import { join } from 'node:path'
import { app, nativeImage, type NativeImage } from 'electron'
import { DEFAULT_APP_ICON, isAppIconId, type AppIconIssue } from '@shared/icons'
import { isBuiltApp } from '../runtime'
import { BundleIcon, bundleIconDeps, bundleOfExecutable } from './bundle-icon'

/** Where the icon files are: next to the other resources of a packaged application, in the repository while developing. */
export function appIconsFolder(): string {
  return join(isBuiltApp() ? process.resourcesPath : app.getAppPath(), isBuiltApp() ? 'app-icons' : 'resources/app-icons')
}

/** An application icon as a bitmap (512 px as shipped); an unknown id gives the default one. */
export function loadIcon(id: string, size = 512): NativeImage {
  const image = nativeImage.createFromPath(join(appIconsFolder(), `${isAppIconId(id) ? id : DEFAULT_APP_ICON}.png`))
  return size === 512 || image.isEmpty() ? image : image.resize({ width: size, height: size, quality: 'best' })
}

/**
 * The only bundle whose icon Lucium changes: the `.app` folder the running executable is in, on macOS, in the built application. Never Electron's
 * while developing, never in a test run from the sources; no path given by the interface or read from the state names it.
 */
export function runningBundle(): string | null {
  return process.platform === 'darwin' && isBuiltApp() ? bundleOfExecutable(process.execPath) : null
}

/** The record of the icon put on the bundle, in the data folder (bundle-icon.ts). */
const BUNDLE_ICON_RECORD = 'bundle-icon.json'

let keeper: BundleIcon | null = null
const bundleIcon = (): BundleIcon =>
  (keeper ??= new BundleIcon(
    bundleIconDeps({
      bundle: runningBundle,
      picture: (id) => join(appIconsFolder(), `${id}.png`),
      record: () => join(app.getPath('userData'), BUNDLE_ICON_RECORD),
      log: (line) => console.warn(line)
    })
  ))

/** Why the Dock could not take the chosen icon, as of the last call (null: it shows it, or there is no Dock). */
let dockIssue: AppIconIssue | null = null

/**
 * Shows the chosen icon (macOS only), at each launch and at each choice (main/index.ts): in the Dock at once (`app.dock.setIcon`, in memory), and on
 * the bundle of the application so that the Dock, the Finder and the Launchpad keep it once Lucium is closed (bundle-icon.ts; the default icon takes
 * the custom one off). Answers why it could not, once the bundle is done: its picture is missing (a damaged copy: nothing is changed), or the bundle
 * cannot be written (the Dock shows it while Lucium runs all the same).
 */
export function applyAppIcon(id: string): Promise<AppIconIssue | null> {
  if (!app.dock) return Promise.resolve((dockIssue = null))
  const image = loadIcon(id)
  // The picture is missing from the application (a damaged copy): the Dock keeps what it shows, and the bundle too; Settings › Icône says so.
  if (image.isEmpty()) {
    console.warn(`[icon] the picture of the icon "${id}" is missing from the application; the Dock keeps its icon`)
    return Promise.resolve((dockIssue = { reason: 'missing-picture' }))
  }
  app.dock.setIcon(image)
  dockIssue = null
  return bundleIcon().keep(id)
}

/** Why the chosen icon is not shown as it should be, once the calls under way are done (null: it is, or there is no Dock). Settings › Icône reads it. */
export async function appIconIssue(): Promise<AppIconIssue | null> {
  const onBundle = await bundleIcon().settled()
  return dockIssue ?? onBundle
}

/**
 * Before an update is installed (app-update.ts): the custom icon comes off the bundle, which Squirrel replaces; the new version puts it back at its
 * first launch. Never rejects.
 */
export function takeAppIconOffForUpdate(): Promise<void> {
  return bundleIcon().releaseForUpdate()
}

/**
 * Settings › Icon, as the main process follows it: the chosen icon is shown at launch, then again each time the choice changes (and only then).
 * A failure is written to the log; the application goes on with the icon the Dock shows. Answers the function that stops following.
 */
export function followAppIcon(store: { get(): { settings: { appIcon: string } }; subscribe(listener: () => void): () => void }, apply: (id: string) => unknown = applyAppIcon): () => void {
  let shownIcon = ''
  const failed = (error: unknown): void => console.error('[icon] cannot show the application icon:', error)
  const refreshIcon = (): void => {
    const wanted = store.get().settings.appIcon
    if (wanted === shownIcon) return
    shownIcon = wanted
    try {
      const shown = apply(wanted)
      if (shown instanceof Promise) void shown.catch(failed)
    } catch (error) {
      failed(error)
    }
  }
  refreshIcon()
  return store.subscribe(refreshIcon)
}
