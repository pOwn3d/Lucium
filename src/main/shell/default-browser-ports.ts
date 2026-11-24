// The real calls behind the default browser (shell/default-browser.ts): Electron's `app` and `shell`, and `reg.exe` on Windows.

import { execFile } from 'node:child_process'
import { app, shell } from 'electron'
import { platformOf } from '@shared/platform'
import { isBuiltApp } from '../runtime'
import { registryReader, type DefaultBrowserPorts } from './default-browser'

export function systemDefaultBrowserPorts(): DefaultBrowserPorts {
  const queryRegistry = registryReader((file, args, done) => void execFile(file, args, { timeout: 5000, windowsHide: true }, (error, stdout) => done(error, stdout)), process.env.SystemRoot)
  return {
    platform: platformOf(process.platform),
    built: isBuiltApp(),
    isClient: (scheme) => app.isDefaultProtocolClient(scheme),
    setClient: (scheme) => app.setAsDefaultProtocolClient(scheme),
    queryRegistry,
    linuxWebBrowser: () =>
      new Promise((resolve, reject) => {
        execFile('xdg-settings', ['get', 'default-web-browser'], { timeout: 5000, windowsHide: true }, (error, stdout) => {
          if (error) return reject(error)
          resolve(stdout.trim() === '' ? null : stdout)
        })
      }),
    openSettings: (url) => shell.openExternal(url)
  }
}
