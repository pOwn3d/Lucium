import { describe, expect, it } from 'vitest'
import { defaultSettings } from './model'
import { SHARE_LABEL_MAX, SHARE_WINDOWS_MAX, shareChoices, shareRefusal, shareStreams, type ShareChoice } from './display-media'

describe('shareChoices', () => {
  it('lists the displays first, then the windows in the order the system gave them', () => {
    const choices = shareChoices([
      { id: 'window:11:0', name: 'Notes' },
      { id: 'screen:1:0', name: 'Entire Screen' },
      { id: 'window:12:0', name: 'Terminal' }
    ])
    expect(choices.map((c) => [c.kind, c.label])).toEqual([['screen', 'Écran entier'], ['window', 'Notes'], ['window', 'Terminal']])
  })

  it('numbers the displays when there are several', () => {
    const choices = shareChoices([{ id: 'screen:1:0', name: 'Screen 1' }, { id: 'screen:2:0', name: 'Screen 2' }])
    expect(choices.map((c) => c.label)).toEqual(['Écran 1', 'Écran 2'])
  })

  it('drops a window with no title, which the system gives for one it will not name', () => {
    expect(shareChoices([{ id: 'window:1:0', name: '' }, { id: 'window:2:0', name: '   ' }, { id: 'window:3:0', name: 'Mail' }]).map((c) => c.label)).toEqual(['Mail'])
  })

  it('cuts a long title and turns control characters into spaces', () => {
    const [long, odd] = shareChoices([
      { id: 'window:1:0', name: 'x'.repeat(500) },
      { id: 'window:2:0', name: 'a\nb\u0007c' }
    ])
    expect(long!.label).toHaveLength(SHARE_LABEL_MAX)
    expect(long!.label.endsWith('…')).toBe(true)
    expect(odd!.label).toBe('a b c')
  })

  it('offers no more windows than a menu can hold', () => {
    const many = Array.from({ length: SHARE_WINDOWS_MAX + 20 }, (_, i) => ({ id: `window:${i}:0`, name: `Fenêtre ${i}` }))
    expect(shareChoices(many)).toHaveLength(SHARE_WINDOWS_MAX)
  })

  it('does not offer a source whose id is not one the system makes, so that the page gets exactly what was picked', () => {
    const hostile = ['file:///etc/hosts', 'screen:1', 'screen:1:0:0', 'screen:a:0', 'window:1:0 extra', 'tab:1:0', '', 'screen:99999999999:0']
    expect(shareChoices(hostile.map((id) => ({ id, name: 'Nom' })))).toEqual([])
    expect(shareChoices([{ id: 7 as unknown as string, name: 'Nom' }, { id: undefined as unknown as string, name: 'Nom' }])).toEqual([])
  })
})

describe('shareRefusal', () => {
  const ok = { url: 'https://meet.example/room', userGesture: true, videoRequested: true }

  it('lets a web page that asked for a picture, after a click, go on', () => {
    expect(shareRefusal(ok)).toBeNull()
    expect(shareRefusal({ ...ok, url: 'http://localhost:3000/' })).toBeNull()
  })

  it('refuses anything that is not a web page: a file, a page of the interface or of an extension, a frame that is gone', () => {
    for (const url of ['file:///Users/x/a.html', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/p.html', 'about:blank', 'data:text/html,x', 'devtools://devtools/x', '', 'not a url']) {
      expect(shareRefusal({ ...ok, url }), url).toBe('not-a-web-page')
    }
  })

  it('refuses a request that no user gesture explains', () => {
    expect(shareRefusal({ ...ok, userGesture: false })).toBe('no-user-gesture')
  })

  it('refuses a request that does not ask for a picture', () => {
    expect(shareRefusal({ ...ok, videoRequested: false })).toBe('no-video')
  })

  it('says the page is the reason before the gesture, so the log names the first thing that is wrong', () => {
    expect(shareRefusal({ url: 'file:///a', userGesture: false, videoRequested: false })).toBe('not-a-web-page')
  })
})

describe('shareStreams', () => {
  const screen: ShareChoice = { id: 'screen:1:0', kind: 'screen', label: 'Écran entier' }
  const window_: ShareChoice = { id: 'window:5:0', kind: 'window', label: 'Notes' }

  it('gives the page the picture of what was picked, under the name the user read', () => {
    expect(shareStreams(window_, false, 'darwin')).toEqual({ video: { id: 'window:5:0', name: 'Notes' } })
  })

  it('adds the sound of the system only when the page asked, for a whole display, and where Electron can capture it', () => {
    expect(shareStreams(screen, true, 'win32')).toEqual({ video: { id: 'screen:1:0', name: 'Écran entier' }, audio: 'loopback' })
    expect(shareStreams(screen, false, 'win32').audio).toBeUndefined()
    expect(shareStreams(window_, true, 'win32').audio).toBeUndefined()
    expect(shareStreams(screen, true, 'darwin').audio).toBeUndefined()
    expect(shareStreams(screen, true, 'linux').audio).toBeUndefined()
  })
})

describe('the setting', () => {
  it('lets sites ask to share by default; the prompt and the click are what stop a page', () => {
    expect(defaultSettings().allowScreenShare).toBe(true)
  })
})
