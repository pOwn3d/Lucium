// Test support (nothing of the application imports it): a pretend folder of applications, each with the `Contents/Info.plist` macOS
// keeps in a bundle. The import sheet reads the name of each browser there (app-names.ts); the tests give it the names they expect.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface FakeBundle {
  /** `CFBundleIdentifier`. */
  id: string
  /** `CFBundleDisplayName`, when the bundle has one. */
  display?: string
  /** `CFBundleName`. */
  name?: string
  /** The folder name, `<file>.app`: the display name when not given. */
  file?: string
}

const escape = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The XML property list of a bundle, as `plutil -convert xml1` writes one. */
export function infoPlist(bundle: FakeBundle): string {
  const entry = (key: string, value: string | undefined) => (value === undefined ? '' : `\t<key>${key}</key>\n\t<string>${escape(value)}</string>\n`)
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    `<plist version="1.0">\n<dict>\n${entry('CFBundleDisplayName', bundle.display)}${entry('CFBundleIdentifier', bundle.id)}${entry('CFBundleName', bundle.name)}</dict>\n</plist>\n`
  )
}

/** Writes the bundles into `folder` and answers the folder, for `ImportDeps.applications`. */
export function fakeApplications(folder: string, bundles: readonly FakeBundle[]): string {
  for (const bundle of bundles) {
    const contents = join(folder, `${bundle.file ?? bundle.display ?? bundle.name ?? bundle.id}.app`, 'Contents')
    mkdirSync(contents, { recursive: true })
    writeFileSync(join(contents, 'Info.plist'), infoPlist(bundle))
  }
  return folder
}

/** The applications the import tests pretend are installed, with the names their bundles give (the sentences of the tests quote them). */
export const TEST_BROWSERS: readonly FakeBundle[] = [
  { id: 'com.google.Chrome', display: 'Google Chrome', name: 'Chrome' },
  { id: 'com.apple.Safari', display: 'Safari', name: 'Safari' },
  { id: 'org.mozilla.firefox', name: 'Firefox' },
  { id: 'company.thebrowser.Browser', name: 'Arc' },
  { id: 'app.zen-browser.zen', name: 'Zen' }
]
