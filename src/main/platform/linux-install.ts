// What this running copy is installed as on Linux (shared/linux-install.ts has the rules). The one place the real environment and the real executable are read;
// everything that decides from it takes the answer as an argument, so that a test plays an AppImage or a .deb on any machine.

import { linuxInstallOf, type LinuxInstall } from '@shared/linux-install'

/** What this copy is, from `APPIMAGE` and the executable: nothing off Linux. Read each time (two property reads): a test sets the environment it plays. */
export function currentLinuxInstall(): LinuxInstall {
  return process.platform === 'linux' ? linuxInstallOf(process.env, process.execPath) : { packaging: null }
}
