// What a window tells the password manager of the tab on screen: whether its page came over a certificate that was let through (the tab says
// « Non sécurisé »), so that nothing of the vault goes there. The real `passwordWindow` of the shell runs on a stand-in for the window.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { activeTab, createInitialState, reduce } from '@shared/sidebar'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'
import type { PasswordWindow } from './password-service'

vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

function windowOn(untrusted: boolean | undefined) {
  let n = 0
  const ctx = { now: 1, newId: () => `id${++n}` }
  const state = reduce(createInitialState(ctx), { type: 'tab/open', url: 'https://banque.example/connexion' }, ctx)
  const tab = activeTab(state)!
  const fake = fakeBrowser({
    store: { get: () => state },
    passwordView: undefined,
    activePage: () => ({ fillLogin: async () => undefined }),
    isTabLocked: () => false,
    runtime: { tabs: { [tab.id]: { loading: false, audible: false, muted: false, awake: true, ...(untrusted ? { untrustedCertificate: true } : {}) } } }
  })
  return (shell['passwordWindow']!.call(fake.self) as PasswordWindow).target()
}

describe('the tab on screen, for the password manager', () => {
  it('is told as not to be trusted when its page came over a certificate that was let through', () => {
    expect(windowOn(true)).toMatchObject({ url: 'https://banque.example/connexion', untrustedCertificate: true })
  })

  it('is a page like any other over a valid certificate', () => {
    expect(windowOn(false)).toMatchObject({ url: 'https://banque.example/connexion', untrustedCertificate: false })
  })

  // The listener of a submitted form is made with the page, which only Electron does: its contract is read in the source.
  it('says the same of the page a form was submitted in', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'browser-pages.ts'), 'utf8')
    expect(source).toContain('submitted(this.passwordWindow(), { privateTab: tab.private === true, frameUrl, untrustedCertificate: this.runtime.tabs[tab.id]?.untrustedCertificate === true }, submission)')
  })
})
