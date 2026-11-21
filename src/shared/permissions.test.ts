import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { reduce, createInitialState } from './sidebar'
import { SITE_PERMISSIONS_MAX } from './state-clean'
import { ALL_SITES, allowLabel, GRANTED_PERMISSIONS, MEDIA_PERMISSION, REFUSED_PERMISSIONS, appLinkPermission, appLinkSchemeOf, externalSchemeOf, fileSystemDetail, hasQuestionPanel, decisionOfChoice, mayRemember, permissionName, permissionPhrase, permissionSheet, questionPlace, rememberedDecision, routePermission, sitePermissionRows, sitesWithAnswers } from './permissions'
import { frenchSpaces } from './french-typography'
import { setLanguage } from './i18n'

describe('routePermission', () => {
  // Seen with Slack: its call window (about:blank, written by app.slack.com) was refused the microphone although the site was allowed it.
  it('judges an about:blank or about:srcdoc document under the web origin it inherits', () => {
    expect(routePermission('media', 'about:blank', undefined, 'https://app.slack.com')).toEqual({ kind: 'policy', origin: 'https://app.slack.com' })
    expect(routePermission('notifications', 'about:srcdoc', undefined, 'https://app.slack.com/client/T1')).toEqual({ kind: 'policy', origin: 'https://app.slack.com' })
  })

  it('still refuses an about:blank document with no inherited origin, or an inherited origin that is not a web one', () => {
    expect(routePermission('media', 'about:blank')).toEqual({ kind: 'deny' })
    expect(routePermission('media', 'about:blank', undefined, 'null')).toEqual({ kind: 'deny' })
    expect(routePermission('media', 'about:blank', undefined, 'file:///Users/x/page.html')).toEqual({ kind: 'deny' })
    // Only blank and srcdoc inherit: another about: page, or a data: page, has no site behind it.
    expect(routePermission('media', 'about:settings', undefined, 'https://app.slack.com')).toEqual({ kind: 'deny' })
    expect(routePermission('media', 'data:text/html,hi', undefined, 'https://app.slack.com')).toEqual({ kind: 'deny' })
  })

  it('sends a web page to the policy under its real origin', () => {
    expect(routePermission('geolocation', 'https://maps.example.com/a?b=1')).toEqual({ kind: 'policy', origin: 'https://maps.example.com' })
    expect(routePermission('notifications', 'http://localhost:3000/x')).toEqual({ kind: 'policy', origin: 'http://localhost:3000' })
  })

  describe('for a page of an installed extension, whose origin the URL API calls "null"', () => {
    const id = 'abcdefghijklmnopabcdefghijklmnop'
    const page = `chrome-extension://${id}/popup.html`
    const manifests: Record<string, readonly unknown[]> = { [id]: ['storage', 'notifications', 'geolocation', 'clipboardRead'] }
    const declaring = (extensionId: string) => manifests[extensionId]
    const declaringNothing = () => ['storage', 'tabs']

    it('names the extension by its own address, the URL API giving "null"', () => {
      expect(new URL(page).origin).toBe('null')
      expect(routePermission('media', page)).toEqual({ kind: 'policy', origin: `chrome-extension://${id}` })
    })

    it('grants what its manifest declares', () => {
      for (const permission of ['notifications', 'geolocation', 'clipboard-read']) expect(routePermission(permission, page, declaring), permission).toEqual({ kind: 'grant' })
    })

    it('asks, like a web page, for what its manifest does not declare', () => {
      for (const permission of ['notifications', 'geolocation', 'clipboard-read']) {
        expect(routePermission(permission, page, declaringNothing), permission).toEqual({ kind: 'policy', origin: `chrome-extension://${id}` })
        expect(routePermission(permission, page), `${permission}, no manifest known`).toEqual({ kind: 'policy', origin: `chrome-extension://${id}` })
      }
    })

    it('always asks for the camera, the microphone and another application: no manifest entry covers them', () => {
      const everything = () => ['media', 'openExternal', 'audioCapture', 'videoCapture', 'midi', 'idle-detection', 'window-management']
      for (const permission of ['media', 'openExternal', 'midi', 'midiSysex', 'idle-detection', 'window-management']) {
        expect(routePermission(permission, page, everything), permission).toEqual({ kind: 'policy', origin: `chrome-extension://${id}` })
      }
    })

    it('is never remembered: the question comes back each time', () => {
      expect(mayRemember(`chrome-extension://${id}`, 'media')).toBe(false)
    })

    it('still grants what exposes nothing, as before', () => {
      for (const permission of ['storage-access', 'persistent-storage', 'background-sync', 'fileSystem']) expect(routePermission(permission, page, declaringNothing), permission).toEqual({ kind: 'grant' })
    })

    // An accord for want of a rule is how a permission of a later engine would be given to every installed extension without anybody deciding it.
    it('refuses what no page is offered here, what acts on a shared screen, and a name the list does not know', () => {
      for (const permission of [...REFUSED_PERMISSIONS, 'a-permission-of-a-later-engine']) expect(routePermission(permission, page, declaring), permission).toEqual({ kind: 'deny', notOffered: true })
      expect(routePermission('captured-surface-control', page, declaring)).toEqual({ kind: 'deny' })
    })

    it('treats the approximate position and the older reading of the clipboard as the permission they go with', () => {
      expect(routePermission('geolocation-approximate', page, (asked) => (asked === id ? ['geolocation'] : undefined))).toEqual({ kind: 'grant' })
      expect(routePermission('deprecated-sync-clipboard-read', page, (asked) => (asked === id ? ['clipboardRead'] : undefined))).toEqual({ kind: 'grant' })
      for (const permission of ['geolocation-approximate', 'deprecated-sync-clipboard-read', 'local-fonts']) expect(routePermission(permission, page, declaringNothing), permission).toEqual({ kind: 'policy', origin: `chrome-extension://${id}` })
    })

    it('has a place for every permission the installed engine can ask for', () => {
      const types = readFileSync(join(__dirname, '..', '..', 'node_modules', 'electron', 'electron.d.ts'), 'utf8')
      const names = new Set<string>()
      for (const handler of ['setPermissionRequestHandler', 'setPermissionCheckHandler']) {
        const union = new RegExp(`${handler}\\(handler: \\(\\(webContents: [^,]+, permission: ([^,]+),`).exec(types)?.[1]
        expect(union, handler).toBeDefined()
        for (const name of union!.matchAll(/'([^']+)'/g)) names.add(name[1]!)
      }
      expect(names.size).toBeGreaterThan(40)
      const routed = Object.fromEntries([...names].sort().map((name) => [name, routePermission(name, page, declaringNothing).kind]))
      // A name the engine adds is refused until it is placed: this table then differs, and the list in permissions.ts is where it is decided.
      expect(routed).toEqual({
        ar: 'deny',
        'automatic-fullscreen': 'deny',
        'background-fetch': 'deny',
        'background-sync': 'grant',
        'captured-surface-control': 'deny',
        'clipboard-read': 'policy',
        'clipboard-sanitized-write': 'grant',
        'deprecated-sync-clipboard-read': 'policy',
        'display-capture': 'deny',
        fileSystem: 'grant',
        fullscreen: 'grant',
        geolocation: 'policy',
        'geolocation-approximate': 'policy',
        'hand-tracking': 'deny',
        hid: 'hardware',
        'idle-detection': 'policy',
        keyboardLock: 'deny',
        'local-fonts': 'policy',
        'local-network': 'grant',
        'local-network-access': 'grant',
        'loopback-network': 'grant',
        media: 'policy',
        mediaKeySystem: 'grant',
        midi: 'policy',
        midiSysex: 'policy',
        nfc: 'deny',
        notifications: 'policy',
        openExternal: 'policy',
        'payment-handler': 'grant',
        'periodic-background-sync': 'deny',
        'persistent-storage': 'grant',
        pointerLock: 'grant',
        'screen-wake-lock': 'grant',
        sensors: 'grant',
        serial: 'hardware',
        'smart-card': 'deny',
        'speaker-selection': 'grant',
        'storage-access': 'grant',
        'system-wake-lock': 'deny',
        'top-level-storage-access': 'grant',
        unknown: 'deny',
        usb: 'hardware',
        vr: 'deny',
        'web-app-installation': 'deny',
        'web-printing': 'deny',
        'window-management': 'policy'
      })
    })

    it('refuses a question from an address that is not an extension id', () => {
      expect(routePermission('media', 'chrome-extension://not-an-id/popup.html')).toEqual({ kind: 'deny' })
    })
  })

  it('asks the user before a web page shares the screen, and never grants it to a page of an extension on its manifest', () => {
    expect(routePermission('display-capture', 'https://meet.example/room')).toEqual({ kind: 'policy', origin: 'https://meet.example' })
    expect(routePermission('display-capture', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/offscreen.html')).toEqual({ kind: 'deny' })
    expect(routePermission('display-capture', 'file:///Users/x/page.html')).toEqual({ kind: 'deny' })
  })

  it('refuses, without a question, a page that has no origin to hold an answer for', () => {
    for (const url of ['file:///Users/x/page.html', 'about:blank', 'data:text/html,x', 'blob:null/1', 'null', '', 'not a url', 'javascript:1']) {
      expect(routePermission('geolocation', url), url).toEqual({ kind: 'deny' })
    }
  })

  it('grants the harmless permissions to anyone, the page without an origin included', () => {
    for (const permission of GRANTED_PERMISSIONS) {
      expect(routePermission(permission, 'file:///x.html')).toEqual({ kind: 'grant' })
      expect(routePermission(permission, 'https://example.com/')).toEqual({ kind: 'grant' })
    }
  })
})

describe('routePermission, for what a question would only get in the way of', () => {
  // Meet, YouTube and Teams keep the screen on during a call or a video; a web mail asks that its offline data stays. Each one was a question
  // that named the permission as the engine does (« utiliser « screen-wake-lock » »), site by site.
  it('grants the screen kept on, the storage kept and the sync of what was written offline, without a question', () => {
    for (const permission of ['screen-wake-lock', 'persistent-storage', 'background-sync']) {
      expect(routePermission(permission, 'https://meet.example/abc'), permission).toEqual({ kind: 'grant' })
      expect(routePermission(permission, 'about:blank', undefined, 'https://meet.example'), permission).toEqual({ kind: 'grant' })
    }
  })

  it('does not grant in silence what tells a site something of the user: their cookies elsewhere, their network, their fonts, their files', () => {
    for (const permission of ['storage-access', 'top-level-storage-access', 'local-network-access', 'local-network', 'loopback-network', 'local-fonts', 'fileSystem', 'speaker-selection', 'mediaKeySystem', 'sensors']) {
      expect(GRANTED_PERMISSIONS.has(permission), permission).toBe(false)
      expect(routePermission(permission, 'https://docs.example/'), permission).toEqual({ kind: 'policy', origin: 'https://docs.example' })
    }
  })

  it('refuses a web page, without a question, what nothing here could give it, and says it is that kind of refusal', () => {
    for (const permission of REFUSED_PERMISSIONS) {
      expect(routePermission(permission, 'https://xr.example/'), permission).toEqual({ kind: 'deny', notOffered: true })
      expect(routePermission(permission, 'about:blank', undefined, 'https://xr.example'), permission).toEqual({ kind: 'deny', notOffered: true })
    }
    expect([...REFUSED_PERMISSIONS].filter((permission) => GRANTED_PERMISSIONS.has(permission))).toEqual([])
    // A page without an origin is refused as before, for the reason it always was.
    expect(routePermission('vr', 'file:///x.html')).toEqual({ kind: 'deny' })
  })
})

describe('routePermission, for the lock of the keyboard', () => {
  it('refuses it to every page, a page of an extension included: Escape stays the way out of a page that fills the window', () => {
    for (const url of ['https://example.com/', 'http://localhost:3000/', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html', 'file:///x.html', 'about:blank']) {
      expect(routePermission('keyboardLock', url, () => ['keyboardLock']), url).toEqual({ kind: 'deny' })
    }
    expect(GRANTED_PERMISSIONS.has('keyboardLock')).toBe(false)
    // Full screen itself and the lock of the pointer are still given without a question.
    expect(routePermission('fullscreen', 'https://example.com/')).toEqual({ kind: 'grant' })
    expect(routePermission('pointerLock', 'https://example.com/')).toEqual({ kind: 'grant' })
  })
})

describe('routePermission, for the web hardware APIs', () => {
  it('hands WebHID, WebUSB and Web Serial to the hardware service for every page, whatever it is and whatever a state file remembers', () => {
    for (const permission of ['hid', 'usb', 'serial']) {
      for (const url of ['https://example.com/', 'http://localhost:3000/', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html', 'file:///x.html', 'about:blank', '']) {
        expect(routePermission(permission, url), `${permission} ${url}`).toEqual({ kind: 'hardware' })
      }
    }
  })

  it('leaves the other permissions as they were', () => {
    expect(routePermission('geolocation', 'https://example.com/')).toEqual({ kind: 'policy', origin: 'https://example.com' })
    expect(routePermission('midi', 'https://example.com/')).toEqual({ kind: 'policy', origin: 'https://example.com' })
  })
})

describe('mayRemember', () => {
  it('keeps an answer for a web origin', () => {
    expect(mayRemember('https://example.com', 'geolocation')).toBe(true)
    expect(mayRemember('https://meet.example', 'display-capture')).toBe(true)
    expect(mayRemember('http://localhost:3000', 'notifications')).toBe(true)
  })

  it('never keeps an answer for the origin "null", which every file: and about:blank page shares', () => {
    expect(mayRemember('null', 'geolocation')).toBe(false)
    expect(mayRemember('', 'geolocation')).toBe(false)
    expect(mayRemember('file://', 'geolocation')).toBe(false)
    expect(mayRemember('chrome-extension://abcdefghijklmnopabcdefghijklmnop', 'geolocation')).toBe(false)
    expect(mayRemember('https://example.com/path', 'geolocation')).toBe(false)
  })

  it('never keeps an answer about a file or a folder: a yes for one would hold for every handle of the origin', () => {
    expect(mayRemember('https://example.com', 'fileSystem')).toBe(false)
  })

  it('never keeps an answer to openExternal: it would open every scheme for the origin', () => {
    expect(mayRemember('https://example.com', 'openExternal')).toBe(false)
  })
})

// « Toujours ouvrir les liens de ce type depuis ce site »: an answer for one scheme of one site, under a name that carries the scheme.
describe('the answer kept for the links of a site to another application', () => {
  it('has a name for each scheme, read back as that scheme', () => {
    expect(appLinkPermission('zoommtg:')).toBe('openExternal:zoommtg:')
    expect(appLinkSchemeOf('openExternal:zoommtg:')).toBe('zoommtg:')
    expect(appLinkPermission('zoommtg:')).not.toBe(appLinkPermission('slack:'))
  })

  it('may be kept for a web origin, and for nothing else', () => {
    expect(mayRemember('https://zoom.us', 'openExternal:zoommtg:')).toBe(true)
    expect(mayRemember('null', 'openExternal:zoommtg:')).toBe(false)
    expect(mayRemember('chrome-extension://abcdefghijklmnopabcdefghijklmnop', 'openExternal:zoommtg:')).toBe(false)
  })

  // Guard: a name written in a state file cannot open what no question would ever offer.
  it('has no name for a scheme that never leaves, for mail and telephone, or for something that is not a scheme: nothing is kept or read for them', () => {
    for (const scheme of ['file:', 'javascript:', 'smb:', 'ssh:', 'https:', 'lucium:', 'x-apple.systempreferences:', 'mailto:', 'tel:', 'zoommtg', 'ZOOMMTG:', 'zoom mtg:', '', ':', `${'a'.repeat(40)}:`]) {
      expect(appLinkPermission(scheme), scheme).toBeNull()
      expect(appLinkSchemeOf(`openExternal:${scheme}`), scheme).toBeNull()
      expect(mayRemember('https://example.com', `openExternal:${scheme}`), scheme).toBe(false)
    }
    expect(appLinkSchemeOf('openExternal')).toBeNull()
    expect(appLinkSchemeOf('geolocation')).toBeNull()
  })

  it('is asked in the words of openExternal, with the scheme, and listed under a name that says the scheme, in both languages', () => {
    expect(permissionPhrase('openExternal:zoommtg:', 'zoommtg:')).toBe('ouvrir une application externe (zoommtg:)')
    expect(permissionPhrase('openExternal:zoommtg:')).toBe('ouvrir une application externe (zoommtg:)')
    expect(permissionName('openExternal:zoommtg:')).toBe('Ouvrir les liens zoommtg: dans une autre application')
    setLanguage('en')
    expect(permissionName('openExternal:zoommtg:')).toBe('Open zoommtg: links in another app')
    setLanguage('fr')
  })

  it('is written by the state like any answer, listed with the answers of the site, and forgotten on demand', () => {
    const ctx = { now: 1, newId: () => 'x' }
    let state = reduce(createInitialState(ctx), { type: 'permission/set', origin: 'https://zoom.us', permission: 'openExternal:zoommtg:', decision: 'allow' }, ctx)
    expect(rememberedDecision(state.sitePermissions, 'https://zoom.us', 'openExternal:zoommtg:')).toBe('allow')
    // Another scheme of the same site, and the same scheme of another site, have no answer.
    expect(rememberedDecision(state.sitePermissions, 'https://zoom.us', 'openExternal:slack:')).toBeUndefined()
    expect(rememberedDecision(state.sitePermissions, 'https://evil.example', 'openExternal:zoommtg:')).toBeUndefined()
    expect(sitesWithAnswers(state.sitePermissions)).toEqual([['https://zoom.us', { 'openExternal:zoommtg:': 'allow' }]])
    expect(sitePermissionRows(state.sitePermissions, 'https://zoom.us', false)).toEqual([{ permission: 'openExternal:zoommtg:', own: 'allow', everywhere: undefined }])
    state = reduce(state, { type: 'permission/set', origin: 'https://zoom.us', permission: 'openExternal:zoommtg:', decision: null }, ctx)
    expect(sitesWithAnswers(state.sitePermissions)).toEqual([])
  })
})

describe('the prompt', () => {
  it('names the scheme that would open', () => {
    expect(externalSchemeOf('mailto:ada@example.com?subject=x')).toBe('mailto:')
    expect(externalSchemeOf('slack://channel?team=1')).toBe('slack:')
    expect(externalSchemeOf('x-apple.systempreferences:com.apple.preference.security')).toBe('x-apple.systempreferences:')
    expect(externalSchemeOf('not a url')).toBe('')
    expect(externalSchemeOf(undefined)).toBe('')
    expect(externalSchemeOf(`${'a'.repeat(200)}://x`).length).toBeLessThanOrEqual(40)
  })

  it('says what is asked, with the scheme for an external application', () => {
    expect(permissionPhrase('geolocation')).toBe('connaître votre position')
    expect(permissionPhrase('openExternal', 'mailto:')).toBe('ouvrir une application externe (mailto:)')
    expect(permissionPhrase('openExternal')).toBe('ouvrir une application externe')
  })

  it('names the file or the folder a page wants, and whether it is read or modified', () => {
    expect(fileSystemDetail({ filePath: '/Users/moi/Documents/notes.txt', isDirectory: false, fileAccessType: 'readable' })).toBe(frenchSpaces('lire le fichier « /Users/moi/Documents/notes.txt »'))
    expect(fileSystemDetail({ filePath: '/Users/moi/Documents/notes.txt', isDirectory: false, fileAccessType: 'writable' })).toBe(frenchSpaces('modifier le fichier « /Users/moi/Documents/notes.txt »'))
    expect(fileSystemDetail({ filePath: '/Users/moi/Documents', isDirectory: true, fileAccessType: 'readable' })).toBe(frenchSpaces('lire le dossier « /Users/moi/Documents » et tout ce qu’il contient'))
    expect(fileSystemDetail({ filePath: '/Users/moi/Documents', isDirectory: true, fileAccessType: 'writable' })).toBe(frenchSpaces('modifier le dossier « /Users/moi/Documents » et tout ce qu’il contient'))
    // A mode that is not said is told as the stronger one.
    expect(fileSystemDetail({ filePath: '/Users/moi/a.txt' })).toBe(frenchSpaces('modifier le fichier « /Users/moi/a.txt »'))
    expect(permissionPhrase('fileSystem', fileSystemDetail({ filePath: '/Users/moi/Documents', isDirectory: true, fileAccessType: 'writable' }))).toBe(frenchSpaces('modifier le dossier « /Users/moi/Documents » et tout ce qu’il contient'))
    expect(permissionSheet('https://editeur.example', 'fileSystem', fileSystemDetail({ filePath: '/Users/moi/a.txt', fileAccessType: 'readable' })).message).toBe(frenchSpaces('editeur.example souhaite lire le fichier « /Users/moi/a.txt ».'))
  })

  it('says the least when a request about files names none, never the raw name of the permission', () => {
    for (const details of [undefined, null, {}, { filePath: '' }, { filePath: 42 }, 'chemin']) expect(fileSystemDetail(details)).toBe('')
    expect(permissionPhrase('fileSystem')).toBe('accéder à un fichier ou à un dossier de cet ordinateur')
    expect(permissionPhrase('fileSystem', '')).toBe('accéder à un fichier ou à un dossier de cet ordinateur')
  })

  it('prints a path without what hides or reorders it, and keeps the two ends of a long one', () => {
    expect(fileSystemDetail({ filePath: '/Users/moi/facture‮fdp.exe', fileAccessType: 'readable' })).toBe(frenchSpaces('lire le fichier « /Users/moi/facture?fdp.exe »'))
    expect(fileSystemDetail({ filePath: '/Users/moi/a\nb\u0000c', fileAccessType: 'readable' })).toBe(frenchSpaces('lire le fichier « /Users/moi/a?b?c »'))
    const long = `/Volumes/Disque/${'d'.repeat(400)}/rapport-final.pdf`
    const shown = fileSystemDetail({ filePath: long, fileAccessType: 'readable' })
    expect(shown).toContain('/Volumes/Disque/')
    expect(shown).toContain('…')
    expect(shown.endsWith(frenchSpaces('/rapport-final.pdf »'))).toBe(true)
    expect(shown.length).toBeLessThan(200)
    expect(permissionPhrase('geolocation', 'mailto:')).toBe('connaître votre position')
    expect(permissionPhrase('some-new-permission')).toBe(frenchSpaces('utiliser « some-new-permission »'))
    expect(permissionPhrase('display-capture')).toBe('partager votre écran ou une fenêtre')
  })

  it('asks in words for what the engine names in its own way, in both languages', () => {
    expect(permissionPhrase('storage-access')).toBe('utiliser ses cookies et ses données dans la page qui l’intègre')
    expect(permissionPhrase('local-fonts')).toBe('lire la liste des polices installées sur cet ordinateur')
    expect(permissionPhrase('local-network-access')).toBe(permissionPhrase('local-network'))
    expect(permissionPhrase('deprecated-sync-clipboard-read')).toBe(permissionPhrase('clipboard-read'))
    expect(permissionPhrase('midiSysex')).not.toBe(permissionPhrase('midi'))
    expect(permissionSheet('https://docs.example', 'speaker-selection').message).toBe(frenchSpaces('docs.example souhaite choisir la sortie audio (haut-parleurs, casque).'))
    expect(permissionName('storage-access')).toBe('Cookies dans une page qui l’intègre')
    // Only a name that came after the list keeps the engine's word.
    expect(permissionPhrase('some-new-permission')).toBe(frenchSpaces('utiliser « some-new-permission »'))
  })

  it('names a remembered permission in French where it has a name, and shows its own otherwise', () => {
    expect(permissionName('display-capture')).toBe('Partage d’écran')
    expect(permissionName('geolocation')).toBe('Position')
    expect(permissionName('some-new-permission')).toBe('some-new-permission')
  })

  it('names the camera and the microphone as one thing, the way the site panel lists it (it showed "media")', () => {
    expect(MEDIA_PERMISSION).toBe('media')
    expect(permissionName('media')).toBe('Caméra et micro')
  })
})

describe('questionPlace', () => {
  it('puts the question of a popup on a sheet of the system: it has no panel (Meet in a window of its own could not be given the camera)', () => {
    expect(questionPlace(true, undefined)).toBe('sheet')
    expect(questionPlace(true, true)).toBe('sheet')
    expect(questionPlace(true, false)).toBe('sheet')
  })

  it('puts the question of a page that no window of the browser has a panel for (a mini window, a web app) on a sheet', () => {
    expect(questionPlace(false, false)).toBe('sheet')
  })

  it('leaves the question of a tab in its panel, and of a page that is not known as it always was', () => {
    expect(questionPlace(false, true)).toBe('panel')
    expect(questionPlace(false, undefined)).toBe('panel')
  })
})

describe('permissionSheet', () => {
  it('names the site without its scheme and what it wants, with the two answers and a word on the answer not being kept', () => {
    const sheet = permissionSheet('https://meet.google.com', 'media')
    expect(sheet.message).toBe('meet.google.com souhaite utiliser votre caméra ou votre micro.')
    expect(sheet.deny).toBe('Refuser')
    expect(sheet.allow).toBe('Autoriser')
    expect(sheet.detail).toContain('n’est pas mémorisé')
  })

  it('shows what an openExternal request would open, and a port of the address', () => {
    expect(permissionSheet('http://localhost:3000', 'openExternal', 'mailto:').message).toBe('localhost:3000 souhaite ouvrir une application externe (mailto:).')
  })

  it('does not take a site that is not a web address for one: it is shown as it is', () => {
    expect(permissionSheet('null', 'media').message).toBe('null souhaite utiliser votre caméra ou votre micro.')
  })
})

describe('hasQuestionPanel', () => {
  it('has no panel for the preview of a link: the preview is the panel on show, and a question queued behind it is never seen', () => {
    expect(hasQuestionPanel(true, true)).toBe(false)
  })

  it('has one for a page of a window of the browser, and none for a page no window of the browser owns', () => {
    expect(hasQuestionPanel(true, false)).toBe(true)
    expect(hasQuestionPanel(false, false)).toBe(false)
    expect(hasQuestionPanel(false, true)).toBe(false)
  })

  it('sends the question of a preview to a sheet of the system', () => {
    expect(questionPlace(false, hasQuestionPanel(true, true))).toBe('sheet')
    expect(questionPlace(false, hasQuestionPanel(true, false))).toBe('panel')
  })
})

describe('the permissions of the site on show', () => {
  const site = 'https://meet.example'
  const answers = {
    [ALL_SITES]: { notifications: 'allow' as const, geolocation: 'allow' as const },
    [site]: { geolocation: 'deny' as const, media: 'allow' as const, 'clipboard-read': 'allow' as const },
    'https://other.example': { midi: 'allow' as const }
  }

  it('lists the camera and microphone first when the panel offers them, then every answer of the site and no one else’s', () => {
    expect(sitePermissionRows(answers, site, true).map((r) => [r.permission, r.own])).toEqual([['media', 'allow'], ['geolocation', 'deny'], ['clipboard-read', 'allow'], ['notifications', undefined]])
    // Without the offer the camera has no row of its own to ask: the answer already given is still the site's, and is listed with the rest, once.
    expect(sitePermissionRows(answers, site, false).map((r) => r.permission)).toEqual(['geolocation', 'clipboard-read', 'notifications'])
    expect(sitePermissionRows(answers, 'https://empty.example', true).map((r) => [r.permission, r.own])).toEqual([['media', undefined], ['notifications', undefined]])
  })

  it('names the answer for every site only for the notifications, and only while the site has no answer of its own', () => {
    const rows = sitePermissionRows(answers, site, true)
    expect(rows.find((r) => r.permission === 'notifications')).toEqual({ permission: 'notifications', own: undefined, everywhere: 'allow' })
    // The position is allowed for every site in this record, and is not an answer for any site: it is never a row of a site that did not get one.
    expect(sitePermissionRows(answers, 'https://empty.example', false).map((r) => r.permission)).toEqual(['notifications'])
    expect(sitePermissionRows({ ...answers, [site]: { notifications: 'deny' } }, site, false)).toEqual([{ permission: 'notifications', own: 'deny', everywhere: undefined }])
  })

  it('gives a container no answer for every site (its record has none)', () => {
    expect(sitePermissionRows({ [site]: { geolocation: 'deny' } }, site, true).map((r) => r.permission)).toEqual(['media', 'geolocation'])
  })

  it('turns the choice of a row into the answer to keep: "ask" keeps none', () => {
    expect(['allow', 'deny', 'ask', '', 'anything'].map(decisionOfChoice)).toEqual(['allow', 'deny', null, null, null])
  })
})

// Without it, an answer had to be given site by site, each time it was asked again.
describe('an answer for every site', () => {
  const all = { [ALL_SITES]: { notifications: 'allow' as const, geolocation: 'allow' as const, media: 'allow' as const } }

  it('answers the notifications of a site that has no answer of its own', () => {
    expect(rememberedDecision(all, 'https://app.slack.com', 'notifications')).toBe('allow')
    expect(rememberedDecision({ [ALL_SITES]: { notifications: 'deny' } }, 'https://app.slack.com', 'notifications')).toBe('deny')
  })

  it('never answers the camera, the microphone, the position or the screen for every site, whatever a state file says', () => {
    // Each one is given an answer for every site, so that only the rule can keep it from being read.
    const permissions = ['geolocation', 'media', 'display-capture', 'clipboard-read', 'midi']
    const every = { [ALL_SITES]: Object.fromEntries(permissions.map((permission) => [permission, 'allow' as const])) }
    for (const permission of permissions) expect(rememberedDecision(every, 'https://example.org', permission), permission).toBeUndefined()
  })

  it('gives way to the answer the site has of its own, allow or deny', () => {
    expect(rememberedDecision({ ...all, 'https://noisy.example': { notifications: 'deny' } }, 'https://noisy.example', 'notifications')).toBe('deny')
    expect(rememberedDecision({ [ALL_SITES]: { notifications: 'deny' }, 'https://wanted.example': { notifications: 'allow' } }, 'https://wanted.example', 'notifications')).toBe('allow')
  })

  // Drawn in the settings in renderer/settings-site-permissions.test.ts.
  it('is not listed among the sites of the settings: the list shows the sites that have an answer of their own, and the answer for every site has its own menu', () => {
    const record = { [ALL_SITES]: { notifications: 'allow' as const }, 'https://a.example': { geolocation: 'deny' as const }, 'https://forgotten.example': {}, 'https://b.example': { notifications: 'allow' as const, midi: 'deny' as const } }
    expect(sitesWithAnswers(record)).toEqual([['https://a.example', { geolocation: 'deny' }], ['https://b.example', { notifications: 'allow', midi: 'deny' }]])
    expect(sitesWithAnswers({ [ALL_SITES]: { notifications: 'deny' } })).toEqual([])
    expect(sitesWithAnswers({})).toEqual([])
  })

  it('stays among the answers when the sites go over the ceiling, and goes when the user chooses "Demander"', () => {
    let state = reduce(createInitialState({ now: 1, newId: () => 'x' }), { type: 'permission/set', origin: ALL_SITES, permission: 'notifications', decision: 'allow' }, { now: 1, newId: () => 'x' })
    // The sites come after it, up to five short of the ceiling in one go (each answer copies the whole record: two thousand of them one by one are
    // seconds of processor that say nothing more); the reducer then adds the last ones, up to the ceiling and five past it.
    const start = SITE_PERMISSIONS_MAX - 6
    state = { ...state, sitePermissions: { ...state.sitePermissions, ...Object.fromEntries(Array.from({ length: start }, (_, i) => [`https://s${i}.example`, { notifications: 'deny' as const }])) } }
    expect(Object.keys(state.sitePermissions)[0]).toBe(ALL_SITES)
    for (let i = start; i < SITE_PERMISSIONS_MAX + 5; i++) state = reduce(state, { type: 'permission/set', origin: `https://s${i}.example`, permission: 'notifications', decision: 'deny' }, { now: 1, newId: () => 'x' })
    expect(state.sitePermissions[ALL_SITES]).toEqual({ notifications: 'allow' })
    expect(Object.keys(state.sitePermissions)).toHaveLength(SITE_PERMISSIONS_MAX)
    // The sites that went are the oldest ones, not the answer for every site.
    expect(state.sitePermissions['https://s5.example']).toBeUndefined()
    expect(state.sitePermissions['https://s6.example']).toEqual({ notifications: 'deny' })
    state = reduce(state, { type: 'permission/set', origin: ALL_SITES, permission: 'notifications', decision: null }, { now: 1, newId: () => 'x' })
    expect(state.sitePermissions[ALL_SITES]).toBeUndefined()
  })
})

describe('allowLabel', () => {
  it('says "this time" when a yes is held for the tab only: the answer could be remembered and the box is not ticked', () => {
    expect(allowLabel(true, false)).toBe('Autoriser cette fois')
  })

  it('is the plain word once the box is ticked, and when no answer is ever held (private tab, permission asked each time)', () => {
    expect(allowLabel(true, true)).toBe('Autoriser')
    expect(allowLabel(false, false)).toBe('Autoriser')
    expect(allowLabel(false, true)).toBe('Autoriser')
  })
})
