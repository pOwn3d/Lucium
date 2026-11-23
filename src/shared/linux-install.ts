// How Lucium is installed on Linux, and what follows for its updates (the maintainer's decision of 23 November 2026: one kind of installer per feed).
//
// Two packages are built (electron-builder.yml, `linux`): an AppImage, which the person runs from a file of their own, and a .deb, which apt puts under /opt.
// They are not updated the same way, so a copy must know which it is:
// - an AppImage can replace itself: the file is the person's, in a folder they own. It is told by `APPIMAGE`, the variable the AppImage runtime sets to the
//   path of the file it was started from;
// - a .deb cannot: installing a package asks for root, and a browser that started `sudo` or `pkexec` on the strength of a file it downloaded would raise
//   privileges on behalf of the network. Lucium tells the person which command to run and never runs it.
// Neither (a run from the sources, an unpacked build) reads no feed: there is nothing to install over.
//
// Pure, and free of Node (the interface imports this folder): the environment and the paths are given, and a path is read as a POSIX one whatever the machine is.

/** The two ways a Lucium of Linux is installed. */
export type LinuxPackaging = 'appimage' | 'deb'

/** What a running copy is, from its environment and its executable. `appimage` carries the file to replace. */
export type LinuxInstall = { packaging: 'appimage'; file: string } | { packaging: 'deb' } | { packaging: null }

/** A path that is absolute and already in its plain form: no `//`, no `.` or `..` part, no trailing slash, and no character a shell or a log line could read as more. */
const plainAbsolute = (path: string): boolean => path.startsWith('/') && path.length > 1 && !path.endsWith('/') && !/\/\/|\/\.\.?(?:\/|$)|[\0\n\r]/.test(path)

/** Where apt puts an application: the .deb of electron-builder installs under /opt, and apt's own files live under /usr. */
const PACKAGE_ROOTS: readonly string[] = ['/opt/', '/usr/']

/**
 * What this copy is. An AppImage is told by `APPIMAGE` alone, and only when it names a plain absolute path of a file (not a folder, not a relative path, nothing
 * a shell could read as more than one word): a copy that cannot say which file it is does not try to replace one. A .deb is a copy with no `APPIMAGE` whose
 * executable is under /opt or /usr. Anything else installs nothing.
 */
export function linuxInstallOf(env: { APPIMAGE?: string | undefined }, execPath: string): LinuxInstall {
  const file = env.APPIMAGE
  if (typeof file === 'string' && file !== '') {
    return plainAbsolute(file) ? { packaging: 'appimage', file } : { packaging: null }
  }
  return plainAbsolute(execPath) && PACKAGE_ROOTS.some((root) => execPath.startsWith(root)) ? { packaging: 'deb' } : { packaging: null }
}

/**
 * The address of the feed of one packaging, made from the address built into the application for its system (`https://lucium.app/updates/linux-x64/feed.json`,
 * written by the CI build, which is one for both packagings): the feed of an AppImage and the feed of a .deb are in two folders of the system's,
 * `…/linux-x64/appimage/feed.json` and `…/linux-x64/deb/feed.json`. Empty when the built-in address does not end with `/feed.json` (nothing is guessed from an
 * address of another shape).
 */
export function linuxFeedAddress(builtIn: string, packaging: LinuxPackaging | null): string {
  if (packaging === null || !/^https:\/\/\S+\/feed\.json$/i.test(builtIn)) return ''
  return `${builtIn.slice(0, -'feed.json'.length)}${packaging}/feed.json`
}

/** How a .deb names an architecture (`dpkg --print-architecture`): amd64 for x64. */
const DEB_ARCHITECTURES: Readonly<Record<string, string>> = { x64: 'amd64', arm64: 'arm64' }

/**
 * The name Lucium gives the .deb it downloads: its own, made from the version of the signed feed and the architecture of this copy, never from the address. Null when
 * the version is not digits and dots (the feed's own rule) or the architecture is not one a .deb is built for.
 */
export function debFileName(version: string, arch: string): string | null {
  const word = Object.hasOwn(DEB_ARCHITECTURES, arch) ? DEB_ARCHITECTURES[arch] : undefined
  return word && /^\d+(?:\.\d+){0,3}$/.test(version) ? `Lucium-${version}-linux-${word}.deb` : null
}

/** The command that installs the .deb the person downloaded: run from the folder that holds it, as apt wants a path (`./`), and by the person, as root. */
export const debInstallCommand = (fileName: string): string => `sudo apt install ./${fileName}`

/** The files an AppImage update leaves beside the AppImage, named from its own name: the download that waits, its unfinished form, and the version it replaced. */
export interface AppImageFiles {
  /** The download as it is written: `<name>.update.part`. */
  part: string
  /** The download once checked, waiting for the second click: `<name>.update`. */
  staged: string
  /** The copy that was running, kept until the new one has started: `<name>.previous`. */
  previous: string
}

export function appImageFiles(file: string): AppImageFiles {
  return { part: `${file}.update.part`, staged: `${file}.update`, previous: `${file}.previous` }
}
