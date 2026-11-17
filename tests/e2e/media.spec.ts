// A video that plays, without the network nor a permission: the page draws on a canvas and plays its stream in a muted <video> (a muted video
// may play without a click). What the application does with it when the user leaves the tab is read in the page itself.

import { expect, test, type Page } from '@playwright/test'
import { launchLucium, type Running } from './launch'
import { AUTO_PIP_MIN_PLAYED_SECONDS } from '../../src/shared/auto-pip'
import { dispatch, openTab, serveSite, setSettings, titledPage, expectStays, type LocalSite } from './helpers'

let site: LocalSite
let running: Running

/** A page whose video plays a stream drawn on a canvas, and says whether it is playing and whether it floats (Picture in Picture). */
const VIDEO_PAGE = titledPage(
  'Vidéo',
  `<video id="video" muted autoplay playsinline width="320" height="180"></video>
  <script>
    const canvas = document.createElement('canvas')
    canvas.width = 320; canvas.height = 180
    const context = canvas.getContext('2d')
    let frame = 0
    setInterval(() => { context.fillStyle = 'hsl(' + (frame++ * 7 % 360) + ', 70%, 50%)'; context.fillRect(0, 0, 320, 180) }, 40)
    const video = document.getElementById('video')
    video.srcObject = canvas.captureStream(25)
    video.play()
    window.videoState = () => ({ playing: !video.paused && video.readyState >= 2, floating: document.pictureInPictureElement === video, played: video.currentTime })
  </script>`
)

test.beforeAll(async () => {
  site = await serveSite({ '/video': VIDEO_PAGE, '/a': titledPage('Page A') })
})

test.afterAll(async () => {
  await site.close()
})

test.beforeEach(async () => {
  running = await launchLucium()
})

test.afterEach(async () => {
  await running.close()
})

const url = (path: string) => `${site.origin}${path}`
const videoState = (page: Page) => page.evaluate(() => (globalThis as unknown as { videoState(): { playing: boolean; floating: boolean; played: number } }).videoState())

test('auto-pip: a video that plays floats in Picture in Picture when its tab is left while on; off, it does not', async () => {
  for (const on of [false, true]) {
    await setSettings(running.page, { autoPictureInPicture: on })
    const video = await openTab(running, url(`/video?${on}`), 'Vidéo')
    await expect.poll(async () => (await videoState(video.page)).playing, { message: 'the video plays' }).toBe(true)
    // Only a video being watched floats by itself: it has played a few seconds (shared/auto-pip.ts). A tab left sooner keeps its video, on or off,
    // so the control would prove nothing: both wait until the video counts as watched. The feed of the page is a live one, spared the test of the sound.
    await expect.poll(async () => (await videoState(video.page)).played, { message: 'the video has played long enough to count as watched', timeout: 20_000 }).toBeGreaterThanOrEqual(AUTO_PIP_MIN_PLAYED_SECONDS + 0.5)
    // The user goes to another tab.
    const other = await openTab(running, url(`/a?${on}`), 'Page A')
    await dispatch(running.page, { type: 'tab/select', id: other.id })
    if (on) {
      await expect.poll(async () => (await videoState(video.page)).floating, { timeout: 10_000 }).toBe(true)
      // The floating window is put away before the end of the test.
      await video.page.evaluate(() => document.exitPictureInPicture())
    } else {
      // Nothing tells that the application has decided not to float the video: it is watched for longer than the picture takes to come when on.
      await expectStays(async () => (await videoState(video.page)).floating, false, 'the video does not float while the function is off', 1500)
    }
  }
})
