// The passkey probe: a page served on this machine alone (scripts/passkey-probe.mjs), to open in an installed Lucium, that says what the
// engine does with WebAuthn there: what it announces to a site, and how a request to create or to use a passkey ends for each kind of
// authenticator (this Mac, a security key, a telephone). No test of the repository can say it: the answer depends on the signature of the
// build and on the hardware (docs/cles-d-acces.md). The page talks to no server: the challenge is made in the page, nothing is verified,
// and the key it creates opens nothing. Its report is text the user copies.
//
// `probeRun` is sent to the page as TEXT (its `toString()`): it must stay self-contained, reading no name of this module at run time.

/** One request the probe made, as the report keeps it. */
export interface ProbeAttempt {
  /** Which button: `create-platform`, `create-roaming`, `create-any`, `get-created`, `get-any`. */
  what: string
  /** How long the request took to end, in milliseconds: a refusal within a few milliseconds is not the user's. */
  durationMs: number
  outcome: 'ok' | 'error'
  /** The name of the error (`NotAllowedError`, `NotSupportedError`, `SecurityError`…) and its message. */
  errorName?: string
  errorMessage?: string
  /** For a key that was created or used: where it lives (`platform`, `cross-platform`) and how it is reached (`internal`, `usb`, `hybrid`…). */
  attachment?: string | null
  transports?: string[]
}

export interface ProbeReport {
  userAgent: string
  origin: string
  secureContext: boolean
  /** What the engine announces before any request; a string holds the error of a call that failed. */
  capabilities: Record<string, unknown>
  attempts: ProbeAttempt[]
}

/** How long a request may last before the engine gives up, as the page asks: long enough to touch a key, short enough to see a request nobody answers. */
export const PROBE_TIMEOUT_MS = 60_000

type Dom = any

/**
 * Runs in the page. Reads the capabilities at once, and gives `win.probe(what)` to the buttons: one request, timed, added to the report,
 * which `render` is given after each change. Returns the report (the same object throughout).
 */
export function probeRun(win: Dom, timeoutMs: number, render: (report: ProbeReport) => void): ProbeReport {
  const nav = win.navigator
  const report: ProbeReport = { userAgent: String(nav.userAgent), origin: String(win.location.origin), secureContext: win.isSecureContext === true, capabilities: {}, attempts: [] }
  const created: ArrayBuffer[] = []
  const random = (length: number): Uint8Array => win.crypto.getRandomValues(new Uint8Array(length))
  const said = (error: unknown): string => {
    const e = error as { name?: unknown; message?: unknown } | null
    return `${String(e?.name ?? 'Error')}: ${String(e?.message ?? error)}`
  }
  const PKC = win.PublicKeyCredential
  report.capabilities['PublicKeyCredential'] = typeof PKC === 'function'
  report.capabilities['navigator.credentials'] = typeof nav.credentials?.create === 'function' && typeof nav.credentials?.get === 'function'
  const announce = (name: string, call: (() => Promise<unknown>) | undefined): void => {
    if (!call) {
      report.capabilities[name] = 'absent'
      return
    }
    report.capabilities[name] = 'pending'
    void Promise.resolve()
      .then(call)
      .then(
        (value) => (report.capabilities[name] = value),
        (error: unknown) => (report.capabilities[name] = said(error))
      )
      .then(() => render(report))
  }
  if (typeof PKC === 'function') {
    announce('isUserVerifyingPlatformAuthenticatorAvailable', typeof PKC.isUserVerifyingPlatformAuthenticatorAvailable === 'function' ? () => PKC.isUserVerifyingPlatformAuthenticatorAvailable() : undefined)
    announce('isConditionalMediationAvailable', typeof PKC.isConditionalMediationAvailable === 'function' ? () => PKC.isConditionalMediationAvailable() : undefined)
    announce('getClientCapabilities', typeof PKC.getClientCapabilities === 'function' ? () => PKC.getClientCapabilities() : undefined)
  }
  const creation = (attachment: string | undefined): unknown => ({
    publicKey: {
      challenge: random(32),
      rp: { name: 'Sonde Lucium' },
      user: { id: random(16), name: 'sonde@lucium.invalid', displayName: 'Sonde' },
      // ES256 and RS256: what every authenticator has.
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { ...(attachment ? { authenticatorAttachment: attachment } : {}), residentKey: 'preferred', userVerification: 'preferred' },
      timeout: timeoutMs,
      attestation: 'none'
    }
  })
  const request = (known: boolean): unknown => ({
    publicKey: { challenge: random(32), timeout: timeoutMs, userVerification: 'preferred', ...(known ? { allowCredentials: created.map((id) => ({ type: 'public-key', id })) } : {}) }
  })
  const requests: Record<string, () => Promise<Dom>> = {
    'create-platform': () => nav.credentials.create(creation('platform')),
    'create-roaming': () => nav.credentials.create(creation('cross-platform')),
    'create-any': () => nav.credentials.create(creation(undefined)),
    'get-created': () => nav.credentials.get(request(true)),
    'get-any': () => nav.credentials.get(request(false))
  }
  win.probe = (what: string): Promise<void> => {
    const run = requests[what]
    if (!run) return Promise.resolve()
    const began = win.performance.now()
    const ended = (attempt: Omit<ProbeAttempt, 'what' | 'durationMs'>): void => {
      report.attempts.push({ what, durationMs: Math.round(win.performance.now() - began), ...attempt })
      render(report)
    }
    return Promise.resolve()
      .then(run)
      .then(
        (credential) => {
          if (credential?.rawId && what.startsWith('create')) created.push(credential.rawId)
          const transports: unknown = typeof credential?.response?.getTransports === 'function' ? credential.response.getTransports() : undefined
          ended({ outcome: 'ok', attachment: credential?.authenticatorAttachment ?? null, ...(Array.isArray(transports) ? { transports: transports.map(String) } : {}) })
        },
        (error: unknown) => {
          const e = error as { name?: unknown; message?: unknown } | null
          ended({ outcome: 'error', errorName: String(e?.name ?? 'Error'), errorMessage: String(e?.message ?? error) })
        }
      )
  }
  render(report)
  return report
}

/** The page of the probe: French, no resource of its own to fetch, and a policy that lets it reach nothing. */
export function probePage(): string {
  const button = (what: string, label: string): string => `<button type="button" data-what="${what}">${label}</button>`
  return `<!doctype html>
<html lang="fr">
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
<title>Sonde des clés d’accès</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 46rem; margin: 2rem auto; padding: 0 1rem; }
  button { font: inherit; margin: 0 .5rem .5rem 0; padding: .4rem .8rem; }
  pre { white-space: pre-wrap; word-break: break-word; border: 1px solid; padding: 1rem; }
</style>
<h1>Sonde des clés d’accès (WebAuthn)</h1>
<p>Cette page ne parle à aucun serveur. Les clés qu’elle crée n’ouvrent aucun compte : vous pouvez les supprimer ensuite (Réglages Système › Mots de passe, ou l’outil de votre clé de sécurité).</p>
<p>Cliquez chaque bouton l’un après l’autre, en attendant la fin de chaque demande (${Math.round(PROBE_TIMEOUT_MS / 1000)} s au plus). Notez à part ce que vous voyez à l’écran : une fenêtre de Touch ID, un code QR, une liste, ou rien. Puis copiez le rapport.</p>
<p>
  ${button('create-platform', '1. Créer une clé sur ce Mac')}
  ${button('create-roaming', '2. Créer une clé sur une clé de sécurité ou un téléphone')}
  ${button('create-any', '3. Créer une clé, au choix')}
  ${button('get-created', '4. Se connecter avec une clé créée ici')}
  ${button('get-any', '5. Se connecter avec une clé au choix')}
</p>
<p><button type="button" id="copy">Copier le rapport</button> <span id="copied" role="status"></span></p>
<pre id="report" aria-live="polite"></pre>
<script>
(${probeRun.toString()})(window, ${PROBE_TIMEOUT_MS}, (report) => { document.getElementById('report').textContent = JSON.stringify(report, null, 2) })
for (const button of document.querySelectorAll('button[data-what]')) button.addEventListener('click', () => { button.disabled = true; window.probe(button.dataset.what).then(() => { button.disabled = false }) })
document.getElementById('copy').addEventListener('click', () => {
  const said = document.getElementById('copied')
  navigator.clipboard.writeText(document.getElementById('report').textContent).then(() => { said.textContent = 'Copié.' }, (error) => { said.textContent = 'La copie a échoué (' + error.name + ') : sélectionnez le texte.' })
})
</script>
</html>
`
}

export interface ProbeResponse {
  status: number
  headers: Record<string, string>
  body: string
}

/**
 * What the server of the probe answers. Only the page itself, only to a request that names this machine: WebAuthn needs a secure context,
 * which `http://localhost` is, and the name the page is served under is the one the keys are created for (`localhost`).
 */
export function probeResponse(method: string | undefined, url: string | undefined, host: string | undefined, port: number): ProbeResponse {
  const text = (status: number, body: string): ProbeResponse => ({ status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, body })
  if (host !== `localhost:${port}`) return text(421, `Ouvrez http://localhost:${port}/ : la sonde ne répond que sous ce nom.\n`)
  if (method !== 'GET') return text(405, 'GET seulement.\n')
  if (url !== '/') return text(404, 'Rien ici.\n')
  return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }, body: probePage() }
}
