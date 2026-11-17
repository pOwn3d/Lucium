import { describe, expect, it } from 'vitest'
import {
  ABOUT_LICENSE,
  ABOUT_ROWS,
  ABOUT_TARGETS,
  COMPANY_URL,
  ISSUES_URL,
  LICENSES_DOC,
  REPOSITORY_URL,
  aboutCopyright,
  aboutCredit,
  aboutEngine,
  aboutEngineLabel,
  aboutFootnote,
  aboutPanelOptions,
  aboutTagline,
  aboutReport,
  aboutUrl,
  aboutVersion,
  aboutVersionLabel,
  displayAddress,
  parseAboutTarget
} from './about'
import { isNavigableUrl } from './url'
import { setLanguage } from './i18n'

describe('the addresses of the About group', () => {
  const addresses = { site: COMPANY_URL, source: REPOSITORY_URL, issues: ISSUES_URL, news: `${REPOSITORY_URL}/releases` }

  it('are all valid https addresses, without credentials, a query or a fragment', () => {
    for (const [name, address] of Object.entries(addresses)) {
      expect(URL.canParse(address), name).toBe(true)
      const url = new URL(address)
      expect(url.protocol, name).toBe('https:')
      expect(url.username + url.password, name).toBe('')
      expect(url.search + url.hash, name).toBe('')
      expect(address, name).toBe(address.trim())
    }
  })

  it('are addresses a tab may open (the reducer refuses anything else)', () => {
    for (const address of Object.values(addresses)) expect(isNavigableUrl(address), address).toBe(true)
  })

  it('point the company link at ConsilioWeb and the issues at the repository', () => {
    expect(new URL(COMPANY_URL).hostname).toBe('consilioweb.fr')
    expect(ISSUES_URL).toBe(`${REPOSITORY_URL}/issues`)
  })

  it('are what aboutUrl resolves, the licences excepted', () => {
    expect(aboutUrl('site')).toBe(COMPANY_URL)
    expect(aboutUrl('source')).toBe(REPOSITORY_URL)
    expect(aboutUrl('issues')).toBe(ISSUES_URL)
    expect(aboutUrl('news')).toBe(`${REPOSITORY_URL}/releases`)
    expect(aboutUrl('licenses')).toBeNull()
  })

  it('are shown without their scheme or a closing slash', () => {
    expect(displayAddress('https://consilioweb.fr')).toBe('consilioweb.fr')
    expect(displayAddress('https://consilioweb.fr/')).toBe('consilioweb.fr')
    expect(displayAddress(REPOSITORY_URL)).toBe(REPOSITORY_URL.replace('https://', ''))
  })
})

describe('parseAboutTarget', () => {
  it('lets the five words through', () => {
    for (const target of ABOUT_TARGETS) expect(parseAboutTarget(target)).toBe(target)
  })

  it('refuses an address, a path, a name from the prototype and anything that is not a string', () => {
    for (const raw of ['https://consilioweb.fr', 'javascript:alert(1)', 'file:///etc/passwd', '../docs', 'Site', ' site', 'site ', '', '__proto__', 'constructor', 'toString']) {
      expect(parseAboutTarget(raw), String(raw)).toBeNull()
    }
    for (const raw of [undefined, null, 0, true, {}, [], ['site'], { target: 'site' }]) expect(parseAboutTarget(raw)).toBeNull()
  })
})

describe('the rows of the group', () => {
  it('follow the brief: the company first, then the code, the problems, the news, the licences', () => {
    expect(ABOUT_ROWS.map((row) => row.target)).toEqual(['site', 'source', 'issues', 'news', 'licenses'])
    expect(ABOUT_ROWS.map((row) => row.label)).toEqual(['Un projet de ConsilioWeb', 'Code source et contributions', 'Signaler un problème', 'Nouveautés', 'Licences des composants'])
  })

  it('cover every target once, each showing where it leads', () => {
    expect([...ABOUT_ROWS.map((row) => row.target)].sort()).toEqual([...ABOUT_TARGETS].sort())
    expect(ABOUT_ROWS[0]!.detail).toBe('consilioweb.fr')
    for (const row of ABOUT_ROWS) {
      const url = aboutUrl(row.target)
      expect(row.detail, row.target).toBe(url === null ? LICENSES_DOC : displayAddress(url))
    }
  })
})

describe('the texts', () => {
  it('say what the brief says', () => {
    expect(aboutTagline()).toBe('Navigateur libre et communautaire, gratuit, code ouvert — licence GPL-3.0-or-later')
    expect(aboutCopyright()).toBe('© 2026 les contributeurs de Lucium — un projet de ConsilioWeb')
    expect(aboutCredit()).toBe('Un projet de ConsilioWeb')
    expect(aboutFootnote()).toBe('Rien n’est envoyé à ConsilioWeb. Un lien ne s’ouvre que si vous cliquez dessus.')
  })

  it('are read in the language of the interface when they are shown, the macOS panel included', () => {
    setLanguage('en')
    try {
      expect(aboutTagline()).toBe('A free, community-made, open-source browser that costs nothing — GPL-3.0-or-later license')
      expect(ABOUT_ROWS[0]!.label).toBe('A ConsilioWeb project')
      expect(aboutVersionLabel('')).toBe('Unknown version')
      const panel = aboutPanelOptions(undefined)
      expect(panel.applicationVersion).toBe('unknown')
      expect(panel.copyright).toBe('© 2026 the Lucium contributors — a ConsilioWeb project')
      expect(panel.credits).toBe('A free, community-made, open-source browser that costs nothing.\nGPL-3.0-or-later license.\nhttps://consilioweb.fr')
    } finally {
      setLanguage('fr')
    }
  })
})

describe('aboutVersion', () => {
  it('keeps a version and nothing else', () => {
    expect(aboutVersion('0.1.0')).toBe('0.1.0')
    expect(aboutVersion('1.2')).toBe('1.2')
    expect(aboutVersion('2.0.0-beta.1')).toBe('2.0.0-beta.1')
    expect(aboutVersion('1.0.0+build.5')).toBe('1.0.0+build.5')
  })

  it('answers an empty text for what is not one (markup, a long text, another type)', () => {
    for (const raw of ['', ' 0.1.0', '0.1.0 ', 'v0.1.0', 'dev', '0.1.0<script>', '<b>1</b>', '1.2.3.4.5', `1.0.0-${'x'.repeat(40)}`, undefined, null, 1, {}, ['0.1.0']]) {
      expect(aboutVersion(raw), String(raw)).toBe('')
    }
  })

  it('is formatted as "Version 0.1.0", or "Version inconnue" without one', () => {
    expect(aboutVersionLabel('0.1.0')).toBe('Version 0.1.0')
    expect(aboutVersionLabel('')).toBe('Version inconnue')
    expect(aboutVersionLabel('<b>')).toBe('Version inconnue')
    expect(aboutVersionLabel(undefined)).toBe('Version inconnue')
  })
})

describe('aboutPanelOptions', () => {
  it('carries the name, the version, the copyright, the licence and the site', () => {
    const options = aboutPanelOptions('0.1.0')
    expect(options.applicationName).toBe('Lucium')
    expect(options.applicationVersion).toBe('0.1.0')
    expect(options.copyright).toBe(aboutCopyright())
    expect(options.credits).toBe('Navigateur libre et communautaire, gratuit, code ouvert.\nLicence GPL-3.0-or-later.\nhttps://consilioweb.fr')
    expect(options.credits).toContain(ABOUT_LICENSE)
    expect(options.credits).toContain(COMPANY_URL)
  })

  it('shows no second number in parentheses after the version', () => {
    expect(aboutPanelOptions('0.1.0').version).toBe('')
  })

  it('never hands the panel a version it was not given as one', () => {
    expect(aboutPanelOptions('<script>').applicationVersion).toBe('inconnue')
    expect(aboutPanelOptions(undefined).applicationVersion).toBe('inconnue')
  })

  it('is text only', () => {
    for (const value of Object.values(aboutPanelOptions('0.1.0'))) expect(typeof value).toBe('string')
  })
})

describe('what the About window says of the engine', () => {
  const engine = aboutEngine({ chrome: '156.0.7339.41', electron: '45.2.0' }, 'darwin')

  it('keeps the major versions and names the system', () => {
    expect(engine).toEqual({ chromium: '156', electron: '45', platform: 'macOS' })
    expect(aboutEngineLabel(engine)).toBe('Chromium 156 · Electron 45 · macOS')
    expect(aboutEngine({}, 'freebsd').platform).toBe('freebsd')
  })

  it('leaves out a version that is not one, rather than printing it', () => {
    expect(aboutEngineLabel(aboutEngine({ chrome: undefined, electron: '<b>45</b>' }, 'win32'))).toBe('Windows')
  })

  it('starts a bug report with the version and the engine, in one line', () => {
    expect(aboutReport('0.1.0', engine)).toBe('Lucium 0.1.0 · Chromium 156 · Electron 45 · macOS')
    expect(aboutReport(42, engine)).toBe('Lucium version inconnue · Chromium 156 · Electron 45 · macOS')
  })
})
