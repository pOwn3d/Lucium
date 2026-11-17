import { describe, expect, it } from 'vitest'
import {
  CertificateExceptions,
  canBypassCertificateError,
  describeCertificateError,
  describeCrash,
  describeLoadError,
  isLocalNetworkFailure,
  isLocalNetworkHost,
  isOwnNetworkUrl,
  LOCAL_NETWORK_SETTINGS_URL,
  displaySite,
  errorActionUrl,
  errorName,
  ERROR_PAGE_POLICY,
  errorPageDocument,
  exceptionHost,
  isCertificateError,
  isCrash,
  isReportableFailure,
  parseErrorAction,
  renderErrorPage,
  type CertificateFacts,
  type ErrorPageModel
} from './error-pages'
import { setLanguage } from './i18n'
import { frenchSpaces } from './french-typography'

const facts: CertificateFacts = { fingerprint: 'sha256/AAAA', subject: 'localhost', issuer: 'Autorité <test>', validFrom: 1_700_000_000, validUntil: 1_800_000_000 }

describe('which failures get a page', () => {
  it('reports a failed main frame', () => {
    expect(isReportableFailure({ code: -105, isMainFrame: true, url: 'https://nope.invalid/' })).toBe(true)
  })

  it('ignores a failing subframe: the page around it is fine', () => {
    expect(isReportableFailure({ code: -105, isMainFrame: false, url: 'https://ads.invalid/frame' })).toBe(false)
  })

  it('ignores a cancelled navigation (ERR_ABORTED): a newer one replaced it, or it became a download', () => {
    expect(isReportableFailure({ code: -3, isMainFrame: true, url: 'https://example.com/file.zip' })).toBe(false)
  })

  it('ignores Chromium’s own error document', () => {
    expect(isReportableFailure({ code: -2, isMainFrame: true, url: 'chrome-error://chromewebdata/' })).toBe(false)
  })

  it('names an error from its description first, with or without the net:: prefix', () => {
    expect(errorName(-105, 'ERR_NAME_NOT_RESOLVED')).toBe('ERR_NAME_NOT_RESOLVED')
    expect(errorName(-102, 'net::ERR_CONNECTION_REFUSED')).toBe('ERR_CONNECTION_REFUSED')
    expect(errorName(-9999, '')).toBe('ERR_UNKNOWN_9999')
  })

  it('tells certificate errors from the others', () => {
    expect(isCertificateError('ERR_CERT_AUTHORITY_INVALID')).toBe(true)
    expect(isCertificateError('ERR_SSL_PINNED_KEY_NOT_IN_CERT_CHAIN')).toBe(true)
    expect(isCertificateError('ERR_CONNECTION_REFUSED')).toBe(false)
    expect(isCertificateError('ERR_SSL_PROTOCOL_ERROR')).toBe(false)
  })
})

describe('what the failure pages say', () => {
  it.each([
    ['ERR_NAME_NOT_RESOLVED', /introuvable/],
    ['ERR_CONNECTION_REFUSED', /refusé la connexion/],
    ['ERR_INTERNET_DISCONNECTED', /pas connecté à Internet/],
    ['ERR_CONNECTION_TIMED_OUT', /trop de temps/]
  ])('explains %s in French, naming the site', (name, pattern) => {
    const { reason } = describeLoadError(name, 'exemple.fr')
    expect(reason).toMatch(pattern)
    if (name !== 'ERR_INTERNET_DISCONNECTED') expect(reason).toContain('exemple.fr')
  })

  it('has a sentence for an error it does not know', () => {
    expect(describeLoadError('ERR_SOMETHING_NEW', 'exemple.fr').reason).toBe('exemple.fr n’a pas pu être chargé.')
  })

  it('gives each certificate error a reason, and a default one', () => {
    expect(describeCertificateError('ERR_CERT_AUTHORITY_INVALID')).toMatch(/autorité/)
    expect(describeCertificateError('ERR_CERT_DATE_INVALID')).toMatch(/expiré/)
    expect(describeCertificateError('ERR_CERT_COMMON_NAME_INVALID')).toMatch(/autre nom de domaine/)
    expect(describeCertificateError('ERR_CERT_SOMETHING_NEW')).toMatch(/n’est pas valide/)
  })

  it('names the shown site by host and port, and a file by its path', () => {
    expect(displaySite('https://exemple.fr:8443/a?b=1')).toBe('exemple.fr:8443')
    expect(displaySite('file:///Users/moi/mon%20fichier.html')).toBe('/Users/moi/mon fichier.html')
    expect(displaySite('pas une adresse')).toBe('pas une adresse')
  })

  it('does not throw on a file path with a malformed escape, which would fail the error page itself', () => {
    expect(() => displaySite('file:///a/%E0%A4%A')).not.toThrow()
    expect(displaySite('file:///a/%E0%A4%A')).toBe('/a/%E0%A4%A')
    const page = renderErrorPage({ kind: 'load', url: 'file:///a/%E0%A4%A', name: 'ERR_FILE_NOT_FOUND', nonce: 'n' })
    expect(page.title).toBe('/a/%E0%A4%A')
  })
})

describe('the failure page', () => {
  it('shows the title, the reason, the technical name and a retry link carrying its nonce', () => {
    const page = renderErrorPage({ kind: 'load', url: 'https://exemple.fr/chemin', name: 'ERR_NAME_NOT_RESOLVED', nonce: 'n0nce' })
    expect(page.title).toBe('exemple.fr')
    expect(page.body).toContain('Ce site est introuvable')
    expect(page.body).toContain('<strong>exemple.fr</strong>')
    expect(page.body).toContain('ERR_NAME_NOT_RESOLVED')
    expect(page.body).toContain(`href="${errorActionUrl('retry', 'n0nce')}"`)
    expect(page.body).toContain('Réessayer')
  })

  it('gives each family its colour, icon and title, shows the address in monospace, and folds the name of the error under "Détails techniques"', () => {
    const body = (name: string) => renderErrorPage({ kind: 'load', url: 'https://exemple.fr/chemin?q=1', name, nonce: 'n' }).body
    expect(body('ERR_CONNECTION_REFUSED')).toMatch(/ep-icon danger.*Ce site ne répond pas/)
    expect(body('ERR_NAME_NOT_RESOLVED')).toMatch(/ep-icon warn.*Ce site est introuvable/)
    expect(body('ERR_INTERNET_DISCONNECTED')).toMatch(/ep-icon neutral.*Vous êtes hors ligne/)
    expect(body('ERR_BLOCKED_BY_CLIENT')).toMatch(/ep-icon accent.*Page bloquée/)
    expect(body('ERR_SSL_PROTOCOL_ERROR')).toContain('Impossible d’accéder à ce site')
    const page = body('ERR_CONNECTION_REFUSED')
    expect(page).toContain('<p class="addr">https://exemple.fr/chemin?q=1</p>')
    // The name of the error is not in the page's text any more: it sits in the folded details, after the buttons.
    expect(page).toMatch(/<\/div><details><summary>Détails techniques<\/summary><p class="code">ERR_CONNECTION_REFUSED<\/p><\/details><\/main>$/)
    expect(page.indexOf('class="actions"')).toBeLessThan(page.indexOf('<details>'))
  })

  it('escapes what comes from the address: a hostile address cannot inject markup', () => {
    const page = renderErrorPage({ kind: 'load', url: 'http://<img src=x onerror=alert(1)>/', name: 'ERR_CONNECTION_REFUSED', nonce: 'n' })
    expect(page.body).not.toContain('<img')
    expect(page.body).toContain('&lt;img')
    expect(page.head).not.toContain('<img')
    expect(page.head).toContain('&lt;img')
  })

  // Every value of the markup is escaped; should one ever not be, the page still runs and loads nothing.
  it('gives every page a policy that allows its own style and nothing else, before the style', () => {
    const models: ErrorPageModel[] = [
      { kind: 'load', url: 'https://exemple.fr/', name: 'ERR_CONNECTION_REFUSED', nonce: 'n' },
      { kind: 'certificate', url: 'https://exemple.fr/', name: 'ERR_CERT_DATE_INVALID', nonce: 'n', canGoBack: false, certificate: null },
      { kind: 'crash', url: 'https://exemple.fr/', reason: 'crashed', nonce: 'n' }
    ]
    for (const model of models) {
      const { head, body } = renderErrorPage(model)
      const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(head)?.[1]
      expect(policy, model.kind).toBe("default-src 'none'; style-src 'unsafe-inline'")
      expect(head.indexOf('Content-Security-Policy')).toBeLessThan(head.indexOf('<style>'))
      // Nothing of the page needs more: no script, no picture loaded, no handler in an attribute.
      expect(`${head}${body}`).not.toMatch(/<script|<img|<iframe|<link|\son[a-z]+=|url\(/i)
    }
    expect(errorPageDocument(models[2]!)).toContain(ERROR_PAGE_POLICY)
  })

  it('follows the system appearance, light and dark', () => {
    const { head } = renderErrorPage({ kind: 'load', url: 'https://exemple.fr/', name: 'ERR_FAILED', nonce: 'n' })
    expect(head).toContain('color-scheme')
    // Both appearances come from the design tokens: `light-dark()` reads the colour scheme the page declares (light and dark).
    expect(head).toContain('color-scheme: light dark')
    expect(head).toContain('light-dark(')
  })
})

describe('the certificate page', () => {
  const base = { kind: 'certificate' as const, url: 'https://auto-signe.test/', name: 'ERR_CERT_AUTHORITY_INVALID', nonce: 'c3rt', canGoBack: true, certificate: facts }

  it('says the connection is not private and offers to go on, unsafely, with its details', () => {
    const page = renderErrorPage(base)
    expect(page.body).toContain('Votre connexion n’est pas privée')
    expect(page.body).toContain('Continuer quand même (non sécurisé)')
    expect(page.body).toContain(`href="${errorActionUrl('proceed', 'c3rt')}"`)
    expect(page.body).toContain('sha256/AAAA')
    expect(page.body).toContain('Autorité &lt;test&gt;')
  })

  it('offers no way on when the error cannot be bypassed', () => {
    for (const name of ['ERR_CERT_REVOKED', 'ERR_SSL_PINNED_KEY_NOT_IN_CERT_CHAIN', 'ERR_CERTIFICATE_TRANSPARENCY_REQUIRED']) {
      expect(canBypassCertificateError(name)).toBe(false)
      expect(renderErrorPage({ ...base, name }).body).not.toContain('Continuer quand même')
    }
    expect(canBypassCertificateError('ERR_CERT_AUTHORITY_INVALID')).toBe(true)
    expect(canBypassCertificateError('ERR_CONNECTION_REFUSED')).toBe(false)
  })

  it('offers no way on when the certificate was not seen: there is nothing to trust', () => {
    expect(renderErrorPage({ ...base, certificate: null }).body).not.toContain('Continuer quand même')
  })

  // The developer who opens a preproduction on .local, localhost or a private address learns how to open it without this page; a site of the internet
  // never gets the hint (nothing of the local network is trusted by its name alone).
  it('names Developer Mode on the page of a site of this machine or of the local network, and only there', () => {
    // No key in the sentence: the shortcut of the mode can be changed, and the page does not know the shortcuts.
    const hint = frenchSpaces('Le mode développeur, dans « Infos et réglages du site », l’ouvre sans cette page')
    for (const url of ['https://app.local:8443/', 'https://localhost:5173/', 'https://127.0.0.1:8443/', 'https://192.168.1.20/', 'https://[::1]:8443/']) {
      expect(isOwnNetworkUrl(url), url).toBe(true)
      expect(renderErrorPage({ ...base, url }).body, url).toContain(hint)
    }
    for (const url of ['https://auto-signe.test/', 'https://banque.example/', 'https://10.exemple.com/']) {
      expect(isOwnNetworkUrl(url), url).toBe(false)
      expect(renderErrorPage({ ...base, url }).body, url).not.toContain(hint)
    }
    // Nothing to open for an error nobody may click through.
    expect(renderErrorPage({ ...base, url: 'https://app.local/', name: 'ERR_CERT_REVOKED' }).body).not.toContain(hint)
  })

  it('goes back when there is somewhere to go back to, otherwise retries', () => {
    expect(renderErrorPage(base).body).toContain(errorActionUrl('back', 'c3rt'))
    const alone = renderErrorPage({ ...base, canGoBack: false }).body
    expect(alone).not.toContain(errorActionUrl('back', 'c3rt'))
    expect(alone).toContain(errorActionUrl('retry', 'c3rt'))
  })
})

describe('the crash page', () => {
  it('says the tab crashed and offers to reload it', () => {
    const page = renderErrorPage({ kind: 'crash', url: 'https://exemple.fr/', reason: 'oom', nonce: 'cr4sh' })
    expect(page.body).toContain('L’onglet a planté')
    expect(page.body).toContain('manqué de mémoire')
    expect(page.body).toContain(`href="${errorActionUrl('reload', 'cr4sh')}"`)
  })

  it('does not call a clean exit a crash', () => {
    expect(isCrash('clean-exit')).toBe(false)
    for (const reason of ['crashed', 'oom', 'killed', 'launch-failed', 'integrity-failure', 'abnormal-exit']) expect(isCrash(reason)).toBe(true)
    expect(describeCrash('something-new')).toMatch(/s’est arrêté/)
  })

  it('makes a complete document for the view that covers a dead page', () => {
    const html = errorPageDocument({ kind: 'crash', url: 'https://exemple.fr/', reason: 'crashed', nonce: 'n' })
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<body><main>')
  })
})

describe('the page of a tab that does not answer', () => {
  const hung = { kind: 'hung', url: 'https://exemple.fr/lourd', nonce: 'h4ng' } as const

  it('says the page does not answer, names the site, and offers to reload it or to wait', () => {
    const page = renderErrorPage(hung)
    expect(page.body).toContain('Cette page ne répond plus')
    expect(page.body).toContain('<strong>exemple.fr</strong> ne répond plus')
    expect(page.body).toContain('ce message disparaît de lui-même')
    expect(page.body).toContain('Recharger la page fait perdre')
    expect(page.body).toContain(`href="${errorActionUrl('reload', 'h4ng')}"`)
    expect(page.body).toContain(`href="${errorActionUrl('wait', 'h4ng')}"`)
    expect(page.title).toBe('exemple.fr')
  })

  it('is written in English too, with the same buttons', () => {
    setLanguage('en')
    try {
      const page = renderErrorPage(hung)
      expect(page.body).toContain('This page is not responding')
      expect(page.body).toContain('<strong>exemple.fr</strong> is not responding')
      expect(page.body).toContain('Wait')
      expect(page.body).not.toContain('ne répond')
      expect(page.body).toContain(errorActionUrl('reload', 'h4ng'))
      expect(page.body).toContain(errorActionUrl('wait', 'h4ng'))
    } finally {
      setLanguage('fr')
    }
  })

  it('makes a complete document for the view that covers the page', () => {
    expect(errorPageDocument(hung).startsWith('<!doctype html>')).toBe(true)
  })
})

describe('the buttons', () => {
  it('round-trips an action and its nonce', () => {
    expect(parseErrorAction(errorActionUrl('proceed', 'abc123'))).toEqual({ action: 'proceed', nonce: 'abc123' })
    expect(parseErrorAction(errorActionUrl('wait', 'abc123'))).toEqual({ action: 'wait', nonce: 'abc123' })
  })

  it('refuses anything that is not one of ours', () => {
    expect(parseErrorAction('https://exemple.fr/retry?n=abc')).toBeNull()
    expect(parseErrorAction('lucium-error:explode?n=abc')).toBeNull()
    expect(parseErrorAction('lucium-error:retry')).toBeNull()
    expect(parseErrorAction('lucium-error:retry?n=')).toBeNull()
  })
})

describe('certificate exceptions', () => {
  const session = {}

  it('trusts a certificate for the host it was accepted on, in the session it was accepted in', () => {
    const exceptions = new CertificateExceptions()
    expect(exceptions.isAllowed(session, 'auto-signe.test', 'sha256/AAAA')).toBe(false)
    exceptions.allow(session, 'auto-signe.test', 'sha256/AAAA')
    expect(exceptions.isAllowed(session, 'auto-signe.test', 'sha256/AAAA')).toBe(true)
    expect(exceptions.isAllowed(session, 'AUTO-SIGNE.test', 'sha256/AAAA')).toBe(true)
  })

  it('does not extend to another host, a subdomain or another certificate', () => {
    const exceptions = new CertificateExceptions()
    exceptions.allow(session, 'auto-signe.test', 'sha256/AAAA')
    expect(exceptions.isAllowed(session, 'autre.test', 'sha256/AAAA')).toBe(false)
    expect(exceptions.isAllowed(session, 'www.auto-signe.test', 'sha256/AAAA')).toBe(false)
    expect(exceptions.isAllowed(session, 'auto-signe.test', 'sha256/BBBB')).toBe(false)
  })

  it('does not reach another session: a private window starts without exceptions', () => {
    const exceptions = new CertificateExceptions()
    exceptions.allow(session, 'auto-signe.test', 'sha256/AAAA')
    expect(exceptions.isAllowed({}, 'auto-signe.test', 'sha256/AAAA')).toBe(false)
  })

  it('ignores an empty host or fingerprint instead of trusting everything', () => {
    const exceptions = new CertificateExceptions()
    exceptions.allow(session, '', 'sha256/AAAA')
    exceptions.allow(session, 'auto-signe.test', '')
    expect(exceptions.isAllowed(session, '', 'sha256/AAAA')).toBe(false)
    expect(exceptions.isAllowed(session, 'auto-signe.test', '')).toBe(false)
  })

  it('remembers the hosts whose page came over a certificate let through, per session and whatever the case', () => {
    const exceptions = new CertificateExceptions()
    expect(exceptions.isUntrusted(session, 'app.local')).toBe(false)
    exceptions.markUntrusted(session, 'App.Local')
    expect(exceptions.isUntrusted(session, 'app.local')).toBe(true)
    expect(exceptions.isUntrusted(session, 'api.app.local')).toBe(false)
    expect(exceptions.isUntrusted({}, 'app.local')).toBe(false)
    exceptions.markUntrusted(session, '')
    expect(exceptions.isUntrusted(session, '')).toBe(false)
  })

  it('keys by the host name without the port', () => {
    expect(exceptionHost('https://Auto-Signe.test:8443/x')).toBe('auto-signe.test')
    expect(exceptionHost('pas une adresse')).toBe('')
  })
})

describe('the local network', () => {
  it('knows the names and the addresses of the local network, and not the machine itself', () => {
    for (const host of ['homeassistant.local', 'NAS.LAN', 'box.home.arpa', '192.168.1.80', '10.0.0.5', '172.16.0.1', '172.31.255.1', '169.254.3.4', 'fe80::1', 'fd1f:6101:4d68::1', '[fd00::2]']) expect(isLocalNetworkHost(host), host).toBe(true)
    for (const host of ['example.com', 'localhost', '127.0.0.1', '::1', '172.32.0.1', '172.15.0.1', '8.8.8.8', 'locally.example', 'local.example.com']) expect(isLocalNetworkHost(host), host).toBe(false)
  })

  it('names the permission of macOS when a device of the local network cannot be reached, and only then', () => {
    expect(describeLoadError('ERR_ADDRESS_UNREACHABLE', 'x', true).hints[0]).toMatch(/Réseau local/)
    expect(describeLoadError('ERR_ADDRESS_UNREACHABLE', 'x', false).hints.join(' ')).not.toMatch(/Réseau local/)
    expect(describeLoadError('ERR_NAME_NOT_RESOLVED', 'x', true).hints.join(' ')).not.toMatch(/Réseau local/)
  })

  it('puts it in the page of a device of the local network, not in the page of a site of the Internet', () => {
    const page = (url: string) => renderErrorPage({ kind: 'load', url, name: 'ERR_ADDRESS_UNREACHABLE', nonce: 'n' }).body
    expect(page('https://homeassistant.local:8123/dashboard')).toMatch(/Réseau local/)
    expect(page('https://example.com/')).not.toMatch(/Réseau local/)
  })
})

describe('the button of the local network', () => {
  it('is an action the engine knows, and the address it opens is a constant', () => {
    expect(parseErrorAction(errorActionUrl('network-settings', 'n1'))).toEqual({ action: 'network-settings', nonce: 'n1' })
    expect(LOCAL_NETWORK_SETTINGS_URL).toBe('x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork')
  })

  it('is offered only for a device of the local network that macOS refuses', () => {
    expect(isLocalNetworkFailure('ERR_ADDRESS_UNREACHABLE', 'https://homeassistant.local:8123/x')).toBe(true)
    expect(isLocalNetworkFailure('ERR_ADDRESS_UNREACHABLE', 'https://example.com/')).toBe(false)
    expect(isLocalNetworkFailure('ERR_NAME_NOT_RESOLVED', 'https://homeassistant.local/')).toBe(false)
    const local = renderErrorPage({ kind: 'load', url: 'https://192.168.1.80:8123/', name: 'ERR_ADDRESS_UNREACHABLE', nonce: 'abc' }).body
    expect(local).toContain(`href="${errorActionUrl('network-settings', 'abc')}"`)
    expect(local).toContain(frenchSpaces('Ouvrir les réglages « Réseau local »'))
    const web = renderErrorPage({ kind: 'load', url: 'https://example.com/', name: 'ERR_ADDRESS_UNREACHABLE', nonce: 'abc' }).body
    expect(web).not.toContain('network-settings')
  })
})
