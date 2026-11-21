// What a page captures, and what captures it. The picture of its hover card is a small JPEG made straight from the capture (`thumbnail`). A page
// given the camera, the microphone or the screen says so to the sleep sweep (`usesCapture`), which then neither freezes nor frees it, until the
// page goes elsewhere: Electron does not say when a capture ends. The page of the engine runs over a fake web contents (electron-page.test-support.ts).

import { describe, expect, it, vi } from 'vitest'
import { makePage } from './electron-page.test-support'
import { CAPTURE_MAX_HEIGHT, CAPTURE_MAX_WIDTH, readCaptureSize } from './electron-page-scripts'

vi.mock('electron', async () => (await import('./electron-page.test-support')).electronStub())
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined } }))

describe('the picture of a page for its hover card', () => {
  /** A capture of the page, `width` wide: what it was asked to become, and whether it was ever made a PNG. */
  const capture = (width: number, empty = false) => {
    const asked = { resized: [] as unknown[], png: 0, quality: [] as number[] }
    const image = (w: number): unknown => ({
      isEmpty: () => empty,
      getSize: () => ({ width: w, height: w / 2 }),
      resize: (options: { width: number }) => {
        asked.resized.push(options)
        return image(options.width)
      },
      toJPEG: (quality: number) => {
        asked.quality.push(quality)
        return Buffer.from(`jpeg ${w}`)
      },
      toPNG: () => {
        asked.png++
        return Buffer.from('png')
      }
    })
    return { asked, image: image(width) }
  }

  it('is scaled and encoded straight from the capture, never through a PNG', async () => {
    const { page, wc } = await makePage()
    const shot = capture(2880)
    ;(wc as unknown as { capturePage: () => Promise<unknown> }).capturePage = async () => shot.image
    expect((await page.thumbnail(640, 72)).toString()).toBe('jpeg 640')
    expect(shot.asked).toEqual({ resized: [{ width: 640, quality: 'good' }], png: 0, quality: [72] })
  })

  it('keeps a capture that is small already, and gives nothing for a page that drew nothing', async () => {
    const { page, wc } = await makePage()
    const small = capture(500)
    ;(wc as unknown as { capturePage: () => Promise<unknown> }).capturePage = async () => small.image
    expect((await page.thumbnail(640, 72)).toString()).toBe('jpeg 500')
    expect(small.asked.resized).toEqual([])
    const empty = capture(2880, true)
    ;(wc as unknown as { capturePage: () => Promise<unknown> }).capturePage = async () => empty.image
    expect((await page.thumbnail(640, 72)).length).toBe(0)
  })
})

// « Page entière »: the page sets its own size, and a picture of 100 000 pixels either way would exhaust the memory.
describe('the capture of a whole page', () => {
  const shoot = async (size: { width: number; height: number }) => {
    const { page, wc } = await makePage()
    const sent: Array<{ method: string; params?: unknown }> = []
    wc.debugger.sendCommand = async (method: string, params?: unknown) => {
      sent.push({ method, params })
      return method === 'Page.getLayoutMetrics' ? { cssContentSize: size, contentSize: size } : { data: Buffer.from('png').toString('base64') }
    }
    expect((await page.capture(true)).toString()).toBe('png')
    return (sent.find((command) => command.method === 'Page.captureScreenshot')!.params as { clip: unknown }).clip
  }

  it('takes the page as it is when it is of a usual size', async () => {
    expect(await shoot({ width: 1280.4, height: 5000 })).toEqual({ x: 0, y: 0, width: 1281, height: 5000, scale: 1 })
  })

  it('cuts a page that is too wide, as one that is too tall', async () => {
    expect(await shoot({ width: 100_000, height: 100_000 })).toEqual({ x: 0, y: 0, width: CAPTURE_MAX_WIDTH, height: CAPTURE_MAX_HEIGHT, scale: 1 })
    expect(await shoot({ width: CAPTURE_MAX_WIDTH, height: 10 })).toMatchObject({ width: CAPTURE_MAX_WIDTH })
  })

  it('asks for at least one pixel each way, whatever size the page says', async () => {
    expect(await shoot({ width: 0, height: Number.NaN })).toEqual({ x: 0, y: 0, width: 1, height: 1, scale: 1 })
    expect(await shoot({ width: -50, height: Number.POSITIVE_INFINITY })).toEqual({ x: 0, y: 0, width: 1, height: 1, scale: 1 })
  })
})

describe('a page that was given the camera, the microphone or the screen', () => {
  it('says so until its next navigation, and not before it was given one', async () => {
    const { page, wc } = await makePage()
    expect(page.usesCapture()).toBe(false)
    page.noteCapture()
    expect(page.usesCapture()).toBe(true)
    // A route of the same document keeps the call going.
    wc.emit('did-navigate-in-page', {}, 'https://site.example/#room', true)
    expect(page.usesCapture()).toBe(true)
    wc.emit('did-navigate', {}, 'https://site.example/left')
    expect(page.usesCapture()).toBe(false)
  })
})

// A page that scrolls in a container of its own is as tall as the window for the document: the capture has to walk it and make the window as tall.
describe('the capture of a page that scrolls inside', () => {
  const shoot = async (walked: unknown, documentHeight = 800) => {
    const { page, wc } = await makePage()
    const sent: Array<{ method: string; params?: Record<string, unknown> }> = []
    let tall = 800
    wc.executeJavaScript.mockImplementation(async () => walked)
    wc.debugger.sendCommand = async (method: string, params?: unknown) => {
      sent.push({ method, params: params as Record<string, unknown> })
      if (method === 'Emulation.setDeviceMetricsOverride') tall = (params as { height: number }).height
      if (method === 'Page.getLayoutMetrics') {
        const size = { width: 1280, height: Math.max(tall, documentHeight) }
        return { cssContentSize: size, contentSize: size }
      }
      return { data: Buffer.from('png').toString('base64') }
    }
    const cuts: number[] = []
    await page.capture(true, undefined, (max) => cuts.push(max))
    return { sent, cuts }
  }
  const clipOf = (sent: Array<{ method: string; params?: Record<string, unknown> }>) => sent.find((c) => c.method === 'Page.captureScreenshot')!.params!.clip

  it('makes the window as tall as the page the walk found, shoots it, and gives the window back', async () => {
    const { sent, cuts } = await shoot({ width: 1280, height: 4200.4, inner: true })
    expect(sent.map((c) => c.method)).toEqual(['Emulation.setDeviceMetricsOverride', 'Page.getLayoutMetrics', 'Page.captureScreenshot', 'Emulation.clearDeviceMetricsOverride'])
    expect(sent[0]!.params).toMatchObject({ width: 1280, height: 4201, mobile: false })
    expect(clipOf(sent)).toEqual({ x: 0, y: 0, width: 1280, height: 4201, scale: 1 })
    expect(cuts).toEqual([])
  })

  it('cuts at the maximum and says so, then still gives the window back', async () => {
    const { sent, cuts } = await shoot({ width: 1280, height: 90_000, inner: true })
    expect(clipOf(sent)).toMatchObject({ height: CAPTURE_MAX_HEIGHT })
    expect(cuts).toEqual([CAPTURE_MAX_HEIGHT])
    expect(sent.at(-1)!.method).toBe('Emulation.clearDeviceMetricsOverride')
  })

  it('shoots as before, without touching the window, when the walk of the page fails', async () => {
    const { sent } = await shoot('not a size', 3000)
    expect(sent.map((c) => c.method)).toEqual(['Page.getLayoutMetrics', 'Page.captureScreenshot'])
  })

  it('reads the answer of the walk field by field', () => {
    expect(readCaptureSize({ width: 10, height: 20 })).toEqual({ width: 10, height: 20 })
    expect(readCaptureSize({ width: '10', height: 20 })).toBeNull()
    expect(readCaptureSize({ width: 10, height: Number.NaN })).toBeNull()
    expect(readCaptureSize(null)).toBeNull()
  })
})
