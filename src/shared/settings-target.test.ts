// `chrome://extensions` typed in the bar leads to the Extensions page, not to a web search for that text.

import { describe, expect, it } from 'vitest'
import { extensionsPageOf, settingsHash, showHashScript, settingsResumePlace } from './settings-target'

const ID = 'abcdefghijklmnopabcdefghijklmnop'

describe('extensionsPageOf', () => {
  it('leads chrome://extensions, with or without a path, a query or a fragment, to the list', () => {
    for (const text of ['chrome://extensions', 'chrome://extensions/', 'chrome://extensions#top', '  CHROME://Extensions  ', 'arc://extensions', 'chrome://extensions/?foo=1', 'chrome://extensions/?id=nope']) {
      expect(extensionsPageOf(text), text).toEqual({ view: 'list' })
    }
  })

  it('leads ?id=<id> to the page of that extension, and /shortcuts to the shortcuts', () => {
    expect(extensionsPageOf(`chrome://extensions/?id=${ID}`)).toEqual({ view: 'detail', extensionId: ID })
    expect(extensionsPageOf(`arc://extensions?id=${ID}#x`)).toEqual({ view: 'detail', extensionId: ID })
    expect(extensionsPageOf('chrome://extensions/shortcuts')).toEqual({ view: 'shortcuts' })
    expect(extensionsPageOf('chrome://extensions/shortcuts/')).toEqual({ view: 'shortcuts' })
  })

  it('reads the copy of the extension the address names (the address of the page itself says it, and copying it must give it back)', () => {
    expect(extensionsPageOf(`chrome://extensions/?id=${ID}&profile=work`)).toEqual({ view: 'detail', extensionId: ID, profileId: 'work' })
    // A profile that is not an id is left out: the page then shows the extension in the profile it is listed in.
    expect(extensionsPageOf(`chrome://extensions/?id=${ID}&profile=../x`)).toEqual({ view: 'detail', extensionId: ID })
    expect(extensionsPageOf('chrome://extensions/?profile=work')).toEqual({ view: 'list' })
  })

  it('leaves any other text to the address and search rules', () => {
    for (const text of ['chrome://extensionsfoo', 'chrome://settings', 'chrome://newtab', 'https://chrome.example/extensions', 'extensions', 'chrome extensions', 'chrome://extensions and more', 'javascript:chrome://extensions', 'chrome://extensions/\nx', '']) {
      expect(extensionsPageOf(text), text).toBeNull()
    }
  })
})


describe('settingsHash', () => {
  it('names the category, and the group inside it when it belongs to that category', () => {
    expect(settingsHash('protection', 'permissions')).toBe('protection/permissions')
    expect(settingsHash('files', 'downloads')).toBe('files/downloads')
    expect(settingsHash('tools', 'extensions')).toBe('tools/extensions')
    expect(settingsHash('tools')).toBe('tools')
    expect(settingsHash('home')).toBe('home')
    expect(settingsHash('keyboard', 'shortcuts')).toBe('keyboard/shortcuts')
    expect(settingsHash('about', 'icon')).toBe('about/icon')
  })

  it('opens the category at its top for a place it does not know or that is in another category: nothing else ends up in the address of the window', () => {
    expect(settingsHash('protection', 'permissions"); alert(1); ("')).toBe('protection')
    expect(settingsHash('protection', '')).toBe('protection')
    expect(settingsHash('lock', 'permissions')).toBe('protection/lock')
    expect(settingsHash('general', 'permissions')).toBe('home')
    expect(settingsHash('files', 'permissions')).toBe('files')
  })

  it('leads an old address to the category that took its place, at the group that holds its rows', () => {
    expect(settingsHash('advanced', 'extensions')).toBe('tools/extensions')
    expect(settingsHash('advanced', 'privacy')).toBe('protection')
    expect(settingsHash('advanced', 'permissions')).toBe('protection/permissions')
    expect(settingsHash('advanced', 'downloads')).toBe('files/downloads')
    expect(settingsHash('advanced', 'about')).toBe('about/about')
    // The category « Général » of the previous layout, and its groups.
    expect(settingsHash('general')).toBe('home')
    expect(settingsHash('general', 'guide')).toBe('home/guide')
    expect(settingsHash('general', 'about')).toBe('about/about')
    // The old categories (the 14, then the 8 that followed them), as a saved hash, a menu or a smoke script may still name them.
    expect(settingsHash('security')).toBe('protection/lock')
    expect(settingsHash('shortcuts')).toBe('keyboard/shortcuts')
    expect(settingsHash('links')).toBe('navigation/links')
    expect(settingsHash('search')).toBe('navigation/engine')
    expect(settingsHash('privacy')).toBe('protection')
    expect(settingsHash('privacy', 'lock')).toBe('protection/lock')
    expect(settingsHash('navigation')).toBe('navigation')
    expect(settingsHash('navigation', 'engine')).toBe('navigation/engine')
    expect(settingsHash('navigation', 'shortcuts')).toBe('keyboard/shortcuts')
    expect(settingsHash('spaces')).toBe('appearance')
    expect(settingsHash('extensions')).toBe('tools/extensions')
    expect(settingsHash('icon')).toBe('about/icon')
    expect(settingsHash('about')).toBe('about')
  })

  it('opens « Pour commencer » for what is no place at all', () => {
    expect(settingsHash('nowhere')).toBe('home')
    expect(settingsHash('')).toBe('home')
  })
})

describe('the group « Effacement des données du site »', () => {
  it('is reached by its anchor in Vie privée et sécurité, and by that category only', () => {
    expect(settingsHash('protection', 'sitedata')).toBe('protection/sitedata')
    // The anchor of another category is left out: the category opens at its top.
    expect(settingsHash('appearance', 'sitedata')).toBe('appearance')
  })
})

describe('showHashScript', () => {
  /** Runs the script against a window at `current`: what it set and the events it sent. */
  function run(current: string, hash: string): { hash: string; events: string[] } {
    const location = { hash: current }
    const events: string[] = []
    const window = { dispatchEvent: (event: { type: string }) => void events.push(event.type) }
    class HashChangeEvent {
      constructor(readonly type: string) {}
    }
    new Function('location', 'window', 'HashChangeEvent', `return ${showHashScript(hash)}`)(location, window, HashChangeEvent)
    return { hash: location.hash, events }
  }

  it('sets the hash of a window that is somewhere else, and lets the window hear it change', () => {
    expect(run('#general', 'protection/sitedata')).toEqual({ hash: 'protection/sitedata', events: [] })
    expect(run('', 'protection/sitedata')).toEqual({ hash: 'protection/sitedata', events: [] })
  })

  it('sends the event itself to a window that is already at that hash: setting it again changes nothing and fires nothing', () => {
    expect(run('#protection/sitedata', 'protection/sitedata')).toEqual({ hash: '#protection/sitedata', events: ['hashchange'] })
  })

  it('carries the hash as a string, whatever it holds', () => {
    expect(showHashScript('protection"); alert(1); ("')).toContain(JSON.stringify('protection"); alert(1); ("'))
  })
})

describe('the place the Settings window opens again on (settingsResumePlace)', () => {
  const at = (hash: string) => settingsResumePlace(`file:///Applications/Lucium.app/Contents/Resources/app/settings.html${hash}`)

  it('is the page it showed', () => {
    expect(at('#protection')).toEqual({ pane: 'protection' })
    expect(at('#home')).toEqual({ pane: 'home' })
    expect(at('#about')).toEqual({ pane: 'about' })
  })

  it('is the subpage it showed, on its page', () => {
    expect(at('#protection/filterlists')).toEqual({ pane: 'protection', anchor: 'filterlists' })
    expect(at('#keyboard/shortcuts')).toEqual({ pane: 'keyboard', anchor: 'shortcuts' })
    // An old address of a subpage is read as the window read it: the page that holds it now.
    expect(at('#navigation/shortcuts')).toEqual({ pane: 'keyboard', anchor: 'shortcuts' })
  })

  it('keeps the page and not the group a link took it to, nor the guide', () => {
    expect(at('#appearance/panelsize')).toEqual({ pane: 'appearance' })
    expect(at('#about/status')).toEqual({ pane: 'about' })
    expect(at('#general/guide')).toEqual({ pane: 'home' })
  })

  it('is none for an address that names no page: the window opens on « Pour commencer »', () => {
    expect(at('')).toBeNull()
    expect(at('#nowhere')).toBeNull()
    expect(settingsResumePlace('')).toBeNull()
  })
})

