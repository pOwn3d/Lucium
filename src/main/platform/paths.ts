// Where the other browsers keep their data, per system. macOS is what the importers always did (`~/Library/Application Support/<support>`,
// with `support` from shared/import-sources.ts). The Windows and Linux folders are the ones those browsers document for themselves; they were
// NOT looked at on a real machine (docs/plateformes.md): a wrong folder only means a browser that is not offered.
//
// Paths are built with `path.win32` or `path.posix` of the system asked for, not of the machine running the code, so a test can play any of them.

import { posix, win32 } from 'node:path'
import { PLATFORM_FACTS, type PlatformId } from '@shared/platform'

/** What the folders are made from. Windows names them in environment variables (`LOCALAPPDATA`, `APPDATA`), Linux may move `~/.config` (`XDG_CONFIG_HOME`). */
export interface PathEnv {
  home: string
  localAppData?: string
  appData?: string
  xdgConfigHome?: string
}

/** What is needed of an import source to find its folder: its identifier, and the macOS folder name under Application Support. */
export interface SourceFolder {
  id: string
  support?: string
}

/** The folder name under the base of the system, per source: the chromium family and Firefox. Arc and Safari are macOS only. */
const CHROMIUM_FAMILY: Readonly<Record<string, { win32: string; linux: string }>> = {
  chrome: { win32: 'Google\\Chrome\\User Data', linux: 'google-chrome' },
  brave: { win32: 'BraveSoftware\\Brave-Browser\\User Data', linux: 'BraveSoftware/Brave-Browser' },
  edge: { win32: 'Microsoft\\Edge\\User Data', linux: 'microsoft-edge' },
  vivaldi: { win32: 'Vivaldi\\User Data', linux: 'vivaldi' },
  chromium: { win32: 'Chromium\\User Data', linux: 'chromium' }
}

const FIREFOX = { win32: 'Mozilla\\Firefox\\Profiles', linux: '.mozilla/firefox' }

/** Whether this system offers to import from this source at all. */
export function importAvailable(sourceId: string, platform: PlatformId = 'darwin'): boolean {
  const facts = PLATFORM_FACTS[platform]
  if (sourceId === 'safari') return facts.importSafari
  if (sourceId === 'arc') return facts.importArc
  return true
}

/**
 * The folder that holds the profiles of a browser (`Local State`, `Default/`, `Profile 1/`; for Firefox the `<random>.<name>` profile folders), or
 * null when this system does not have that browser's data in a place the application knows. Safari's folder is `~/Library/Safari` and does not come here.
 */
export function browserDataDir(source: SourceFolder, platform: PlatformId, env: PathEnv): string | null {
  if (!importAvailable(source.id, platform)) return null
  if (platform === 'darwin') return posix.join(env.home, 'Library/Application Support', source.support ?? '')
  if (platform === 'win32') {
    if (source.id === 'firefox') return win32.join(env.appData ?? win32.join(env.home, 'AppData', 'Roaming'), FIREFOX.win32)
    const name = CHROMIUM_FAMILY[source.id]?.win32
    return name ? win32.join(env.localAppData ?? win32.join(env.home, 'AppData', 'Local'), name) : null
  }
  if (source.id === 'firefox') return posix.join(env.home, FIREFOX.linux)
  const name = CHROMIUM_FAMILY[source.id]?.linux
  return name ? posix.join(env.xdgConfigHome || posix.join(env.home, '.config'), name) : null
}
