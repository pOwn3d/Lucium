// Engine checks of the veil measured from a file of the user's (shared/auto-veil.ts, renderer/background-probe.ts), in a real Electron: what the unit
// tests cannot do is decode a picture or a video in Chromium, seek it and read its pixels on a canvas. Personnaliser l'espace is opened on a space of
// its own; files are given to its media panel the way the file dialog would (the input's files, then its change event): a bright picture, a dark one,
// a real H.264 video (the smallest video of Lucium, sent as a file of the user's) and that video cut in its index, which cannot decode. Then the slider
// takes the measured look away, and « Revenir au réglage automatique » brings it back, from the keyboard and with a real click. No fixed wait: every
// effect is waited for. `LUCIUM_SMOKE_ONLY=auto-veil` runs only this file.

import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import { t } from '@shared/i18n'
import { AUTO_VEIL_FALLBACK, MEASURE_TIMEOUT_MS } from '@shared/auto-veil'
import { builtinVideoFile } from '@shared/builtin-backgrounds'
import type { SpaceBackground } from '@shared/space-media'
import type { SmokeContext } from './smoke'
import { noteCheck, waiterOf } from './smoke-kit'
import { isBuiltApp } from './runtime'

type Check = (name: string, ok: boolean, detail?: string) => void

interface Box {
  x: number
  y: number
  w: number
  h: number
}

const waitFor = waiterOf(6000, 50)

/** A picture drawn in the panel's page, as PNG bytes: a ground of one colour and a few stripes of another (a picture is not of one colour). */
const pictureScript = (ground: string, stripes: string) => `(async () => {
  const canvas = document.createElement('canvas')
  canvas.width = 400
  canvas.height = 700
  const g = canvas.getContext('2d')
  g.fillStyle = ${JSON.stringify(ground)}
  g.fillRect(0, 0, 400, 700)
  g.fillStyle = ${JSON.stringify(stripes)}
  for (let y = 40; y < 700; y += 120) g.fillRect(0, y, 400, 24)
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
  return new File([blob], 'fond.png', { type: 'image/png' })
})()`

/** Bytes from the main process as a file of the panel's page. */
const bytesScript = (bytes: Buffer, mimeType: string, name: string) => `(async () => {
  const bytes = Uint8Array.from(atob(${JSON.stringify(bytes.toString('base64'))}), (c) => c.charCodeAt(0))
  return new File([bytes], ${JSON.stringify(name)}, { type: ${JSON.stringify(mimeType)} })
})()`

export async function smokeAutoVeil(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, win, overlayView } = ctx
  const chrome = win.webContents
  const ui = overlayView.webContents
  const state = () => store.get()

  const evaluate = <T>(from: WebContents, script: string) =>
    (from.executeJavaScript(script) as Promise<T>).catch((error: unknown) => {
      throw new Error(`${String(error)} -- in: ${script.replace(/\s+/g, ' ').slice(0, 200)}`)
    })
  const rect = (selector: string) =>
    evaluate<Box | null>(ui, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()`)
  const textOf = (from: WebContents, selector: string) => evaluate<string>(from, `document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`)
  const key = (keyCode: string) => {
    ui.sendInputEvent({ type: 'keyDown', keyCode })
    ui.sendInputEvent({ type: 'keyUp', keyCode })
  }
  /** Return as a person types it: a button acts on the character the key gives (Blink clicks it on the key press), never on a key that only goes down and up. */
  const pressReturn = () => {
    ui.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
    ui.sendInputEvent({ type: 'char', keyCode: '\r' })
    ui.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
  }
  /** A real click in the middle of the element. */
  const click = async (selector: string): Promise<boolean> => {
    const box = await rect(selector)
    if (!box) return false
    const [x, y] = [Math.round(box.x + box.w / 2), Math.round(box.y + box.h / 2)]
    ui.sendInputEvent({ type: 'mouseMove', x, y })
    ui.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    ui.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    return true
  }

  const previousSpace = state().activeSpaceId
  browser.dispatch({ type: 'space/create', name: 'Voile automatique', emoji: '🌗', hue: 40 })
  const spaceId = state().activeSpaceId
  const background = (): SpaceBackground | undefined => state().spaces.find((space) => space.id === spaceId)?.background
  const shown = JSON.stringify

  const INPUT = '.sc-edit .space-media-panel input[type="file"]'
  const STATUS = '.sc-edit .space-veil-auto [role="status"]'
  const RESTORE = '.sc-edit .space-veil-auto button'
  const SLIDER = '.sc-edit input[type="range"]'

  /**
   * Gives the panel the file the script makes, as the file dialog would; waits for the space to have a new file. Answers how long it took, from the
   * change of the input to the background written (the upload, the reading back and the measure).
   */
  const addFile = async (fileScript: string): Promise<number | null> => {
    const before = background()?.value
    await waitFor(async () => (await evaluate<boolean>(ui, `!!document.querySelector(${JSON.stringify(INPUT)}) && !document.querySelector(${JSON.stringify(INPUT)}).disabled`)))
    const started = Date.now()
    const given = await evaluate<boolean>(
      ui,
      `(async () => {
        const input = document.querySelector(${JSON.stringify(INPUT)})
        if (!input) return false
        const file = await ${fileScript}
        const list = new DataTransfer()
        list.items.add(file)
        input.files = list.files
        input.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      })()`
    )
    if (!given) return null
    const changed = await waitFor(() => background()?.value !== undefined && background()?.value !== before, MEASURE_TIMEOUT_MS + 6000)
    return changed ? Date.now() - started : null
  }
  /** Moves the slider of the strength of the veil to `percent`, as a drag does (the native setter, then the event React listens to). */
  const slide = (percent: number) =>
    evaluate<boolean>(ui, `(() => { const el = document.querySelector(${JSON.stringify(SLIDER)}); if (!el) return false; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(String(percent))}); el.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)

  win.showInactive()
  try {
    browser.openOverlay({ panel: 'space', spaceId, focus: 'color' })
    check('auto-veil: Personnaliser l’espace opens with its media panel', await waitFor(async () => (await rect(INPUT)) !== null || (await evaluate<boolean>(ui, `!!document.querySelector(${JSON.stringify(INPUT)})`))))

    // ---- a bright picture: the light veil and dark text, measured within the time allowed ----
    const brightTime = await addFile(pictureScript('#f6f4ee', '#d8d4c8'))
    const bright = background()
    check('auto-veil: a bright picture added becomes the background of the space, measured', brightTime !== null && bright?.type === 'image' && bright.veilAuto === true, shown(bright))
    check('auto-veil: …within the time the measure is allowed (3 s), upload and reading back included', brightTime !== null && brightTime < MEASURE_TIMEOUT_MS, `${brightTime} ms`)
    check('auto-veil: …with the light veil on the text side at 35 to 45 %, and dark text without the black shadow', bright?.veilColor === '#f4f4f6' && bright.textColor === '#0b0c12' && bright.textHalo === undefined && bright.veilShape === 'text' && bright.veil !== undefined && bright.veil >= 35 && bright.veil <= 45, shown(bright))
    check(
      'auto-veil: …drawn so in the sidebar (a light veil on the text side, dark text of its own colour)',
      await waitFor(async () => (await evaluate<boolean>(chrome, `!!document.querySelector('.sidebar.custom-text .sidebar-background.image.veil.veil-text.text-dark') && !document.querySelector('.sidebar.text-halo')`))),
      await evaluate<string>(chrome, `document.querySelector('.sidebar-background')?.className ?? 'none'`)
    )
    check('auto-veil: the panel says the look was measured, and its button has nothing to bring back', (await waitFor(async () => (await textOf(ui, STATUS)) === t('space-media.veil-auto-on'))) && (await evaluate<string>(ui, `document.querySelector(${JSON.stringify(RESTORE)})?.getAttribute('aria-disabled') ?? ''`)) === 'true', await textOf(ui, STATUS))

    // ---- a dark picture in its place: measured again, the dark veil and white text with its shadow ----
    const darkTime = await addFile(pictureScript('#0d0f18', '#2a2c3a'))
    const dark = background()
    check('auto-veil: a dark picture in place of the measured one is measured again', darkTime !== null && dark?.veilAuto === true && dark.value !== bright?.value, shown(dark))
    check('auto-veil: …with the dark veil on the text side, white text and its shadow, at the low end of the line', dark?.veilColor === '#0b0c12' && dark.textColor === '#ffffff' && dark.textHalo === true && dark.veilShape === 'text' && dark.veil !== undefined && dark.veil >= 35 && dark.veil <= 45, shown(dark))
    check(
      'auto-veil: …drawn so in the sidebar (light text, the shadow on)',
      await waitFor(async () => (await evaluate<boolean>(chrome, `!!document.querySelector('.sidebar.custom-text.text-halo .sidebar-background.image.veil.veil-text.text-light')`))),
      await evaluate<string>(chrome, `document.querySelector('.sidebar-background')?.className ?? 'none'`)
    )

    // ---- the slider takes the measured look away; the keyboard brings it back ----
    await slide(80)
    check('auto-veil: moving the slider sets the veil by hand: the flag goes, the strength is the one set', await waitFor(() => background()?.veil === 80 && background()?.veilAuto === undefined), shown(background()))
    check('auto-veil: …the panel says so, and its button can now bring the measure back', (await waitFor(async () => (await textOf(ui, STATUS)) === t('space-media.veil-auto-off'))) && (await evaluate<string>(ui, `document.querySelector(${JSON.stringify(RESTORE)})?.getAttribute('aria-disabled') ?? ''`)) === 'false', await textOf(ui, STATUS))
    ui.focus()
    await evaluate(ui, `document.querySelector(${JSON.stringify(SLIDER)})?.focus()`)
    key('Tab')
    check('auto-veil: Tab from the slider reaches « Revenir au réglage automatique »', await waitFor(async () => (await evaluate<string>(ui, `document.activeElement?.textContent ?? ''`)) === t('space-media.veil-auto-restore')), await evaluate<string>(ui, `document.activeElement?.outerHTML.slice(0, 120) ?? ''`))
    pressReturn()
    check('auto-veil: Enter on it measures the file again and gives back the measured look', await waitFor(() => background()?.veilAuto === true && background()?.veil === dark?.veil && background()?.veilColor === dark?.veilColor, MEASURE_TIMEOUT_MS + 3000), shown(background()))
    check('auto-veil: …and the focus stays on the button, greyed now', (await evaluate<string>(ui, `document.activeElement?.getAttribute('aria-disabled') ?? ''`)) === 'true')

    // ---- set by hand again, a new file keeps that look unmeasured; a real click brings the measure back ----
    await slide(70)
    await waitFor(() => background()?.veil === 70 && background()?.veilAuto === undefined)
    await addFile(pictureScript('#f6f4ee', '#d8d4c8'))
    const kept = background()
    check('auto-veil: a bright picture in place of one set by hand keeps the look set by hand, unmeasured', kept?.value !== dark?.value && kept?.veilAuto === undefined && kept?.veil === 70 && kept.veilColor === '#0b0c12', shown(kept))
    check('auto-veil: a real click on « Revenir au réglage automatique » measures it and gives it the light veil', (await click(RESTORE)) && (await waitFor(() => background()?.veilAuto === true && background()?.veilColor === '#f4f4f6', MEASURE_TIMEOUT_MS + 3000)), shown(background()))

    // ---- a real video, decoded and seeked in Chromium ----
    const builtins = isBuiltApp() ? join(process.resourcesPath, 'backgrounds') : join(app.getAppPath(), 'resources', 'backgrounds')
    const mp4 = readFileSync(join(builtins, builtinVideoFile('hublot-spatial')))
    const videoTime = await addFile(bytesScript(mp4, 'video/mp4', 'hublot.mp4'))
    const video = background()
    check('auto-veil: an H.264 video added (the dark window of a space ship) is decoded, seeked and measured: the dark veil at 35 to 45 %', videoTime !== null && video?.type === 'video' && video.veilAuto === true && video.veilColor === '#0b0c12' && video.veilShape === 'text' && video.veil !== undefined && video.veil >= 35 && video.veil <= 45, shown(video))
    check('auto-veil: …within the time the measure is allowed (3 s)', videoTime !== null && videoTime < MEASURE_TIMEOUT_MS, `${videoTime} ms`)
    check('auto-veil: …and the panel says nothing went wrong', (await evaluate<string>(ui, `document.querySelector('.space-media-panel .media-info[role="status"]')?.textContent ?? ''`)) === '')

    // ---- a video that cannot decode: the safe veil, never none, and the panel says so. Its first 2 KiB: the header the upload asks for ('ftyp'),
    // then its index (the 'moov' box, about 4.7 KiB at the start of this file) cut in the middle, so that Chromium can read no frame of it. ----
    const brokenTime = await addFile(bytesScript(mp4.subarray(0, 2048), 'video/mp4', 'coupee.mp4'))
    const broken = background()
    check(
      'auto-veil: a video cut in its index, which cannot decode, gets the safe veil (dark, text side, 60 %, white text and shadow)',
      brokenTime !== null && broken?.type === 'video' && broken.veilAuto === true && broken.veil === AUTO_VEIL_FALLBACK.veil && broken.veilColor === AUTO_VEIL_FALLBACK.veilColor && broken.veilShape === 'text' && broken.textColor === '#ffffff' && broken.textHalo === true,
      `${brokenTime} ms ${shown(broken)}`
    )
    check('auto-veil: …and the panel says it could not be measured', await waitFor(async () => (await evaluate<string>(ui, `document.querySelector('.space-media-panel .media-info[role="status"]')?.textContent ?? ''`)) === t('space-media.veil-auto-failed')))
  } finally {
    browser.closeOverlay()
    if (previousSpace) browser.dispatch({ type: 'space/select', id: previousSpace })
    browser.dispatch({ type: 'space/delete', id: spaceId })
  }
}

/** `LUCIUM_SMOKE_ONLY=auto-veil`: only these checks, with their own report. Returns the exit code. */
export async function runAutoVeilSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  const complaints: string[] = []
  ctx.overlayView.webContents.on('console-message', (event) => {
    if (event.level === 'error') complaints.push(`${event.level}: ${event.message.slice(0, 300)}`)
  })
  try {
    await smokeAutoVeil(ctx, (name, ok, detail) => noteCheck(checks, name, ok, detail))
    noteCheck(checks, 'auto-veil: the panel wrote no error in its console', complaints.length === 0, complaints.join(' | '))
  } catch (error) {
    noteCheck(checks, 'smokeAutoVeil ran to the end', false, String((error as Error).stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_AUTO_VEIL ${JSON.stringify({ checks, complaints, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
