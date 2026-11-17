// @vitest-environment happy-dom
// The switch "Peut capter le son d’un onglet" in the details of an extension (ExtensionsPage.tsx, `DetailRows`), mounted in a document: there only for an
// extension whose manifest asks for tabCapture, off until the person switches it on, and per profile. The rules are in shared/tab-capture.test.ts.

import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { describeManifest, type ExtensionDetail } from '@shared/extension-page'
import { setLanguage } from '@shared/i18n'
import type { ExtensionInfo } from '@shared/ipc'
import { cleanProfileOverrides } from '@shared/profiles'
import { createInitialState } from '@shared/sidebar'
import { DetailRows } from './ExtensionsPage'
import { click, installBridge, mount, type Mounted } from './dom.test-support'

const EXT = 'a'.repeat(32)
const info = (over: Partial<ExtensionInfo> = {}): ExtensionInfo => ({ id: EXT, name: 'Captions', version: '1.0.0', profileId: 'default', source: 'store', enabled: true, ...over })
const detailOf = (permissions: string[], optional: string[] = []): ExtensionDetail => ({
  profileId: 'default',
  id: EXT,
  path: '/x',
  facts: describeManifest({ manifest_version: 3, description: 'Sous-titres.', permissions, optional_permissions: optional }),
  workerRunning: false
})

let mounted: Mounted | null = null
beforeEach(() => setLanguage('fr'))
afterEach(() => {
  mounted?.unmount()
  mounted = null
  setLanguage('fr')
})

function details(options: { permissions: string[]; optional?: string[]; allowed?: Record<string, string[]>; copy?: ExtensionInfo; featureOn?: boolean }) {
  // The page is a tab with eight calls of its own: the switch is a request of the page (`act`), which the main process reads again.
  const dispatch = vi.fn(async () => ({ ok: true }))
  installBridge({})
  const state = createInitialState({ now: 1, newId: () => 'id' })
  const profiles = cleanProfileOverrides(Object.fromEntries(Object.entries(options.allowed ?? {}).map(([profile, ids]) => [profile, { tabCaptureExtensions: ids }])))
  const settings = { ...state.settings, profiles, extensionTabCapture: options.featureOn ?? true }
  const copy = options.copy ?? info()
  mounted = mount(createElement(DetailRows, { row: { info: copy, detail: detailOf(options.permissions, options.optional), state: 'enabled', errors: 0, warnings: 0 }, copies: [copy], settings, dev: false, busy: false, act: dispatch, onCopy: () => undefined, onGone: () => undefined }))
  const field = mounted.container.querySelector<HTMLInputElement>('input[aria-label^="Autoriser"], input[aria-label^="Allow"]')
  return { dispatch, field, container: mounted.container }
}

describe('the switch of the capture of the sound of a tab, in the details of an extension', () => {
  it('is there for an extension whose manifest asks for tabCapture, off by default, with its explanation', () => {
    const { field, container } = details({ permissions: ['activeTab', 'tabCapture'] })
    expect(field).not.toBeNull()
    expect(field!.checked).toBe(false)
    expect(field!.getAttribute('role')).toBe('switch')
    expect(field!.getAttribute('aria-label')).toBe('Autoriser Captions à capter le son d’un onglet dans le profil Profil par défaut')
    expect(container.textContent).toContain('Peut capter le son d’un onglet')
    expect(container.textContent).toContain('jamais son image')
  })

  it('is not there for an extension that does not ask for it', () => {
    const { field, container } = details({ permissions: ['activeTab', 'tabs'] })
    expect(field).toBeNull()
    expect(container.textContent).not.toContain('capter le son')
  })

  it('is not there for a permission the manifest only lists as facultative: nothing is switched before it is granted', () => {
    expect(details({ permissions: ['activeTab'], optional: ['tabCapture'] }).field).toBeNull()
  })

  it('is on when the person allowed the extension in this profile, and only in this profile', () => {
    expect(details({ permissions: ['tabCapture'], allowed: { default: [EXT] } }).field!.checked).toBe(true)
    mounted?.unmount()
    expect(details({ permissions: ['tabCapture'], allowed: { work: [EXT] } }).field!.checked).toBe(false)
    mounted?.unmount()
    expect(details({ permissions: ['tabCapture'], allowed: { default: ['b'.repeat(32)] } }).field!.checked).toBe(false)
  })

  it('switches the capture on for this extension in this profile with a click, and off again', async () => {
    const on = details({ permissions: ['tabCapture'], copy: info({ profileId: 'work' }) })
    await click(on.field!)
    expect(on.dispatch).toHaveBeenCalledExactlyOnceWith({ op: 'set-tab-capture', profileId: 'work', extensionId: EXT, allowed: true })
    mounted?.unmount()
    const off = details({ permissions: ['tabCapture'], allowed: { default: [EXT] } })
    await click(off.field!)
    expect(off.dispatch).toHaveBeenCalledExactlyOnceWith({ op: 'set-tab-capture', profileId: 'default', extensionId: EXT, allowed: false })
  })

  it('says so under the switch while the whole function is off in the settings, and says nothing while it is on', () => {
    expect(details({ permissions: ['tabCapture'] }).container.textContent).not.toContain('La fonction est coupée')
    mounted?.unmount()
    const off = details({ permissions: ['tabCapture'], featureOn: false })
    expect(off.container.textContent).toContain('La fonction est coupée')
    expect(off.container.textContent).toContain('l’extension ne peut pas capter le son d’un onglet')
    // The switch is still there: what the person chose for the extension is kept.
    expect(off.field).not.toBeNull()
  })

  it('is written in English when the language is English', () => {
    setLanguage('en')
    const { field, container } = details({ permissions: ['tabCapture'] })
    expect(field!.getAttribute('aria-label')).toBe('Allow Captions to capture a tab’s sound in the profile Default Profile')
    expect(container.textContent).toContain('Can capture a tab’s sound')
  })
})
