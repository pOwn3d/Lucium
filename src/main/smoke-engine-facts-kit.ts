// What the engine suite `engine-facts` (smoke-engine-facts.ts) decides with, apart from Electron: the scripts it runs in a page, and how each
// answer becomes a verdict in words. Six « à confirmer » of the list of missing functions are measured there (the media keys, WebGPU, the device
// mode, a PDF form, Encrypted Client Hello, parallel downloads); none had been run, and docs/limites-web.md says « non mesuré » until someone has.
// A verdict is `ok` when the measure could be made, whatever it found: the finding is in `state` and in the detail, which is what the document
// quotes. A page that did not answer, or an answer that is not the shape the script gives, is `unreadable` and a failed check, never a finding.
// No Electron here: only the suite imports this file, so it lands in a smoke*.js chunk that the package leaves out; the unit tests run it.

/** What a measure found, in a word the document can quote, and the words for the detail of the check. */
export interface FactVerdict {
  /** False only when the measure could not be made (no answer, a shape the script never gives). */
  ok: boolean
  state: string
  detail: string
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const unreadable = (what: string, answer: unknown): FactVerdict => ({ ok: false, state: 'unreadable', detail: `${what}: not an answer of the script: ${String(JSON.stringify(answer)).slice(0, 160)}` })

// ---------------------------------------------------------------- 19. the media keys ----------------------------------------------------------------

/** The Chromium features that carry the media keys and the « Lecture en cours » entry of the Control Center. Their names are those of the installed binary. */
export const MEDIA_KEY_FEATURES = ['HardwareMediaKeyHandling', 'MediaSessionService', 'GlobalMediaControls'] as const

/** The names in a `--disable-features=` value (the list Chromium reads), without the empty ones. */
export const featuresOf = (value: string): string[] => value.split(',').map((name) => name.trim()).filter((name) => name !== '')

/** The actions of a media session that a media key or the Control Center sends to the page. */
export const MEDIA_ACTIONS = ['play', 'pause', 'previoustrack', 'nexttrack'] as const

/** A silent WAV (8 bit, mono, 8 kHz) of `seconds`, as a `data:` address: a real media element to play, with no sound and no file. */
export function silentWav(seconds = 2): string {
  const samples = 8000 * seconds
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + samples, 4)
  header.write('WAVEfmt ', 8, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(8000, 24)
  header.writeUInt32LE(8000, 28)
  header.writeUInt16LE(1, 32)
  header.writeUInt16LE(8, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(samples, 40)
  return `data:audio/wav;base64,${Buffer.concat([header, Buffer.alloc(samples, 128)]).toString('base64')}`
}

/**
 * The page's side of the media keys: is there a media session, does it take a title and the four handlers, and does it follow a real element
 * that plays. The element is silent; it is stopped before the answer.
 */
export const mediaScript = (): string => `(async () => {
  const out = { hasSession: 'mediaSession' in navigator, metadata: false, accepted: [], refused: [], playing: 'not tried', playbackState: null }
  if (!out.hasSession) return out
  try { navigator.mediaSession.metadata = new MediaMetadata({ title: 'Lucium engine test', artist: 'Lucium' }); out.metadata = !!navigator.mediaSession.metadata && navigator.mediaSession.metadata.title === 'Lucium engine test' } catch (e) { out.metadata = false }
  for (const action of ${JSON.stringify(MEDIA_ACTIONS)}) { try { navigator.mediaSession.setActionHandler(action, () => {}); out.accepted.push(action) } catch (e) { out.refused.push(action) } }
  try { const audio = new Audio(${JSON.stringify(silentWav())}); await audio.play(); out.playing = 'playing'; out.playbackState = navigator.mediaSession.playbackState; audio.pause() } catch (e) { out.playing = 'refused: ' + (e && e.name) }
  return out
})()`

/**
 * What the page said of its media session, with the features the launch switched off. The keys and the Control Center need the three features
 * on and a session the page fills; this says whether the page's side is there. That a key acts, and that the Control Center shows the page, is
 * for a person to look at: the suite records it as skipped.
 */
export function mediaVerdict(answer: unknown, disabledFeatures: readonly string[]): FactVerdict {
  if (!isRecord(answer) || typeof answer['hasSession'] !== 'boolean') return unreadable('media session', answer)
  const accepted = Array.isArray(answer['accepted']) ? answer['accepted'].filter((a): a is string => typeof a === 'string') : []
  const off = MEDIA_KEY_FEATURES.filter((name) => disabledFeatures.includes(name))
  const missing = MEDIA_ACTIONS.filter((action) => !accepted.includes(action))
  const facts = `session ${answer['hasSession']}, title kept ${answer['metadata']}, handlers accepted [${accepted.join(', ')}], playing ${String(answer['playing'])}, playbackState ${String(answer['playbackState'])}, features switched off [${off.join(', ')}]`
  if (!answer['hasSession']) return { ok: true, state: 'no-session', detail: facts }
  if (off.length > 0) return { ok: true, state: 'keys-switched-off', detail: facts }
  if (answer['metadata'] !== true || missing.length > 0) return { ok: true, state: 'session-incomplete', detail: `${facts}; refused [${missing.join(', ')}]` }
  return { ok: true, state: 'page-side-ready', detail: facts }
}

// ---------------------------------------------------------------- 94. WebGPU ----------------------------------------------------------------

/** What the page can reach of WebGPU: the object, an adapter (and whether it is the software one), a device. Asked in a secure context (127.0.0.1 is one). */
export const webGpuScript = (): string => `(async () => {
  const out = { gpu: 'gpu' in navigator, adapter: null, device: 'not tried', features: null }
  if (!out.gpu) return out
  try {
    const adapter = await navigator.gpu.requestAdapter()
    if (!adapter) { out.adapter = 'none'; return out }
    const info = adapter.info || {}
    out.adapter = { vendor: String(info.vendor || ''), architecture: String(info.architecture || ''), description: String(info.description || ''), fallback: adapter.isFallbackAdapter === true }
    out.features = [...adapter.features].length
    try { const device = await adapter.requestDevice(); out.device = 'ok'; device.destroy() } catch (e) { out.device = 'error: ' + (e && e.name) + ': ' + (e && e.message) }
  } catch (e) { out.adapter = 'error: ' + (e && e.name) + ': ' + (e && e.message) }
  return out
})()`

export function webGpuVerdict(answer: unknown): FactVerdict {
  if (!isRecord(answer) || typeof answer['gpu'] !== 'boolean') return unreadable('WebGPU', answer)
  if (!answer['gpu']) return { ok: true, state: 'absent', detail: 'navigator.gpu does not exist in a page of this engine' }
  const adapter = answer['adapter']
  if (adapter === 'none') return { ok: true, state: 'no-adapter', detail: 'navigator.gpu exists, requestAdapter() answered null' }
  if (!isRecord(adapter)) return { ok: false, state: 'unreadable', detail: `requestAdapter() failed: ${String(adapter).slice(0, 160)}` }
  const named = `adapter ${String(adapter['vendor'])} ${String(adapter['architecture'])} ${String(adapter['description'])}`.replace(/ +/g, ' ').trim()
  const device = String(answer['device'])
  if (device !== 'ok') return { ok: true, state: 'adapter-without-device', detail: `${named}; requestDevice(): ${device.slice(0, 160)}` }
  return { ok: true, state: adapter['fallback'] === true ? 'software-device' : 'hardware-device', detail: `${named}; fallback ${String(adapter['fallback'])}; ${String(answer['features'])} feature(s); a device was made` }
}

// ---------------------------------------------------------------- 78. the device mode ----------------------------------------------------------------

/** What a page reads of the screen and of the pointer: the size, the density, the touch points, the pointer kind and the identity. */
export const deviceReadScript = (): string => `({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, touchPoints: navigator.maxTouchPoints, coarse: matchMedia('(pointer: coarse)').matches, hoverNone: matchMedia('(hover: none)').matches, mobileUa: /Mobile/.test(navigator.userAgent) })`

/** The phone the engine is asked to be (an iPhone 14 in CSS pixels): `webContents.enableDeviceEmulation`. */
export const PHONE = { width: 390, height: 844, scaleFactor: 3 } as const

/**
 * Three readings of one tab: as it is, with the emulation of a phone on, and after the emulation is switched off. The emulation works when the
 * page's size and density follow the request and come back; touch, pointer kind and identity are reported, not judged (the function that would
 * build on them is for the person to decide on).
 */
export function deviceVerdict(before: unknown, during: unknown, after: unknown): FactVerdict {
  const numbers = (value: unknown): value is { width: number; height: number; dpr: number; touchPoints: number; coarse: boolean; hoverNone: boolean; mobileUa: boolean } => isRecord(value) && ['width', 'height', 'dpr', 'touchPoints'].every((key) => typeof value[key] === 'number')
  if (!numbers(before) || !numbers(during) || !numbers(after)) return unreadable('device mode', [before, during, after])
  const followed = during.width === PHONE.width && during.dpr === PHONE.scaleFactor
  const back = after.width === before.width && after.dpr === before.dpr
  const touch = during.touchPoints > 0 ? 'touch' : 'no-touch'
  const pointer = during.coarse ? 'coarse' : 'fine'
  const facts = `before ${before.width}x${before.height}@${before.dpr}, emulated ${during.width}x${during.height}@${during.dpr} (${touch}, pointer ${pointer}, hover none ${during.hoverNone}, mobile identity ${during.mobileUa}), after ${after.width}x${after.height}@${after.dpr}`
  if (!followed) return { ok: true, state: 'size-not-followed', detail: facts }
  if (!back) return { ok: true, state: 'not-restored', detail: facts }
  return { ok: true, state: `size-followed-${touch}-${pointer}`, detail: facts }
}

// ---------------------------------------------------------------- 69. a PDF form ----------------------------------------------------------------

/** What the check types into the field. */
export const FORM_VALUE = 'Lucium'

/**
 * A one-page PDF (300 × 200) whose single text field fills the sheet (a click anywhere near the middle lands in it, at any zoom), with a valid
 * cross-reference table. No value in it: what the saved file holds is what was typed.
 */
export function formPdf(): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R] /DA (/Helv 14 Tf 0 g) /DR << /Font << /Helv 6 0 R >> >> /NeedAppearances true >> >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /Helv 6 0 R >> >> /Annots [5 0 R] >>',
    '<< /Length 0 >>\nstream\n\nendstream',
    '<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /Rect [10 10 290 190] /F 4 /P 3 0 R /DA (/Helv 14 Tf 0 g) /MK << /BC [0 0 0] >> >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

/** Whether a PDF holds `value` as the value of a field: written as a text string `(…)` or as UTF-16 hexadecimal `<FEFF…>`, after `/V`. */
export function holdsFieldValue(pdf: Buffer, value: string): boolean {
  const text = pdf.toString('latin1')
  const hex = Buffer.from(`﻿${value}`, 'utf16le').swap16().toString('hex')
  return new RegExp(`/V\\s*\\(${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`).test(text) || new RegExp(`/V\\s*<${hex}>`, 'i').test(text)
}

/** The typed text in the saved file: kept, not found (the typing may have missed the field: the detail says what else was seen), or no file. */
export function pdfFormVerdict(seen: { viewer: boolean; saved: Buffer | null }, value: string = FORM_VALUE): FactVerdict {
  if (!seen.viewer) return { ok: false, state: 'no-viewer', detail: 'the PDF did not open in the viewer of Chromium, so nothing could be typed' }
  if (seen.saved === null) return { ok: false, state: 'no-file', detail: 'the viewer saved no file in 15 s' }
  const kept = holdsFieldValue(seen.saved, value)
  return { ok: true, state: kept ? 'value-kept' : 'value-not-found', detail: `the saved file (${seen.saved.length} bytes) ${kept ? 'holds' : 'does not hold'} "${value}" as the value of a field` }
}

// ---------------------------------------------------------------- 39. Encrypted Client Hello ----------------------------------------------------------------

/** A page of a service that says how the TLS connection of the request was made (one line `sni=encrypted` when the server name travelled encrypted). */
export const ECH_PAGE = 'https://crypto.cloudflare.com/cdn-cgi/trace'

/** What the trace page says of the connection: `sni=encrypted` is Encrypted Client Hello at work, `sni=plaintext` is not. */
export function echVerdict(text: unknown): FactVerdict {
  if (typeof text !== 'string') return unreadable('Encrypted Client Hello', text)
  const line = (name: string): string | null => new RegExp(`^${name}=(.*)$`, 'm').exec(text)?.[1]?.trim() ?? null
  const sni = line('sni')
  if (sni === null) return { ok: false, state: 'unreadable', detail: `no sni= line in the page: "${text.slice(0, 120).replace(/\s+/g, ' ')}"` }
  const state = sni === 'encrypted' ? 'encrypted' : sni === 'plaintext' ? 'plaintext' : 'other'
  return { ok: true, state, detail: `sni=${sni}, tls=${line('tls') ?? '?'}, http=${line('http') ?? '?'}` }
}

// ---------------------------------------------------------------- 73. parallel downloads ----------------------------------------------------------------

/** What the server of the suite saw of one file: each request's `Range`, and the most streams of the file that were open at once. */
export interface DownloadSeen {
  ranges: ReadonlyArray<string | undefined>
  mostOpen: number
}

/** Whether Chromium fetched the file in parts (several streams at once, or several different starts), or in one stream. */
export function parallelVerdict(seen: DownloadSeen, singleStream: boolean): FactVerdict {
  if (singleStream) return { ok: true, state: 'not-measured', detail: 'this launch downloads in a single stream on purpose (the resumption of downloads is on): ParallelDownloading is switched off' }
  const starts = new Set(seen.ranges.map((range) => /^bytes=(\d+)-/.exec(range ?? '')?.[1] ?? 'whole'))
  const facts = `${seen.ranges.length} request(s), ${starts.size} different start(s) [${[...starts].join(', ')}], most streams open at once ${seen.mostOpen}`
  if (seen.ranges.length === 0) return { ok: false, state: 'unreadable', detail: 'the server saw no request' }
  return { ok: true, state: seen.mostOpen > 1 || starts.size > 1 ? 'parallel' : 'single-stream', detail: facts }
}
