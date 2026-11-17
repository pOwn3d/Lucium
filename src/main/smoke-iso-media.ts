// Engine checks for the media player at the foot of the sidebar: when it shows (a tab that plays and is left), that it sits above the footer
// without covering the list, folded and unfolded under the pointer, with the volume slider, its bubbles, and what every button really does
// in a page. Called from the engine smoke test: `await smokeIsoMedia(ctx, check)`. `LUCIUM_SMOKE_ONLY=iso-media` runs only this file.
//
// Nothing is ever heard: the page plays a tone through the Web Audio API into an <audio> element, and its web contents is muted at the
// engine level (not through the tab's own mute, which is what the player shows) before the tone starts, so Chromium still reports the
// tab as audible while the speakers stay silent. Real mouse and keyboard input (sendInputEvent) drives the sidebar.

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { screen, type WebContents } from 'electron'
import { AUTO_PIP_MIN_PLAYED_SECONDS } from '@shared/auto-pip'
import { MEDIA_TEXT } from '@shared/media-player'
import { PIP_AUTO_CAN_ENTER, PIP_AUTO_ENTER } from './engine/media-scripts'
import type { SmokeContext } from './smoke'
import { noteCheck, sleep, waiterOf } from './smoke-kit'

type Check = (name: string, ok: boolean, detail?: string) => void


const waitFor = waiterOf(5000, 40)

interface Box {
  x: number
  y: number
  w: number
  h: number
}

const near = (actual: number | undefined, expected: number, tolerance = 0.6) => actual !== undefined && Math.abs(actual - expected) <= tolerance
const fmt = (box: Box | null) => (box ? `${box.x},${box.y} ${box.w}x${box.h}` : 'absent')

/** What the page of a tab offers: a tone in an <audio> element, and (unless `plain`) the MediaSession handlers of a music site. */
const musicPage = (title: string, plain: boolean) => `<title>${title}</title><body style="margin:0">${title}<audio id="a"></audio><script>
const ctx = new AudioContext(); const dest = ctx.createMediaStreamDestination(); const osc = ctx.createOscillator(); const gain = ctx.createGain()
gain.gain.value = 0.05; osc.connect(gain); gain.connect(dest); osc.start(); a.srcObject = dest.stream
window.start = async () => { await ctx.resume(); await a.play(); return true }
window.silence = () => { a.pause(); return ctx.suspend() }
let track = 1
const setTrack = (n) => { track = n; document.title = ${JSON.stringify(title + ' ')} + n }
${plain ? '' : `navigator.mediaSession.setActionHandler('nexttrack', () => setTrack(track + 1))
navigator.mediaSession.setActionHandler('previoustrack', () => setTrack(Math.max(1, track - 1)))`}
window.makeAudio = async () => { const x = new Audio(); x.srcObject = dest.stream; await x.play(); document.body.appendChild(x); return true }
</script></body>`

/** A video with a tone (a canvas and an oscillator in one stream): a page whose media can float in Picture in Picture. */
const videoPage = `<title>Vidéo</title><body style="margin:0"><video id="v" width="320" height="180"></video><script>
const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180; const g = canvas.getContext('2d')
setInterval(() => { g.fillStyle = 'hsl(' + (Date.now() / 20 % 360) + ',70%,50%)'; g.fillRect(0, 0, 320, 180) }, 50)
const ctx = new AudioContext(); const dest = ctx.createMediaStreamDestination(); const osc = ctx.createOscillator(); const gain = ctx.createGain()
gain.gain.value = 0.05; osc.connect(gain); gain.connect(dest); osc.start()
v.srcObject = new MediaStream([...canvas.captureStream(20).getVideoTracks(), ...dest.stream.getAudioTracks()])
window.start = async () => { await ctx.resume(); await v.play(); return true }
window.silence = () => { v.pause(); return ctx.suspend() }
</script></body>`

export async function smokeIsoMedia(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, win } = ctx
  const chrome = win.webContents
  const evaluate = <T>(script: string) =>
    (chrome.executeJavaScript(script) as Promise<T>).catch((error: unknown) => {
      throw new Error(`${String(error)} -- in: ${script.replace(/\s+/g, ' ').slice(0, 200)}`)
    })

  // A roomy window at the top left of the screen, so the sidebar has room for its list and the players and the lower edge does not squeeze it.
  const savedBounds = win.getBounds()
  const workArea = screen.getPrimaryDisplay().workArea
  win.setBounds({ x: workArea.x, y: workArea.y, width: 1680, height: 888 })
  await sleep(600)

  const server = createServer((req, res) => {
    if (req.url === '/favicon.ico') return void res.writeHead(404).end()
    res.setHeader('content-type', 'text/html')
    if (req.url?.startsWith('/music')) return res.end(musicPage('Musique', false))
    if (req.url?.startsWith('/plain')) return res.end(musicPage('Simple', true))
    if (req.url?.startsWith('/video')) return res.end(videoPage)
    if (req.url?.startsWith('/inner')) return res.end(musicPage('Intérieur', false))
    if (req.url?.startsWith('/frame')) return res.end('<title>Cadre</title><body style="margin:0"><iframe src="/inner" width="300" height="100"></iframe></body>')
    res.end(`<title>Calme</title><body>Rien ne joue ici ${req.url}</body>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const previousSpace = store.get().activeSpaceId
  const saved = { sidebarVisible: store.get().settings.sidebarVisible, sidebarWidth: store.get().settings.sidebarWidth, hoverCards: store.get().settings.hoverCards, autoPictureInPicture: store.get().settings.autoPictureInPicture }
  browser.dispatch({ type: 'settings/update', patch: { sidebarVisible: true, sidebarWidth: 323, hoverCards: false } })
  browser.dispatch({ type: 'space/create', name: 'Média ISO', emoji: '🎧', hue: 220 })
  const spaceId = store.get().activeSpaceId
  const tabsOf = () => store.get().tabs.filter((t) => t.spaceId === spaceId)
  const openTab = (path: string, name: string) => {
    browser.dispatch({ type: 'tab/open', url: `${base}${path}`, background: true })
    const tab = tabsOf().at(-1)!
    browser.dispatch({ type: 'tab/rename', id: tab.id, title: name })
    return tab.id
  }
  const musicTab = openTab('/music', 'Ma musique')
  const plainTab = openTab('/plain', 'Piste simple')
  const quietTab = openTab('/quiet', 'Calme')
  const activeId = () => store.get().activeTabBySpace[spaceId]
  const select = async (id: string) => {
    browser.dispatch({ type: 'tab/select', id })
    await sleep(350)
  }

  // ---- helpers on the page of a tab (the engine's own object, to start the tone and to read what the media element really does) ----
  type EnginePage = { liveContents(): WebContents | undefined; setMuted(muted: boolean): void; loadURL(url: string): void; controlMedia(command: 'play' | 'pause' | 'previous' | 'next'): Promise<boolean>; probeMedia(): Promise<{ playing: boolean; media: boolean; video: boolean } | null> }
  const pageOf = (id: string) => (browser as unknown as { pages: Map<string, EnginePage> }).pages.get(id)!
  const contentsOf = (id: string) => pageOf(id).liveContents()!
  const inPage = <T>(id: string, code: string, gesture = false) => contentsOf(id).executeJavaScript(code, gesture) as Promise<T>
  /** The volume the media element really has, read from an isolated world: the page itself is told the level it asked for. */
  const nativeVolumes = (id: string) => contentsOf(id).executeJavaScriptInIsolatedWorld(4_200_099, [{ code: `[...document.querySelectorAll('audio, video')].map((a) => +a.volume.toFixed(3))` }]) as Promise<number[]>
  const runtime = () => browser.snapshot().runtime
  const sound = async (id: string) => {
    // Silent for the user first: the engine mutes the web contents, then the tone starts (Chromium still calls the tab audible).
    pageOf(id).setMuted(true)
    await inPage(id, 'start()', true)
    return waitFor(() => runtime().tabs[id]?.audible === true, 6000)
  }
  const hush = async (id: string) => {
    await inPage(id, 'silence()', true)
  }

  // ---- helpers on the sidebar ----
  const rect = (selector: string, nth = 0) =>
    evaluate<Box | null>(`(() => { const el = document.querySelectorAll(${JSON.stringify(selector)})[${nth}]; if (!el) return null; const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) } })()`)
  const style = (selector: string, props: string[], pseudo = '') =>
    evaluate<Record<string, string> | null>(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const s = getComputedStyle(el${pseudo ? `, ${JSON.stringify(pseudo)}` : ''}); return Object.fromEntries(${JSON.stringify(props)}.map((p) => [p, s[p]])) })()`)
  const bar = (id: string) => `.media-player[data-media-player="${id}"]`
  const playerOf = (id: string) => rect(`${bar(id)} .mp-clip`)
  const button = (id: string, cls: string) => rect(`${bar(id)} .${cls}`)
  /** `held`: the left button is down during this move (a drag): without it Chromium takes the move for a pointer that let go. */
  const mouse = (type: 'mouseDown' | 'mouseMove' | 'mouseUp', x: number, y: number, held = false) =>
    chrome.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, ...(held ? { modifiers: ['leftButtonDown'] } : {}) } as Electron.MouseInputEvent)
  const park = async () => {
    mouse('mouseMove', 900, 400)
    await sleep(120)
  }
  const centre = (box: Box) => ({ x: box.x + box.w / 2, y: box.y + box.h / 2 })
  /** Whether `inner` is visible (not empty) and lies inside `outer`. */
  const inside = (inner: Box | null, outer: Box | null) =>
    !!inner && !!outer && inner.w > 0 && inner.h > 0 && inner.x >= outer.x - 0.5 && inner.y >= outer.y - 0.5 && inner.x + inner.w <= outer.x + outer.w + 0.5 && inner.y + inner.h <= outer.y + outer.h + 0.5
  const hoverOn = async (box: Box) => {
    mouse('mouseMove', centre(box).x, centre(box).y)
    await sleep(120)
  }
  const clickOn = async (box: Box, after = 250) => {
    const p = centre(box)
    mouse('mouseMove', p.x, p.y)
    mouse('mouseDown', p.x, p.y)
    mouse('mouseUp', p.x, p.y)
    await sleep(after)
  }
  const press = async (keyCode: string) => {
    chrome.sendInputEvent({ type: 'keyDown', keyCode })
    chrome.sendInputEvent({ type: 'keyUp', keyCode })
    await sleep(150)
  }
  const bubble = () => browser.tooltipWindowForTest()
  const bubbleText = () => bubble()?.webContents.executeJavaScript(`document.getElementById('text').textContent`) as Promise<string>

  // A download that ended in an earlier suite (the principal suite downloads files just before) leaves its bubble above the foot of the sidebar, where the
  // player opens, and the bubble keeps itself while the pointer is on it: it is closed first, by its cross, so that the pointer reaches the player.
  for (let attempt = 0; attempt < 3 && (await rect('.dl-bubble')) !== null; attempt++) {
    const cross = await rect('.dl-bubble .dl-x')
    if (cross) {
      mouse('mouseMove', centre(cross).x, centre(cross).y)
      mouse('mouseDown', centre(cross).x, centre(cross).y)
      mouse('mouseUp', centre(cross).x, centre(cross).y)
    }
    await waitFor(async () => (await rect('.dl-bubble')) === null, 1500)
  }
  await park()

  // ======== when the player shows ========
  await select(musicTab)
  await waitFor(() => store.get().tabs.find((t) => t.id === musicTab)?.title === 'Musique')
  check('media: with nothing playing, the sidebar has no player', (await rect('.media-player')) === null)
  const listBefore = await rect('.scroll')
  const tonePlays = await sound(musicTab)
  check('media: the page really plays (the tab is audible although its web contents is muted)', tonePlays, JSON.stringify(runtime().tabs[musicTab]))
  check('media: a tab that is on screen has no player, even while it plays', (await rect('.media-player')) === null)
  await select(quietTab)
  const shown = await waitFor(() => runtime().media?.includes(musicTab) === true, 6000)
  check('media: leaving a tab that plays opens its player', shown, JSON.stringify(runtime().media))
  await waitFor(() => rect(bar(musicTab)).then((r) => r !== null))
  await sleep(500)

  // ======== folded: directly above the footer, the list pushed up ========
  const folded = await playerOf(musicTab)
  const footer = await rect('.footer')
  const list = await rect('.scroll')
  check('media: it sits above the footer, without overlapping it', !!folded && !!footer && folded.y + folded.h <= footer.y + 1, `${fmt(folded)} / footer ${fmt(footer)}`)
  check('media: the list of tabs is pushed up, not covered: it is shorter and ends above the player', !!list && !!listBefore && !!folded && list.y + list.h <= folded.y && list.h < listBefore.h, `${fmt(listBefore)} -> ${fmt(list)}`)
  const header = await style(`${bar(musicTab)} .mp-header`, ['height', 'opacity'])
  check('media: folded it shows no title, no progress: the controls alone', header?.height === '0px' && header.opacity === '0', JSON.stringify(header))

  const boxes = {
    site: await button(musicTab, 'mp-site'),
    previous: await button(musicTab, 'mp-previous'),
    toggle: await button(musicTab, 'mp-toggle'),
    next: await button(musicTab, 'mp-next'),
    volume: await button(musicTab, 'mp-volume-button')
  }
  const row = Object.values(boxes)
    .filter((box): box is Box => box !== null)
    .sort((a, b) => a.x - b.x)
  check('media: the five buttons are visible, inside the bar, and do not overlap', row.length === 5 && row.every((box, i) => inside(box, folded) && (i === 0 || box.x >= row[i - 1]!.x + row[i - 1]!.w - 0.5)), JSON.stringify(boxes))
  const siteIcon = await rect(`${bar(musicTab)} .mp-site .favicon`)
  check('media: the site icon is visible and inside its button', inside(siteIcon, boxes.site), `${fmt(siteIcon)} in ${fmt(boxes.site)}`)

  // ======== the notes: they fly while the tab plays ========
  const notes = await evaluate<{ playing: string; name: string }>(`(() => { const p = document.querySelector('${bar(musicTab)}'); return { playing: p.dataset.playing, name: getComputedStyle(p.querySelector('.mp-note')).animationName } })()`)
  check('media: while it plays the bar shows pause and notes fly off the icon', notes.playing === 'true' && notes.name === 'mp-note-fly', JSON.stringify(notes))

  // ======== unfolding under the pointer ========
  await park()
  mouse('mouseMove', centre(boxes.toggle!).x, centre(boxes.toggle!).y - 4)
  await sleep(450)
  const open = await playerOf(musicTab)
  const toggleOpen = await button(musicTab, 'mp-toggle')
  // What is under the pointer, said when the bar did not unfold (something laid over the player takes its pointer).
  const underPointer = await evaluate<string>(`(() => { const el = document.elementFromPoint(${centre(boxes.toggle!).x}, ${centre(boxes.toggle!).y - 4}); return el ? el.tagName.toLowerCase() + '.' + [...el.classList].join('.') + ' in ' + (el.closest('[class]')?.parentElement?.className ?? '') : 'nothing' })()`)
  check('media: the pointer unfolds a title row above the controls', !!open && !!folded && open.h > folded.h, `${fmt(folded)} -> ${fmt(open)}; under the pointer: ${underPointer}`)
  check('media: the bar grew upward, its controls stayed where they were', !!open && !!folded && !!toggleOpen && open.y < folded.y && near(open.y + open.h, folded.y + folded.h, 1) && near(toggleOpen.y, boxes.toggle!.y, 1), `${fmt(open)} / ${fmt(toggleOpen)}`)
  const listOpen = await rect('.scroll')
  check('media: the list of tabs gives that room up: it still ends above the player', !!listOpen && !!open && listOpen.y + listOpen.h <= open.y, `${fmt(listOpen)} / ${fmt(open)}`)
  const titleText = await evaluate<string>(`document.querySelector('${bar(musicTab)} .mp-title').textContent`)
  check('media: it is the title of the tab (the one the row of the sidebar shows)', titleText === 'Ma musique', titleText)
  const pip = await button(musicTab, 'mp-pip')
  const close = await button(musicTab, 'mp-close')
  check('media: the picture-in-picture and close buttons are visible inside the bar, side by side', inside(pip, open) && inside(close, open) && pip!.x + pip!.w <= close!.x + 0.5, `${fmt(pip)} ${fmt(close)}`)

  // ======== bubbles: after about 1.5 s ========
  await park()
  browser.showTooltip(null)
  await sleep(250)
  const nextBox = (await button(musicTab, 'mp-next'))!
  const restAt = Date.now()
  mouse('mouseMove', centre(nextBox).x, centre(nextBox).y)
  // A fixed wait, for want of a witness: the delay of the bubble is what is checked.
  await sleep(1300)
  check('media: no bubble yet after 1.3 s on a button', bubble()?.isVisible() !== true)
  const bubbleShown = await waitFor(() => bubble()?.isVisible() === true, 3000)
  const waited = Date.now() - restAt
  check('media: the bubble comes after about 1.5 s', bubbleShown && waited > 1350 && waited < 2300, `${waited} ms`)
  if (bubbleShown) {
    check('media: it says what the button does, in French', (await bubbleText()) === MEDIA_TEXT.next, await bubbleText())
  }
  await park()
  check('media: the bubble goes when the pointer leaves', await waitFor(() => bubble()?.isVisible() === false, 1500))

  // ======== the buttons of a page that has a MediaSession (next and previous track) ========
  const trackOf = () => inPage<string>(musicTab, 'document.title')
  const actions = runtime().tabs[musicTab]
  check('media: the site registered the previous and next track: the shell knows it', actions?.previous === true && actions.next === true, JSON.stringify(actions))
  await clickOn((await button(musicTab, 'mp-next'))!, 400)
  check('media: next track runs the site\'s own handler', (await trackOf()) === 'Musique 2', await trackOf())
  await clickOn((await button(musicTab, 'mp-next'))!, 400)
  await clickOn((await button(musicTab, 'mp-previous'))!, 400)
  check('media: previous track runs its other handler (the two buttons are not swapped)', (await trackOf()) === 'Musique 2', await trackOf())
  check('media: and the buttons are named after what they do', (await evaluate<string[]>(`['mp-previous', 'mp-next'].map((c) => document.querySelector('${bar(musicTab)} .' + c).getAttribute('aria-label'))`)).join('|') === 'Piste précédente|Piste suivante')

  // ======== play and pause ========
  const nativeBefore = await inPage<boolean>(musicTab, 'a.paused')
  await clickOn((await button(musicTab, 'mp-toggle'))!, 500)
  const pausedNow = await inPage<boolean>(musicTab, 'a.paused')
  check('media: the pause button pauses the media of the page', nativeBefore === false && pausedNow === true, `${nativeBefore} -> ${pausedNow}`)
  const afterPause = await evaluate<{ playing: string; label: string }>(`(() => { const p = document.querySelector('${bar(musicTab)}'); const b = p.querySelector('.mp-toggle'); return { playing: p.dataset.playing, label: b.getAttribute('aria-label') } })()`)
  check('media: the bar then offers play (it says "Lecture"), and the notes stop', afterPause.label === 'Lecture' && afterPause.playing === 'false', JSON.stringify(afterPause))
  check('media: it stays on screen while paused', (await rect(bar(musicTab))) !== null)
  await clickOn((await button(musicTab, 'mp-toggle'))!, 600)
  check('media: pressing it again resumes the media', (await inPage<boolean>(musicTab, 'a.paused')) === false)
  check('media: and the bar shows pause again', (await evaluate<string>(`document.querySelector('${bar(musicTab)} .mp-toggle').getAttribute('aria-label')`)) === 'Pause')
  check('media: the shell reads the page: playing, with media, and no video', JSON.stringify(await pageOf(musicTab).probeMedia()) === JSON.stringify({ playing: true, media: true, video: false }), JSON.stringify(await pageOf(musicTab).probeMedia()))

  // ======== the volume: the speaker opens a third row and does not mute ========
  const mutedBefore = runtime().tabs[musicTab]?.muted
  await clickOn((await button(musicTab, 'mp-volume-button'))!, 500)
  const withSlider = await playerOf(musicTab)
  check('media: the speaker opens a third row (the volume) and does not mute the tab', !!withSlider && !!open && withSlider.h > open.h && runtime().tabs[musicTab]?.muted === mutedBefore, `${fmt(withSlider)} muted ${runtime().tabs[musicTab]?.muted}`)
  const zone = await rect(`${bar(musicTab)} .mp-slider`)
  const track = await rect(`${bar(musicTab)} .mp-track`)
  const thumb = await rect(`${bar(musicTab)} .mp-thumb`)
  check('media: the slider, its track and its thumb are visible, inside the bar', inside(zone, withSlider) && inside(track, zone) && inside(thumb, zone), `${fmt(zone)} ${fmt(track)} ${fmt(thumb)}`)
  const toggleBelow = await button(musicTab, 'mp-toggle')
  check('media: the slider row sits under the controls, which it does not cover', !!zone && !!toggleBelow && zone.y >= toggleBelow.y + toggleBelow.h, `${zone?.y} / controls ${fmt(toggleBelow)}`)
  // The centre of the thumb follows the pointer: the thumb travels the width of the slider minus its own.
  const levelX = (level: number) => zone!.x + thumb!.w / 2 + (zone!.w - thumb!.w) * level
  check('media: at the page\'s own level the thumb is at the right end of the slider', !!zone && !!thumb && near(thumb.x + thumb.w, zone.x + zone.w, 1), `${fmt(thumb)} / ${fmt(zone)}`)
  check('media: the speaker shows as pressed while the slider is open', (await evaluate<string>(`document.querySelector('${bar(musicTab)} .mp-volume-button').getAttribute('aria-pressed')`)) === 'true')

  // Dragging the thumb sets the level of the tab: the media element's own volume is the page's times it.
  const y = zone ? zone.y + zone.h / 2 : 0
  const startX = zone && thumb ? levelX(1) : 0
  const toX = zone && thumb ? levelX(0.25) : 0
  mouse('mouseMove', startX, y)
  mouse('mouseDown', startX, y)
  for (let i = 1; i <= 8; i++) {
    mouse('mouseMove', startX + ((toX - startX) * i) / 8, y, true)
    await sleep(25)
  }
  mouse('mouseUp', toX, y)
  await sleep(500)
  const dragged = await nativeVolumes(musicTab)
  check('media: dragging the thumb to a quarter of the way sets the media to 0.25', near(dragged[0], 0.25, 0.03), JSON.stringify(dragged))
  check('media: the shell keeps the level of the tab, and the page is still told the volume it asked for (1)', near(runtime().tabs[musicTab]?.volume, 0.25, 0.03) && (await inPage<number>(musicTab, 'a.volume')) === 1, `${runtime().tabs[musicTab]?.volume} / page ${await inPage<number>(musicTab, 'a.volume')}`)
  const thumbMoved = await rect(`${bar(musicTab)} .mp-thumb`)
  check('media: the thumb follows (a quarter of its travel)', !!thumbMoved && !!zone && !!thumb && near(thumbMoved.x - zone.x, (zone.w - thumb.w) * 0.25, 3), `${thumbMoved?.x} / ${zone?.x}`)
  await press('Left')
  check('media: the arrow keys move it by 5 %', near((await nativeVolumes(musicTab))[0], 0.2, 0.03), JSON.stringify(await nativeVolumes(musicTab)))
  await press('End')
  check('media: End puts it back to the page\'s own level', near((await nativeVolumes(musicTab))[0], 1, 0.01), JSON.stringify(await nativeVolumes(musicTab)))
  await press('Home')
  await press('Right')
  check('media: Home is silence, and the arrow keys climb from there', near((await nativeVolumes(musicTab))[0], 0.05, 0.03), JSON.stringify(await nativeVolumes(musicTab)))
  // A click on the track jumps there.
  mouse('mouseMove', levelX(0.5), y)
  mouse('mouseDown', levelX(0.5), y)
  mouse('mouseUp', levelX(0.5), y)
  check('media: a click on the track jumps to that level (half)', await waitFor(async () => near((await nativeVolumes(musicTab))[0], 0.5, 0.03)), JSON.stringify(await nativeVolumes(musicTab)))
  // The page keeps working on its own volume, and a new element is turned down before its first sound.
  await inPage(musicTab, 'a.volume = 0.5')
  check('media: a page that sets its own volume keeps its own level, scaled (0.5 x 0.5), and reads back what it set', near((await nativeVolumes(musicTab))[0], 0.25, 0.03) && (await inPage<number>(musicTab, 'a.volume')) === 0.5, `${JSON.stringify(await nativeVolumes(musicTab))} / ${await inPage<number>(musicTab, 'a.volume')}`)
  await inPage(musicTab, 'makeAudio()', true)
  const both = await nativeVolumes(musicTab)
  check('media: an element the page creates later (the next track) starts at the level of the tab', both.length === 2 && near(both[1], 0.5, 0.03), JSON.stringify(both))
  const rangeError = await inPage<string>(musicTab, `(() => { try { a.volume = 1.5; return 'accepted' } catch (e) { return e.name } })()`)
  check('media: the page\'s own checks still apply (a volume above 1 throws what the browser throws: an IndexSizeError)', rangeError === 'IndexSizeError', rangeError)
  await inPage(musicTab, `a.volume = 1; document.querySelectorAll('audio')[1].remove()`)

  // ======== the bar stays open a moment when the pointer leaves with the slider open ========
  const leftAt = Date.now()
  mouse('mouseMove', 900, 300)
  // A fixed wait, for want of a witness: that the bar waits a moment is what is checked.
  await sleep(900)
  check('media: with the slider open the bar waits after the pointer left (still as tall as with the slider after 0.9 s)', !!withSlider && near((await playerOf(musicTab))?.h, withSlider.h), fmt(await playerOf(musicTab)))
  const folding = await waitFor(async () => !!folded && near((await playerOf(musicTab))?.h, folded.h), 3500)
  const foldedAfter = Date.now() - leftAt
  check('media: then it folds, about 1.8 s after the pointer left', folding && foldedAfter > 1500 && foldedAfter < 3000, `${foldedAfter} ms`)

  // ======== folding when the pointer leaves with no slider ========
  await hoverOn((await button(musicTab, 'mp-toggle'))!)
  await sleep(350)
  mouse('mouseMove', 900, 300)
  // The folding is waited for, within the time the fixed wait gave it: "soon" keeps its bound.
  const foldedSoon = await waitFor(async () => !!folded && near((await playerOf(musicTab))?.h, folded.h), 600)
  check('media: it folds back soon after the pointer leaves (no wait without the slider)', foldedSoon, fmt(await playerOf(musicTab)))

  // ======== mute: the tab row's speaker mutes it, the player stays, shows a crossed speaker and tones its play button down (still a working control) ========
  const speakerGlyph = () => evaluate<string>(`document.querySelector('${bar(musicTab)} .mp-volume-button svg')?.outerHTML ?? ''`)
  const speakerBefore = await speakerGlyph()
  browser.toggleMute(musicTab)
  await sleep(500)
  const mutedLook = await evaluate<{ toggleQuiet: boolean; saidUnavailable: boolean; playing: string; present: boolean }>(`(() => { const p = document.querySelector('${bar(musicTab)}'); const b = p.querySelector('.mp-toggle'); return { present: !!p, toggleQuiet: b.classList.contains('quiet') && !b.classList.contains('dim'), saidUnavailable: b.hasAttribute('aria-disabled'), playing: p.dataset.playing } })()`)
  check('media: a tab muted after the player appeared keeps it, with a crossed speaker', mutedLook.present && (await speakerGlyph()) !== speakerBefore, JSON.stringify(mutedLook))
  check('media: and a toned-down play / pause button, not said to be unavailable, without notes', mutedLook.toggleQuiet && !mutedLook.saidUnavailable && mutedLook.playing === 'false', JSON.stringify(mutedLook))
  await clickOn((await button(musicTab, 'mp-toggle'))!, 600)
  check('media: the dimmed button still works (a tab that cannot be heard can still be paused)', (await inPage<boolean>(musicTab, 'a.paused')) === true)
  await hush(musicTab)
  browser.toggleMute(musicTab)
  pageOf(musicTab).setMuted(true)
  await sleep(300)

  // ======== the title: a long one ends with an ellipsis and never pushes the buttons ========
  browser.dispatch({ type: 'tab/rename', id: musicTab, title: 'Un titre de morceau vraiment très long qui ne peut pas tenir sur une seule ligne de la barre latérale' })
  await sleep(300)
  await hoverOn((await button(musicTab, 'mp-toggle'))!)
  await sleep(350)
  const longTitle = await evaluate<{ clipped: boolean; ellipsis: string; right: number; pipLeft: number }>(`(() => { const p = document.querySelector('${bar(musicTab)}'); const t = p.querySelector('.mp-title'); return { clipped: t.scrollWidth > t.clientWidth, ellipsis: getComputedStyle(t).textOverflow, right: t.getBoundingClientRect().right, pipLeft: p.querySelector('.mp-pip').getBoundingClientRect().left } })()`)
  check('media: a long title ends with an ellipsis and stops before the buttons', longTitle.clipped && longTitle.ellipsis === 'ellipsis' && longTitle.right <= longTitle.pipLeft, JSON.stringify(longTitle))
  browser.dispatch({ type: 'tab/rename', id: musicTab, title: 'Ma musique' })
  await park()

  // ======== a site with no track buttons, and no video: those buttons say so instead of doing nothing ========
  await select(plainTab)
  await waitFor(() => store.get().tabs.find((t) => t.id === plainTab)?.title === 'Simple')
  check('media: the second page plays too', await sound(plainTab), JSON.stringify(runtime().tabs[plainTab]))
  await select(quietTab)
  await waitFor(() => runtime().media?.includes(plainTab) === true, 6000)
  await sleep(500)
  const plain = runtime().tabs[plainTab]
  check('media: a site with no MediaSession handlers has no previous or next track', plain?.previous !== true && plain?.next !== true, JSON.stringify(plain))
  check('media: asked for the next track, a site that registered none says so (and nothing is sent)', (await pageOf(plainTab).controlMedia('next')) === false && (await pageOf(plainTab).controlMedia('previous')) === false)
  const disabled = await evaluate<Record<string, string | null>>(`Object.fromEntries(['mp-previous', 'mp-next', 'mp-pip'].map((c) => { const b = document.querySelector('${bar(plainTab)} .' + c); return [c, b.getAttribute('aria-disabled') + '|' + b.getAttribute('aria-label')] }))`)
  check('media: those buttons are dimmed and say why', disabled['mp-previous'] === `true|${MEDIA_TEXT.noPrevious}` && disabled['mp-next'] === `true|${MEDIA_TEXT.noNext}`, JSON.stringify(disabled))
  check('media: the picture-in-picture button too: there is no video to float', disabled['mp-pip'] === `true|${MEDIA_TEXT.noVideo}`, JSON.stringify(disabled))
  const titleBefore = await inPage<string>(plainTab, 'document.title')
  await hoverOn((await button(plainTab, 'mp-toggle'))!)
  await sleep(350)
  await clickOn((await button(plainTab, 'mp-next'))!, 300)
  await clickOn((await button(plainTab, 'mp-pip'))!, 300)
  check('media: pressing them changes nothing and breaks nothing', (await inPage<string>(plainTab, 'document.title')) === titleBefore && (await inPage<boolean>(plainTab, 'a.paused')) === false)
  await hoverOn((await button(plainTab, 'mp-previous'))!)
  const honest = await waitFor(() => bubble()?.isVisible() === true, 3500)
  check('media: the bubble of a dimmed button tells the truth too', honest && (await bubbleText()) === MEDIA_TEXT.noPrevious, await bubbleText())
  await park()
  browser.showTooltip(null)

  // ======== two players stack, 8 px apart ========
  const first = await playerOf(musicTab)
  const second = await playerOf(plainTab)
  check('media: two players stack without overlapping, the newer one lowest', !!first && !!second && second.y >= first.y + first.h - 0.5, `${fmt(first)} / ${fmt(second)}`)
  await hoverOn((await button(plainTab, 'mp-toggle'))!)
  await sleep(350)
  await clickOn((await button(plainTab, 'mp-close'))!, 500)
  check('media: the cross closes that player only, and the media keeps playing', (await rect(bar(plainTab))) === null && (await rect(bar(musicTab))) !== null && (await inPage<boolean>(plainTab, 'a.paused')) === false)
  browser.mediaRequest({ tabId: plainTab, command: 'toggle' })
  // A fixed wait, for want of a witness: the request is refused at once (browser-media.ts), but a toggle let through would reach the page only
  // after two scripts of its own (a probe, then the command), and nothing of the same way comes after it to say it did not.
  await sleep(800)
  check('media: a request for a tab that has no player (any more) drives nothing', (await inPage<boolean>(plainTab, 'a.paused')) === false)
  await hush(plainTab)

  // ======== Back to Tab: the icon activates the tab and the player is gone at once ========
  check('media: the other page plays again', await (async () => { pageOf(musicTab).setMuted(true); await inPage(musicTab, 'start()', true); return waitFor(() => runtime().tabs[musicTab]?.audible === true, 6000) })())
  await hoverOn((await button(musicTab, 'mp-toggle'))!)
  await sleep(300)
  await clickOn((await button(musicTab, 'mp-volume-button'))!, 400)
  mouse('mouseMove', levelX(0.3), y)
  mouse('mouseDown', levelX(0.3), y)
  mouse('mouseUp', levelX(0.3), y)
  check('media: the level of the tab is down before going back', await waitFor(async () => near((await nativeVolumes(musicTab))[0], 0.3, 0.05)), JSON.stringify(await nativeVolumes(musicTab)))
  const site = (await button(musicTab, 'mp-site'))!
  const siteLabel = await evaluate<string>(`document.querySelector('${bar(musicTab)} .mp-site').getAttribute('aria-label')`)
  const p = centre(site)
  mouse('mouseMove', p.x, p.y)
  mouse('mouseDown', p.x, p.y)
  mouse('mouseUp', p.x, p.y)
  const gone = await waitFor(async () => (await rect(bar(musicTab))) === null, 600)
  check('media: the icon of the site ("Retour à l\'onglet") goes back to the tab', siteLabel === 'Retour à l’onglet' && activeId() === musicTab, `${siteLabel} / active ${activeId()}`)
  check('media: and the player is gone at once', gone)
  // The witness: the level of the tab given back to the page, which the end of its player does (browser-media.ts, `releaseMedia`).
  await waitFor(async () => near((await nativeVolumes(musicTab))[0], 1, 0.02) && runtime().tabs[musicTab]?.volume === undefined)
  check('media: the tab is not paused, and plays again at the page\'s own level', (await inPage<boolean>(musicTab, 'a.paused')) === false && near((await nativeVolumes(musicTab))[0], 1, 0.02) && runtime().tabs[musicTab]?.volume === undefined, `${JSON.stringify(await nativeVolumes(musicTab))} / ${runtime().tabs[musicTab]?.volume}`)

  // ======== media inside a frame: it is driven, but the handlers of a frame are not the site's ========
  const frameTab = openTab('/frame', 'Avec un cadre')
  await select(frameTab)
  await waitFor(() => store.get().tabs.find((t) => t.id === frameTab)?.title === 'Cadre')
  await waitFor(() => (contentsOf(frameTab).mainFrame.frames.length ?? 0) > 0, 4000)
  await sleep(500)
  const inner = contentsOf(frameTab).mainFrame.frames[0]!
  pageOf(frameTab).setMuted(true)
  await inner.executeJavaScript('start()', true)
  await waitFor(() => runtime().tabs[frameTab]?.audible === true, 6000)
  await select(quietTab)
  await waitFor(() => runtime().media?.includes(frameTab) === true, 6000)
  await sleep(600)
  const framed = runtime().tabs[frameTab]
  check('media: the player sees the media of a frame (the page itself has none)', framed?.playing === true && framed.media === true, JSON.stringify(framed))
  check('media: the track handlers of a frame are not seen (the bridge is in the main frame): the buttons say there are none', framed?.previous !== true && framed?.next !== true, JSON.stringify(framed))
  await hoverOn((await button(frameTab, 'mp-toggle'))!)
  await sleep(300)
  await clickOn((await button(frameTab, 'mp-toggle'))!, 600)
  check('media: pause reaches the media of the frame', (await inner.executeJavaScript('a.paused')) === true)
  browser.mediaRequest({ tabId: frameTab, command: 'volume', volume: 0.5 })
  check('media: the media of a frame are turned down too (once: a frame has no bridge)', await waitFor(async () => near((await inner.executeJavaScript('a.volume')) as number, 0.5, 0.02)), String(await inner.executeJavaScript('a.volume')))
  await inner.executeJavaScript('silence()', true)
  browser.mediaRequest({ tabId: frameTab, command: 'close' })
  browser.dispatch({ type: 'tab/close', id: frameTab })

  // ======== a new document of the tab starts at its level; a page that went elsewhere has no media left to drive ========
  await select(musicTab)
  await sound(musicTab)
  await select(quietTab)
  await waitFor(() => runtime().media?.includes(musicTab) === true, 6000)
  browser.mediaRequest({ tabId: musicTab, command: 'volume', volume: 0.4 })
  check('media: the shell\'s own request sets the level too', await waitFor(async () => near((await nativeVolumes(musicTab))[0], 0.4, 0.03)), JSON.stringify(await nativeVolumes(musicTab)))
  pageOf(musicTab).loadURL(`${base}/music?again`)
  await waitFor(() => store.get().tabs.find((t) => t.id === musicTab)?.url.endsWith('?again') === true, 5000)
  check('media: the next document of a tab turned down starts turned down (the bridge asks for the level when it loads)', await waitFor(async () => near((await nativeVolumes(musicTab))[0], 0.4, 0.03)), JSON.stringify(await nativeVolumes(musicTab)))
  const reloaded = await waitFor(() => runtime().tabs[musicTab]?.playing === false && runtime().tabs[musicTab]?.next === true, 6000)
  check('media: the player stays for a page that still has media (now paused: the new document did not start) and learns its new handlers', reloaded && (await rect(bar(musicTab))) !== null, JSON.stringify(runtime().tabs[musicTab]))
  pageOf(musicTab).loadURL(`${base}/quiet?away`)
  check('media: a page that goes to one with no media loses its player', await waitFor(async () => (await rect(bar(musicTab))) === null && !(runtime().media ?? []).includes(musicTab), 5000), JSON.stringify(runtime().media))
  pageOf(musicTab).setMuted(true)
  pageOf(musicTab).loadURL(`${base}/music`)
  await waitFor(() => store.get().tabs.find((t) => t.id === musicTab)?.url === `${base}/music`, 5000)
  await sleep(700)

  // ======== a video: it floats (automatic Picture in Picture opens instead of the player), or the player floats it ========
  const videoTab = openTab('/video', 'Ma vidéo')
  browser.dispatch({ type: 'settings/update', patch: { autoPictureInPicture: false } })
  await select(videoTab)
  await waitFor(() => store.get().tabs.find((t) => t.id === videoTab)?.title === 'Vidéo')
  check('media: the video plays', await sound(videoTab), JSON.stringify(runtime().tabs[videoTab]))
  await select(quietTab)
  check('media: with Picture in Picture off, a video that plays in the background gets the player', await waitFor(() => runtime().media?.includes(videoTab) === true, 6000), JSON.stringify(runtime().media))
  await waitFor(() => runtime().tabs[videoTab]?.video === true, 4000)
  const pipOn = await evaluate<string>(`document.querySelector('${bar(videoTab)} .mp-pip').getAttribute('aria-disabled') + '|' + document.querySelector('${bar(videoTab)} .mp-pip').getAttribute('aria-label')`)
  check('media: its picture-in-picture button is live and says what it does', pipOn === 'null|Ouvrir l’image dans l’image', pipOn)
  // The button floats the tab itself in Lucium's own window (0.2.15): the page is lent to that window, the shell marks the tab as floating.
  const lent = () => runtime().tabs[videoTab]?.floating === true
  let floating = false
  for (let attempt = 1; attempt <= 3 && !floating && (await rect(bar(videoTab))) !== null; attempt++) {
    await park()
    await hoverOn((await button(videoTab, 'mp-toggle'))!)
    await sleep(400)
    await clickOn((await button(videoTab, 'mp-pip'))!, 600)
    floating = await waitFor(lent, 2500)
  }
  check('media: pressing it floats the video: the tab goes to Lucium\'s floating window', floating, JSON.stringify(runtime().tabs[videoTab]))
  check('media: and the floating window takes over: the player goes', await waitFor(async () => (await rect(bar(videoTab))) === null, 2000), JSON.stringify(runtime().media))
  await select(videoTab)
  check('media: choosing the tab again brings the floating window forward and leaves the video in it (the place of its page offers to bring it back)', lent(), JSON.stringify(runtime().tabs[videoTab]))
  browser.floatingVideoTab(videoTab, 'back')
  check('media: « Revenir à l’onglet » gives the video back to the tab', await waitFor(() => !lent(), 4000), JSON.stringify(runtime().tabs[videoTab]))
  // The page puts its video back in place by a script of its own (unstageFloatingVideo), a moment after the window went.
  await sleep(800)
  const FACTS = `(() => { const b = v.getBoundingClientRect(); let played = 0; for (let i = 0; i < v.played.length; i++) played += v.played.end(i) - v.played.start(i); return { playing: !v.paused, ended: v.ended, ready: v.readyState, frames: v.videoWidth + 'x' + v.videoHeight, box: b.width + 'x' + b.height, muted: v.muted, volume: v.volume, tracks: v.audioTracks ? v.audioTracks.length : null, decoded: v.webkitAudioDecodedByteCount, played, time: v.currentTime, stream: !!v.srcObject, inPip: !!document.pictureInPictureElement, top: v.matches(':popover-open, :modal, :fullscreen') } })()`
  const before = await inPage<{ playing: boolean; inPip: boolean; top: boolean }>(videoTab, FACTS).catch((error: unknown) => String(error))
  // Only a video being watched floats by itself: it has played AUTO_PIP_MIN_PLAYED_SECONDS (shared/auto-pip.ts). The feed of this page had played
  // 2.9 s when the tab was left, on a machine that runs the steps above quickly, and the rule answered « just started »: the player opened instead.
  const watched = await waitFor(async () => (await inPage<number>(videoTab, 'Math.max(v.currentTime, [...Array(v.played.length).keys()].reduce((sum, i) => sum + v.played.end(i) - v.played.start(i), 0))')) >= AUTO_PIP_MIN_PLAYED_SECONDS + 0.5, 8000)
  check('media: the video has played long enough to be one being watched', watched, JSON.stringify(await inPage<unknown>(videoTab, FACTS).catch((error: unknown) => String(error))))
  browser.dispatch({ type: 'settings/update', patch: { autoPictureInPicture: true } })
  await select(quietTab)
  const justLeft = await inPage<unknown>(videoTab, FACTS).catch((error: unknown) => String(error))
  const floatedByItself = await waitFor(async () => (await inPage<boolean>(videoTab, '!!document.pictureInPictureElement')) === true, 5000)
  await sleep(1200)
  // When it did not float: what the rule says of the page now, and what the page answers when asked to float the same way (its reason).
  const why = floatedByItself ? null : { canEnter: await contentsOf(videoTab).executeJavaScript(PIP_AUTO_CAN_ENTER).catch((error: unknown) => String(error)), enter: await contentsOf(videoTab).executeJavaScript(PIP_AUTO_ENTER, true).catch((error: unknown) => String(error)) }
  check('media: with Picture in Picture on, leaving a playing video floats it, and no player opens', floatedByItself && !(runtime().media ?? []).includes(videoTab), `floating ${floatedByItself} / ${JSON.stringify(runtime().media)} / before ${JSON.stringify(before)} / just left ${JSON.stringify(justLeft)} / ${JSON.stringify(why)}`)
  await select(videoTab)
  await hush(videoTab)
  await sleep(300)
  browser.dispatch({ type: 'tab/close', id: videoTab })

  // ======== the player goes in the same turn as its tab comes back: it is the shell's own state, not an answer of the page ========
  await select(musicTab)
  await sound(musicTab)
  await select(quietTab)
  check('media: leaving the tab again opens its player again', await waitFor(() => runtime().media?.includes(musicTab) === true, 6000), JSON.stringify(runtime().media))
  browser.dispatch({ type: 'tab/select', id: musicTab })
  check('media: selecting the tab takes its player away in that very turn, without waiting for the page to answer', !(runtime().media ?? []).includes(musicTab), JSON.stringify(runtime().media))
  await sleep(300)

  // ======== a page that does not answer cannot hold the player ========
  const busy = contentsOf(musicTab).executeJavaScript('const end = Date.now() + 6500; while (Date.now() < end) {} 1')
  await sleep(300)
  const asked = Date.now()
  const unanswered = await pageOf(musicTab).probeMedia()
  const took = Date.now() - asked
  check('media: a page that does not answer is given up on after about 3 s: nothing is known, which is not "nothing plays"', unanswered === null && took > 2500 && took < 4800, `${JSON.stringify(unanswered)} after ${took} ms`)
  await busy
  await sleep(300)

  // ======== what does not open a player ========
  await select(musicTab)
  browser.toggleMute(musicTab)
  const heardButMuted = await waitFor(() => runtime().tabs[musicTab]?.audible === true && runtime().tabs[musicTab]?.muted === true, 5000)
  await select(quietTab)
  // A fixed wait, for want of a witness: with Picture in Picture on, leaving the tab first asks the page for its video, and a tab that gets no
  // player gives no sign of when that question is over.
  await sleep(1200)
  check('media: a tab that plays but is muted when it is left gets no player', heardButMuted && (runtime().media ?? []).length === 0 && (await rect('.media-player')) === null, `${JSON.stringify(runtime().tabs[musicTab])} ${JSON.stringify(runtime().media)}`)
  await select(musicTab)
  await hush(musicTab)
  browser.toggleMute(musicTab)
  pageOf(musicTab).setMuted(true)
  await sleep(300)
  const silent = await waitFor(() => runtime().tabs[musicTab]?.audible === false, 8000)
  await select(quietTab)
  // A fixed wait, for want of a witness: the same as for the muted tab above.
  await sleep(1200)
  check('media: a tab that is silent when it is left gets none either', silent && (runtime().media ?? []).length === 0, JSON.stringify(runtime().media))

  // ======== a player ends when its tab does ========
  await select(musicTab)
  await sound(musicTab)
  await select(quietTab)
  await waitFor(() => runtime().media?.includes(musicTab) === true, 6000)
  browser.dispatch({ type: 'tab/close', id: musicTab })
  check('media: closing the tab takes its player away', await waitFor(async () => (await rect('.media-player')) === null && (runtime().media ?? []).length === 0, 3000), JSON.stringify(runtime().media))
  browser.dispatch({ type: 'tab/close', id: plainTab })

  // ======== cleanup ========
  server.close()
  browser.dispatch({ type: 'space/select', id: previousSpace })
  browser.dispatch({ type: 'settings/update', patch: saved })
  win.setBounds(savedBounds)
  await sleep(400)
}

/** The same checks with their own report, for LUCIUM_SMOKE_ONLY=iso-media. */
export async function runIsoMediaSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  const complaints: string[] = []
  ctx.win.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') complaints.push(`${event.level}: ${event.message.slice(0, 300)}`)
  })
  try {
    const verbose = process.env['LUCIUM_ISO_MEDIA_VERBOSE'] === '1'
    await smokeIsoMedia(ctx, (name, ok, detail) => {
      noteCheck(checks, name, ok, detail)
      if (verbose) console.log(`ISO-MEDIA ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` -- ${detail.slice(0, 400)}`}`)
    })
  } catch (error) {
    noteCheck(checks, 'smokeIsoMedia ran to the end', false, String((error as Error).stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_ISO_MEDIA ${JSON.stringify({ checks, complaints, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
