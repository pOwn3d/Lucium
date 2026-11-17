// What the layout of a window asks of macOS at each pass: the layout runs at every change of the state, so
// the traffic lights are given only when they change, and the views on top of the pages are reordered only when they are not in order already.
// The methods of the shell run on a stand-in (browser-fake.test-support.ts).

import { describe, expect, it, vi } from 'vitest'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

const platform = vi.hoisted(() => ({ given: [] as unknown[], answers: true }))

vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
vi.mock('../platform', () => ({
  currentPlatform: () => ({
    syncTrafficLights: (_win: unknown, lights: unknown) => {
      platform.given.push(lights)
      return platform.answers
    }
  })
}))
const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

describe('the traffic lights of a window', () => {
  it('are given to the window only when they change', () => {
    platform.given.length = 0
    let lights = { visible: true, position: { x: 12, y: 16 } }
    const fake = fakeBrowser({ trafficLightsGiven: '', trafficLights: () => lights, win: {} })
    const sync = () => shell['syncTrafficLights']!.call(fake.self)
    sync()
    sync()
    expect(platform.given).toEqual([lights])
    lights = { visible: true, position: { x: 17, y: 21 } }
    sync()
    lights = { visible: false, position: { x: 17, y: 21 } }
    sync()
    sync()
    expect(platform.given).toHaveLength(3)
  })

  it('are asked again on a system that has none to give (the platform says it did nothing)', () => {
    platform.given.length = 0
    platform.answers = false
    const lights = { visible: true, position: { x: 12, y: 16 } }
    const fake = fakeBrowser({ trafficLightsGiven: '', trafficLights: () => lights, win: {} })
    shell['syncTrafficLights']!.call(fake.self)
    shell['syncTrafficLights']!.call(fake.self)
    expect(platform.given).toHaveLength(2)
    platform.answers = true
  })
})

describe('the views on top of the pages', () => {
  /** A window's content view: `addChildView` puts the view on top, as Electron does with a view it already holds. */
  function contentView(...children: string[]) {
    const added: string[] = []
    const view = {
      children,
      addChildView: (child: string) => {
        view.children = [...view.children.filter((one) => one !== child), child]
        added.push(child)
      }
    }
    return { view, added }
  }
  const stack = (content: ReturnType<typeof contentView>, views: string[]) => shell['stackOnTop']!.call(fakeBrowser({ win: { contentView: content.view } }).self, views)

  it('are left alone when they already are on top, in their order', () => {
    const content = contentView('page', 'floating', 'overlay')
    stack(content, ['floating', 'overlay'])
    stack(content, ['overlay'])
    stack(content, [])
    expect(content.added).toEqual([])
  })

  it('go back on top, in their order, when a view came above them or the order is not theirs', () => {
    const above = contentView('floating', 'overlay', 'new page')
    stack(above, ['floating', 'overlay'])
    expect(above.view.children).toEqual(['new page', 'floating', 'overlay'])
    const swapped = contentView('page', 'overlay', 'floating')
    stack(swapped, ['floating', 'overlay'])
    expect(swapped.view.children).toEqual(['page', 'floating', 'overlay'])
    const missing = contentView('page')
    stack(missing, ['overlay'])
    expect(missing.view.children).toEqual(['page', 'overlay'])
  })
})
