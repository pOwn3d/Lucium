// The probe of the engine check of the capture of the sound of a tab (compat/tab-capture-probe, smoke-tabcapture.ts) is a folder the check loads in a real
// Electron, which is not run here: what can be said without Electron is that the folder is one an extension can be loaded from, that it asks for the permissions
// the check needs (and no more), and that every file it names is there.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkManifestText, filesNamedBy } from '@shared/extension-page'
import { declaresTabCapture } from '@shared/tab-capture'

const FOLDER = join(fileURLToPath(new URL('../../compat/tab-capture-probe', import.meta.url)))
const read = (file: string): string => readFileSync(join(FOLDER, file), 'utf8')

describe('the probe of the capture of the sound of a tab', () => {
  const checked = checkManifestText(read('manifest.json'))
  const manifest = checked.ok ? checked.manifest : {}

  it('is a folder the Extensions page takes: a Manifest V3 with a name, a version and files that exist', () => {
    expect(checked.ok).toBe(true)
    expect(manifest['manifest_version']).toBe(3)
    for (const file of [...filesNamedBy(manifest), 'offscreen.html', 'offscreen.js']) expect(existsSync(join(FOLDER, file)), file).toBe(true)
  })

  it('declares what a captions extension declares for this, and nothing more', () => {
    expect(declaresTabCapture(manifest)).toBe(true)
    expect([...(manifest['permissions'] as string[])].sort()).toEqual(['activeTab', 'offscreen', 'tabCapture'])
    expect(manifest['host_permissions']).toBeUndefined()
    // The page the check drives it with is a page of the machine: nothing else may send it messages.
    expect(manifest['externally_connectable']).toEqual({ matches: ['http://127.0.0.1/*'] })
  })

  it('has the command the check fires to hand the tab over, as a click on the icon would', () => {
    expect(Object.keys(manifest['commands'] as Record<string, unknown>)).toEqual(['probe-capture'])
    expect(read('background.js')).toContain('chrome.commands.onCommand.addListener')
  })

  it('also asks for a microphone, a camera and a screen, to say how an offscreen document is refused them (Electron 45 stops on such a request)', () => {
    const asks = read('offscreen.js').split("message.type === 'native'")[1]!.split("message.type === 'peak'")[0]!
    for (const call of ["getUserMedia({ audio: true })", "getUserMedia({ video: true })", "chromeMediaSource: 'desktop'", 'getDisplayMedia({ video: true })']) expect(asks, call).toContain(call)
    expect(read('background.js')).toContain("{ type: 'native' }")
  })

  it('asks the way an extension does: the identifier in its worker, the stream in an offscreen document, the picture never asked for', () => {
    expect(read('background.js')).toContain('chrome.tabCapture.getMediaStreamId')
    expect(read('offscreen.js')).toContain("chromeMediaSource: 'tab'")
    // `video` is only the count of the tracks it reports: the call that listens names the sound alone.
    const listens = read('offscreen.js').split("message.type === 'native'")[0]!
    expect(listens).not.toMatch(/getUserMedia\(\{[^)]*video/)
    expect(read('offscreen.html')).toContain('offscreen.js')
  })
})
