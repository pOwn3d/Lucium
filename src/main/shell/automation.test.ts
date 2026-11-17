import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { AutomationLimiter } from '@shared/automation-url'
import { Automation, getAutomation, setAutomation, type AutomationHost } from './automation'

function setup(overrides: Partial<AutomationHost> = {}, limiter?: AutomationLimiter) {
  const opened: string[] = []
  let newTabs = 0
  const host: AutomationHost = {
    enabled: () => true,
    locked: () => false,
    openTab: (url) => void opened.push(url),
    newTab: () => void newTabs++,
    searchTemplate: () => 'https://search.example/?q=%s',
    now: () => 0,
    ...overrides
  }
  return { automation: new Automation(host, limiter), opened, newTabs: () => newTabs }
}

let warn: MockInstance<typeof console.warn>
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => vi.restoreAllMocks())

const logged = (): string => warn.mock.calls.map((call) => String(call[0])).join('\n')

describe('Automation', () => {
  it('opens an address in a tab', () => {
    const t = setup()
    expect(t.automation.handle('lucium://open?url=https%3A%2F%2Fexample.com%2Fa')).toEqual({ ran: true, command: 'open' })
    expect(t.opened).toEqual(['https://example.com/a'])
  })

  it('opens the bar for a new tab', () => {
    const t = setup()
    expect(t.automation.handle('lucium://new-tab')).toEqual({ ran: true, command: 'new-tab' })
    expect(t.newTabs()).toBe(1)
    expect(t.opened).toEqual([])
  })

  it('searches with the engine of the profile on screen, the text encoded', () => {
    const t = setup({ searchTemplate: () => 'https://duck.example/?q=%s&kl=fr' })
    expect(t.automation.handle('lucium://search?q=caf%C3%A9%20%26%20lait')).toEqual({ ran: true, command: 'search' })
    expect(t.opened).toEqual(['https://duck.example/?q=caf%C3%A9%20%26%20lait&kl=fr'])
  })

  it('does nothing and says so in the log while the setting is off', () => {
    const t = setup({ enabled: () => false })
    expect(t.automation.handle('lucium://open?url=https%3A%2F%2Fexample.com%2F')).toEqual({ ran: false, reason: 'disabled' })
    expect(t.automation.handle('lucium://new-tab')).toEqual({ ran: false, reason: 'disabled' })
    expect(t.opened).toEqual([])
    expect(t.newTabs()).toBe(0)
    expect(logged()).toContain('refused (disabled)')
  })

  it('reads the setting at each command, not once', () => {
    let on = false
    const t = setup({ enabled: () => on })
    expect(t.automation.handle('lucium://new-tab').ran).toBe(false)
    on = true
    expect(t.automation.handle('lucium://new-tab').ran).toBe(true)
    on = false
    expect(t.automation.handle('lucium://new-tab').ran).toBe(false)
    expect(t.newTabs()).toBe(1)
  })

  it('drops the commands it gets while the application is locked, and does not keep them for the unlocking', () => {
    let locked = true
    const t = setup({ locked: () => locked })
    expect(t.automation.handle('lucium://open?url=https%3A%2F%2Fexample.com%2F')).toEqual({ ran: false, reason: 'locked' })
    expect(logged()).toContain('refused (locked) for "open"')
    locked = false
    expect(t.opened).toEqual([])
  })

  it('refuses what the address rules refuse, runs nothing, and never writes the parameters in the log', () => {
    const t = setup()
    const secret = 'my-secret-search-0123'
    for (const url of ['lucium://clear', `lucium://open?url=javascript%3A${secret}`, 'lucium://open?url=file%3A%2F%2F%2Fetc%2Fpasswd', `lucium://search?q=${secret}&q=again`, 'lucium://new-tab?x=1', 'lucium:open']) {
      expect(t.automation.handle(url).ran, url).toBe(false)
    }
    expect(t.opened).toEqual([])
    expect(t.newTabs()).toBe(0)
    expect(logged()).toContain('refused (unknown-command)')
    expect(logged()).toContain('refused (bad-address) for "open"')
    expect(logged()).not.toContain(secret)
    expect(logged()).not.toContain('passwd')
  })

  it('cuts a flood: after the limit nothing runs until the window has passed, and each refusal is in the log', () => {
    let now = 0
    const t = setup({ now: () => now }, new AutomationLimiter(3, 1000))
    const outcomes = [0, 1, 2, 3, 4].map((i) => {
      now = i
      return t.automation.handle(`lucium://open?url=https%3A%2F%2Fexample.com%2F${i}`)
    })
    expect(outcomes.map((o) => o.ran)).toEqual([true, true, true, false, false])
    expect(t.opened).toHaveLength(3)
    expect(logged().match(/refused \(rate\)/g)).toHaveLength(2)
    now = 1100
    expect(t.automation.handle('lucium://new-tab').ran).toBe(true)
  })

  it('does not spend the budget on a command that is refused for another reason', () => {
    const t = setup({}, new AutomationLimiter(1, 1000))
    for (let i = 0; i < 5; i++) t.automation.handle('lucium://clear')
    expect(t.automation.handle('lucium://new-tab').ran).toBe(true)
  })

  it('is the one the engine test reaches through getAutomation', () => {
    const t = setup()
    setAutomation(t.automation)
    expect(getAutomation()).toBe(t.automation)
    setAutomation(null)
    expect(getAutomation()).toBeNull()
  })
})

describe('the scheme in the application’s Info.plist', () => {
  // macOS only hands an address to an application that declared its scheme; electron-builder writes the declaration from this file.
  // Without its comments: the file explains in words why there is no dictionary.
  const config = readFileSync(fileURLToPath(new URL('../../../electron-builder.yml', import.meta.url)), 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')

  it('is declared beside http and https, which make Lucium selectable as a browser: lucium, and no other', () => {
    expect(config).toContain('CFBundleURLSchemes: [http, https]')
    expect(config).toContain('CFBundleURLSchemes: [lucium]')
  })

  it('is not given a scripting dictionary, which Electron cannot serve', () => {
    expect(config).not.toContain('NSAppleScriptEnabled')
    expect(config).not.toContain('OSAScriptingDefinition')
  })
})
