// The modes of the files of a Linux package.
//
// The Electron archive a Linux build starts from carries modes of 0666 and 0777, and electron-builder copies them as they are: the first Linux build
// (the workflow Linux, .github/workflows/linux.yml) made a .deb in which 68 files were writable by every user, the executable `/opt/Lucium/lucium` among
// them. Whoever can write that file can replace the browser a user (or root) starts next. The package is made with the modes a package has: 0755 for a folder
// and for a file that is executable, 0644 for the others, nothing writable by group or others, no special bit (the setuid bit of `chrome-sandbox` is
// the job of the post-install script of the .deb, which only sets it where user namespaces cannot be used).
//
// CommonJS: electron-builder loads scripts/after-pack.cjs with require(), and this file is required from it.
const { chmodSync, lstatSync, readdirSync } = require('node:fs')
const { join } = require('node:path')

const FOLDER_MODE = 0o755
const EXECUTABLE_MODE = 0o755
const FILE_MODE = 0o644

/** The mode a package gives an entry of this mode: folders 0755, executables 0755, anything else 0644. */
function packageMode(isFolder, mode) {
  if (isFolder) return FOLDER_MODE
  return (mode & 0o111) !== 0 ? EXECUTABLE_MODE : FILE_MODE
}

/**
 * Sets the modes of everything under `root` (and of `root`) to those of `packageMode`. A symbolic link is left alone (its target is another entry of the
 * tree, or none of ours). Returns how many entries were changed.
 */
function normalizeLinuxModes(root) {
  let changed = 0
  const set = (path, isFolder) => {
    const wanted = packageMode(isFolder, lstatSync(path).mode)
    if ((lstatSync(path).mode & 0o7777) === wanted) return
    chmodSync(path, wanted)
    changed += 1
  }
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue
      const path = join(folder, entry.name)
      set(path, entry.isDirectory())
      if (entry.isDirectory()) walk(path)
    }
  }
  set(root, true)
  walk(root)
  return changed
}

module.exports = { normalizeLinuxModes, packageMode }
