import { afterEach, describe, expect, it } from 'vitest'
import { defaultSettings } from '@shared/model'
import type { ToolCommand } from '@shared/page-tools'
import { initScrollMemory } from '../scroll-memory-store'
import { Browser } from './browser'
import { methodsOf } from './browser-fake.test-support'

const shell = methodsOf(Browser.prototype)
const URL_A = 'https://a.example/long'

function fake(options: { rememberScroll?: boolean; tabPrivate?: boolean; windowPrivate?: boolean; url?: string } = {}) {
  const commands: ToolCommand[] = []
  const state = { settings: { ...defaultSettings(), rememberScroll: options.rememberScroll ?? true }, tabs: [{ id: 't1', url: options.url ?? URL_A, ...(options.tabPrivate ? { private: true } : {}) }] }
  const self = {
    store: { get: () => state },
    isPrivate: () => options.windowPrivate === true,
    scrollRestored: new Set<string>(),
    pages: new Map([['t1', { toolCommand: (command: ToolCommand) => void commands.push(command) }]])
  }
  return { self, commands }
}

afterEach(() => initScrollMemory(null))

describe('the scroll memory in the window', () => {
  it('keeps what the page reports and gives it back to the first document of the next page of the tab', () => {
    initScrollMemory(null)
    const { self, commands } = fake()
    shell['keepScrollPosition']!.call(self, 't1', 1800)
    shell['restoreScrollOnce']!.call(self, 't1')
    expect(commands).toEqual([{ tool: 'scrollMemory', y: 1800 }])
    // A later document of the same page (a navigation inside it) is not pulled back.
    shell['restoreScrollOnce']!.call(self, 't1')
    expect(commands).toHaveLength(1)
  })

  it('does nothing while the setting is off', () => {
    const { self, commands } = fake({ rememberScroll: false })
    shell['keepScrollPosition']!.call(self, 't1', 1800)
    shell['restoreScrollOnce']!.call(self, 't1')
    expect(commands).toEqual([])
  })

  it('keeps nothing of a private tab or a private window', () => {
    for (const options of [{ tabPrivate: true }, { windowPrivate: true }]) {
      const { self, commands } = fake(options)
      shell['keepScrollPosition']!.call(self, 't1', 1800)
      const normal = fake()
      shell['restoreScrollOnce']!.call(normal.self, 't1')
      expect(normal.commands, JSON.stringify(options)).toEqual([])
      shell['restoreScrollOnce']!.call(self, 't1')
      expect(commands).toEqual([])
    }
  })

  it('gives nothing back when the tab is at another address than the one the position was read on', () => {
    initScrollMemory(null)
    shell['keepScrollPosition']!.call(fake().self, 't1', 1800)
    const moved = fake({ url: 'https://a.example/other' })
    shell['restoreScrollOnce']!.call(moved.self, 't1')
    expect(moved.commands).toEqual([])
  })
})
