import { describe, expect, it } from 'vitest'
import { setLanguage } from './i18n'
import { STORE_ORIGIN, STORE_URL, UPDATE_INTERVAL_MS, isStoreHost, isStoreOrigin, isStorePage, updateDue, updateSummary, STORE_TRUST_THRESHOLD, STORE_VERSION_REPORTED, compareChromium, versionForStore } from './web-store'
import { frenchSpaces } from './french-typography'

describe('isStoreOrigin', () => {
  it('accepts the store and nothing that only resembles it', () => {
    expect(isStoreOrigin(STORE_ORIGIN)).toBe(true)
    for (const other of [
      `${STORE_ORIGIN}.evil.example`,
      `${STORE_ORIGIN}:8443`,
      `${STORE_ORIGIN}/`,
      'http://chromewebstore.google.com',
      'https://chromewebstore.google.com.attacker.net',
      'https://evilchromewebstore.google.com',
      'https://chrome.google.com',
      'null',
      '',
      undefined,
      null,
      42
    ]) {
      expect(isStoreOrigin(other), String(other)).toBe(false)
    }
  })

  it('reads the page of an address: the store\'s pages, not an address that merely starts like it', () => {
    expect(isStorePage(`${STORE_URL}detail/ublock-origin-lite/ddkjiahejlhfcafbddmgiahcphecmpfh`)).toBe(true)
    expect(isStorePage('https://chromewebstore.google.com.evil.example/detail/x')).toBe(false)
    expect(isStorePage('https://evil.example/?https://chromewebstore.google.com/')).toBe(false)
    expect(isStorePage('not a url')).toBe(false)
    expect(isStorePage(undefined)).toBe(false)
  })
})

describe('isStoreHost', () => {
  it('accepts the domains Google serves the store, its packages and its pictures from', () => {
    for (const host of ['clients2.google.com', 'update.googleapis.com', 'clients2.googleusercontent.com', 'lh3.googleusercontent.com', 'ssl.gstatic.com', 'CLIENTS2.Google.com', 'google.com.']) expect(isStoreHost(host), host).toBe(true)
  })
  it('refuses every other host, the look-alikes and the local network included', () => {
    for (const host of ['evil.example', 'google.com.evil.example', 'notgoogle.com', 'googleusercontent.com.evil.net', 'localhost', '127.0.0.1', '192.168.1.1', '169.254.169.254', '', 'google.co']) expect(isStoreHost(host), host).toBe(false)
  })
})

describe('updateDue', () => {
  const now = 1_000_000_000_000
  it('never asks by itself in manual mode', () => {
    expect(updateDue('manual', undefined, now)).toBe(false)
    expect(updateDue('manual', 0, now)).toBe(false)
    expect(UPDATE_INTERVAL_MS.manual).toBeNull()
  })
  it('asks when the last check is older than the interval, or was never made', () => {
    expect(updateDue('daily', undefined, now)).toBe(true)
    expect(updateDue('daily', now - UPDATE_INTERVAL_MS.daily!, now)).toBe(true)
    expect(updateDue('daily', now - UPDATE_INTERVAL_MS.daily! + 1, now)).toBe(false)
    expect(updateDue('weekly', now - 6 * 24 * 3_600_000, now)).toBe(false)
    expect(updateDue('weekly', now - 7 * 24 * 3_600_000, now)).toBe(true)
  })
  it('counts a check dated in the future (the clock went back) as due', () => {
    expect(updateDue('daily', now + 3_600_000, now)).toBe(true)
  })
})

describe('updateSummary', () => {
  const none = { checked: 0, updated: [], waiting: [], failed: null }
  it('says why a check failed, first', () => {
    expect(updateSummary({ ...none, checked: 2, updated: ['A'], failed: 'réseau coupé' })).toBe(frenchSpaces('Mise à jour des extensions impossible : réseau coupé'))
  })
  it('says there is nothing to update when no extension comes from the store', () => {
    expect(updateSummary(none)).toBe('Aucune extension du Chrome Web Store à mettre à jour.')
  })
  it('counts what was updated and what waits for the user, with the right plural', () => {
    expect(updateSummary({ checked: 3, updated: ['Vimium'], waiting: [], failed: null })).toBe('1 extension mise à jour (Vimium).')
    expect(updateSummary({ checked: 5, updated: ['A', 'B', 'C', 'D'], waiting: ['E', 'F'], failed: null })).toBe(frenchSpaces('4 extensions mises à jour (A, B, C…) ; 2 mises à jour attendent votre accord (nouvelles autorisations) : E, F.'))
    expect(updateSummary({ checked: 1, updated: [], waiting: ['Dark Reader'], failed: null })).toBe(frenchSpaces('1 mise à jour attend votre accord (nouvelles autorisations) : Dark Reader.'))
  })
  it('says everything is up to date when nothing changed', () => {
    expect(updateSummary({ checked: 1, updated: [], waiting: [], failed: null })).toBe(frenchSpaces('1 extension vérifiée : tout est à jour.'))
    expect(updateSummary({ checked: 4, updated: [], waiting: [], failed: null })).toBe(frenchSpaces('4 extensions vérifiées : tout est à jour.'))
  })
  it('says it in the language of the interface, each count with its own form', () => {
    setLanguage('en')
    try {
      expect(updateSummary({ checked: 5, updated: ['A', 'B', 'C', 'D'], waiting: ['E'], failed: null })).toBe('4 extensions updated (A, B, C…); 1 update awaits your approval (new permissions): E.')
      expect(updateSummary({ checked: 1, updated: ['Vimium'], waiting: [], failed: null })).toBe('1 extension updated (Vimium).')
      expect(updateSummary({ checked: 1, updated: [], waiting: [], failed: null })).toBe('1 extension checked: everything is up to date.')
    } finally {
      setLanguage('fr')
    }
  })
})

describe('versionForStore', () => {
  it('compares Chromium versions number by number from the left', () => {
    expect(compareChromium('156.0.8078.48', '142.0.7430.0')).toBe(1)
    expect(compareChromium('142.0.7430.0', '142.0.7430.0')).toBe(0)
    expect(compareChromium('141.0.9999.99', '142.0.7430.0')).toBe(-1)
    expect(compareChromium('142', '142.0.0.0')).toBe(0)
    expect(compareChromium('1000.0.0.0', '999.9.9.9')).toBe(1)
  })

  it('tells the store a version below its threshold when the real one reaches it, and the real one otherwise', () => {
    expect(compareChromium(STORE_VERSION_REPORTED, STORE_TRUST_THRESHOLD)).toBe(-1)
    expect(versionForStore('156.0.8078.48')).toBe(STORE_VERSION_REPORTED)
    expect(versionForStore('142.0.7430.0')).toBe(STORE_VERSION_REPORTED)
    expect(versionForStore('141.0.7389.0')).toBe('141.0.7389.0')
    expect(versionForStore('120.0.6099.109')).toBe('120.0.6099.109')
    expect(versionForStore('156.0.8078.48', '140.1.2.3')).toBe('140.1.2.3')
  })
})
