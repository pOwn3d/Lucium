import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHAIN, SUITES } from './smoke-suites'
import { ECH_PAGE, FORM_VALUE, MEDIA_ACTIONS, PHONE, deviceVerdict, echVerdict, featuresOf, formPdf, holdsFieldValue, mediaScript, mediaVerdict, parallelVerdict, pdfFormVerdict, silentWav, webGpuScript, webGpuVerdict } from './smoke-engine-facts-kit'

// The verdicts of the suite `engine-facts`, which no one has run yet: what each would say for each thing the engine can do, so that the day it runs,
// a green or a red check means what its detail says. Electron is never reached.

const readyMedia = { hasSession: true, metadata: true, accepted: [...MEDIA_ACTIONS], refused: [], playing: 'playing', playbackState: 'playing' }

describe('the media keys', () => {
  it('reads the features a launch switches off', () => {
    expect(featuresOf('A, ,B,HardwareMediaKeyHandling')).toEqual(['A', 'B', 'HardwareMediaKeyHandling'])
    expect(featuresOf('')).toEqual([])
  })

  it('says the page side is ready only with a session, a title, the four handlers and no feature of the keys switched off', () => {
    expect(mediaVerdict(readyMedia, []).state).toBe('page-side-ready')
    expect(mediaVerdict(readyMedia, ['Other']).state).toBe('page-side-ready')
    expect(mediaVerdict(readyMedia, ['GlobalMediaControls'])).toMatchObject({ ok: true, state: 'keys-switched-off' })
    expect(mediaVerdict({ ...readyMedia, accepted: ['play', 'pause'] }, []).state).toBe('session-incomplete')
    expect(mediaVerdict({ ...readyMedia, metadata: false }, []).state).toBe('session-incomplete')
    expect(mediaVerdict({ ...readyMedia, hasSession: false }, []).state).toBe('no-session')
  })

  it('is a failed check, not a finding, when the page did not answer', () => {
    for (const answer of [undefined, null, 'boom', [], {}]) expect(mediaVerdict(answer, [])).toMatchObject({ ok: false, state: 'unreadable' })
  })

  it('asks the page for the four handlers and plays a real silent element', () => {
    for (const action of MEDIA_ACTIONS) expect(mediaScript()).toContain(`"${action}"`)
    expect(mediaScript()).toContain('new Audio(')
    const wav = Buffer.from(silentWav(1).split(',')[1] ?? '', 'base64')
    expect(wav.subarray(0, 4).toString()).toBe('RIFF')
    expect(wav.subarray(8, 12).toString()).toBe('WAVE')
    expect(wav.length).toBe(44 + 8000)
  })
})

describe('WebGPU', () => {
  const adapter = { vendor: 'apple', architecture: 'metal-3', description: 'Apple M3', fallback: false }

  it('tells the object, the adapter, the software adapter and the device apart', () => {
    expect(webGpuVerdict({ gpu: false, adapter: null, device: 'not tried', features: null })).toMatchObject({ ok: true, state: 'absent' })
    expect(webGpuVerdict({ gpu: true, adapter: 'none', device: 'not tried', features: null }).state).toBe('no-adapter')
    expect(webGpuVerdict({ gpu: true, adapter, device: 'ok', features: 12 })).toMatchObject({ ok: true, state: 'hardware-device' })
    expect(webGpuVerdict({ gpu: true, adapter: { ...adapter, fallback: true }, device: 'ok', features: 3 }).state).toBe('software-device')
    expect(webGpuVerdict({ gpu: true, adapter, device: 'error: OperationError: no', features: 3 }).state).toBe('adapter-without-device')
    expect(webGpuVerdict({ gpu: true, adapter, device: 'ok', features: 12 }).detail).toContain('Apple M3')
  })

  it('fails the check when requestAdapter threw or the answer is not the shape of the script', () => {
    expect(webGpuVerdict({ gpu: true, adapter: 'error: TypeError: x', device: 'not tried', features: null })).toMatchObject({ ok: false, state: 'unreadable' })
    for (const answer of [undefined, 'x', { adapter: 'none' }]) expect(webGpuVerdict(answer).ok).toBe(false)
    expect(webGpuScript()).toContain('requestAdapter()')
  })
})

describe('the device mode', () => {
  const desk = { width: 1200, height: 800, dpr: 2, touchPoints: 0, coarse: false, hoverNone: false, mobileUa: false }
  const phone = { width: PHONE.width, height: PHONE.height, dpr: PHONE.scaleFactor, touchPoints: 5, coarse: true, hoverNone: true, mobileUa: false }

  it('says the size followed and came back, and reports touch and pointer', () => {
    expect(deviceVerdict(desk, phone, desk)).toMatchObject({ ok: true, state: 'size-followed-touch-coarse' })
    expect(deviceVerdict(desk, { ...phone, touchPoints: 0, coarse: false }, desk).state).toBe('size-followed-no-touch-fine')
  })

  it('says when the page did not follow, or did not come back', () => {
    expect(deviceVerdict(desk, desk, desk).state).toBe('size-not-followed')
    expect(deviceVerdict(desk, phone, phone).state).toBe('not-restored')
  })

  it('fails the check on an answer that is not a reading', () => {
    expect(deviceVerdict(desk, undefined, desk)).toMatchObject({ ok: false, state: 'unreadable' })
    expect(deviceVerdict(desk, { width: 'x' }, desk).ok).toBe(false)
  })
})

describe('a PDF form', () => {
  it('builds a PDF with one text field and a valid cross-reference table', () => {
    const text = formPdf().toString('latin1')
    expect(text).toContain('/AcroForm')
    expect(text).toContain('/FT /Tx')
    const xref = Number(/startxref\n(\d+)/.exec(text)?.[1])
    expect(text.slice(xref, xref + 4)).toBe('xref')
    const offsets = Array.from(text.matchAll(/(\d{10}) 00000 n /g), (match) => Number(match[1]))
    expect(offsets).toHaveLength(6)
    offsets.forEach((offset, i) => expect(text.slice(offset, offset + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`))
    expect(holdsFieldValue(formPdf(), FORM_VALUE)).toBe(false)
  })

  it('finds a typed value as a string or as UTF-16 hexadecimal, and nothing else', () => {
    expect(holdsFieldValue(Buffer.from('5 0 obj << /FT /Tx /V (Lucium) >>', 'latin1'), 'Lucium')).toBe(true)
    expect(holdsFieldValue(Buffer.from('<< /V<FEFF004C0075006300690075006D> >>', 'latin1'), 'Lucium')).toBe(true)
    expect(holdsFieldValue(Buffer.from('<< /T (Lucium) >>', 'latin1'), 'Lucium')).toBe(false)
    expect(holdsFieldValue(Buffer.from('<< /V (Lucium2) >>', 'latin1'), 'Lucium')).toBe(false)
    expect(holdsFieldValue(Buffer.from('<< /V (a.b) >>', 'latin1'), 'a+b')).toBe(false)
  })

  it('judges the saved file, and fails when there is no viewer or no file', () => {
    expect(pdfFormVerdict({ viewer: true, saved: Buffer.from('/V (Lucium)') })).toMatchObject({ ok: true, state: 'value-kept' })
    expect(pdfFormVerdict({ viewer: true, saved: formPdf() })).toMatchObject({ ok: true, state: 'value-not-found' })
    expect(pdfFormVerdict({ viewer: true, saved: null })).toMatchObject({ ok: false, state: 'no-file' })
    expect(pdfFormVerdict({ viewer: false, saved: formPdf() })).toMatchObject({ ok: false, state: 'no-viewer' })
  })
})

describe('Encrypted Client Hello', () => {
  it('reads the line sni= of the trace page', () => {
    expect(echVerdict('fl=1\nsni=encrypted\ntls=TLSv1.3\nhttp=http/2\n')).toEqual({ ok: true, state: 'encrypted', detail: 'sni=encrypted, tls=TLSv1.3, http=http/2' })
    expect(echVerdict('sni=plaintext\n')).toMatchObject({ ok: true, state: 'plaintext' })
    expect(echVerdict('sni=odd\n').state).toBe('other')
  })

  it('fails the check when the page is not the trace page', () => {
    expect(echVerdict('<html>blocked</html>')).toMatchObject({ ok: false, state: 'unreadable' })
    expect(echVerdict(undefined).ok).toBe(false)
    expect(ECH_PAGE).toMatch(/^https:\/\//)
  })
})

describe('parallel downloads', () => {
  it('says parallel when several streams were open or several starts were asked for', () => {
    expect(parallelVerdict({ ranges: ['bytes=0-', 'bytes=6000000-'], mostOpen: 2 }, false)).toMatchObject({ ok: true, state: 'parallel' })
    expect(parallelVerdict({ ranges: [undefined, 'bytes=100-'], mostOpen: 1 }, false).state).toBe('parallel')
    expect(parallelVerdict({ ranges: ['bytes=0-'], mostOpen: 2 }, false).state).toBe('parallel')
  })

  it('says single stream for one request, whole or from the first byte', () => {
    expect(parallelVerdict({ ranges: [undefined], mostOpen: 1 }, false).state).toBe('single-stream')
    expect(parallelVerdict({ ranges: ['bytes=0-'], mostOpen: 1 }, false).state).toBe('single-stream')
  })

  it('does not measure when the launch switched the feature off, and fails when the server saw nothing', () => {
    expect(parallelVerdict({ ranges: ['bytes=0-', 'bytes=9-'], mostOpen: 2 }, true).state).toBe('not-measured')
    expect(parallelVerdict({ ranges: [], mostOpen: 0 }, false)).toMatchObject({ ok: false, state: 'unreadable' })
  })
})

describe('the place of the suite in the table', () => {
  it('is loaded from its own file, outside the chain, with the reason and the way to run it', () => {
    const entry = SUITES.find((suite) => suite.name === 'engine-facts')
    expect(entry?.chain).toBe(false)
    expect(entry?.driver).toBeUndefined()
    expect(entry?.what).toMatch(/media keys.*WebGPU.*device mode.*PDF form.*Encrypted Client Hello.*parallel downloads/)
    expect(entry?.order).toMatch(/LUCIUM_SMOKE_ONLY=engine-facts/)
    expect(readFileSync(join(__dirname, 'smoke-suites.ts'), 'utf8')).toContain(`run: async (context) => (await import('./smoke-engine-facts')).runEngineFactsSmoke(context)`)
    expect(CHAIN.map((suite) => suite.name)).not.toContain('engine-facts')
  })
})
