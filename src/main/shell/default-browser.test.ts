import { afterEach, describe, expect, it, vi } from 'vitest'
import { WINDOWS_DEFAULT_APPS_URL } from '@shared/default-browser'
import type { PlatformId } from '@shared/platform'
import { t } from '@shared/i18n'
import { defaultBrowserNotice, isDefaultBrowser, isDefaultBrowserNow, makeDefaultBrowser, registryReader, type DefaultBrowserPorts, type RunProgram } from './default-browser'

// What `reg query <key> /v ProgId` prints for the key of a scheme.
const printed = (progId: string): string => `\r\nHKEY_CURRENT_USER\\...\\UserChoice\r\n    ProgId    REG_SZ    ${progId}\r\n\r\n`

interface Calls {
  queried: string[]
  opened: string[]
  registered: string[]
}

/** Ports of one system; what a test does not set is the system's most usual answer (a built application, nothing registered, Edge as the choice). */
function ports(platform: PlatformId, set: Partial<DefaultBrowserPorts> = {}): { ports: DefaultBrowserPorts; calls: Calls } {
  const calls: Calls = { queried: [], opened: [], registered: [] }
  return {
    calls,
    ports: {
      platform,
      built: true,
      isClient: () => false,
      setClient: (scheme) => (calls.registered.push(scheme), true),
      queryRegistry: async (key) => (calls.queried.push(key), printed('MSEdgeHTM')),
      linuxWebBrowser: async () => 'lucium.desktop',
      openSettings: async (url) => void calls.opened.push(url),
      ...set
    }
  }
}

afterEach(() => vi.restoreAllMocks())

describe('is Lucium the default browser, on Windows', () => {
  it('says no while Windows keeps Edge, even when Electron wrote the association it is able to write', async () => {
    // isClient is what Electron answers from HKCU\Software\Classes: true once setAsDefaultProtocolClient wrote it, and Windows still opens Edge.
    const { ports: p, calls } = ports('win32', { isClient: () => true })
    expect(await isDefaultBrowser(p)).toBe(false)
    expect(calls.queried).toHaveLength(2)
    expect(calls.queried[0]).toContain('\\UrlAssociations\\http\\UserChoiceLatest\\ProgId')
    expect(calls.queried[1]).toContain('\\UrlAssociations\\https\\UserChoiceLatest\\ProgId')
  })

  // Recent Windows 11 (build 26300, seen in the VM): after the user picks Lucium in Settings, `UserChoiceLatest` says Lucium and a link opens in Lucium, while
  // `UserChoice` still holds the browser it had before, and is no longer updated.
  it('says yes when UserChoiceLatest holds Lucium even though UserChoice still holds the older browser', async () => {
    const { ports: p } = ports('win32', { queryRegistry: async (key) => printed(key.includes('UserChoiceLatest') ? 'LuciumURL' : 'MSEdgeHTM') })
    expect(await isDefaultBrowser(p)).toBe(true)
  })

  it('says no when UserChoiceLatest holds another browser again, whatever an older UserChoice kept', async () => {
    const { ports: p } = ports('win32', { queryRegistry: async (key) => printed(key.includes('UserChoiceLatest') ? 'MSEdgeHTM' : 'LuciumURL') })
    expect(await isDefaultBrowser(p)).toBe(false)
  })

  it('reads UserChoice on the Windows that has no UserChoiceLatest', async () => {
    const { ports: p } = ports('win32', { queryRegistry: async (key) => (key.includes('UserChoiceLatest') ? null : printed('LuciumURL')) })
    expect(await isDefaultBrowser(p)).toBe(true)
    const old = ports('win32', { queryRegistry: async (key) => (key.includes('UserChoiceLatest') ? null : printed('MSEdgeHTM')) })
    expect(await isDefaultBrowser(old.ports)).toBe(false)
  })

  it('says yes once Windows holds Lucium for http and https', async () => {
    expect(await isDefaultBrowser(ports('win32', { queryRegistry: async () => printed('LuciumURL') }).ports)).toBe(true)
  })

  it('says no when Windows holds Lucium for one scheme only', async () => {
    const { ports: p } = ports('win32', { queryRegistry: async (key) => printed(key.includes('\\https\\') ? 'MSEdgeHTM' : 'LuciumURL') })
    expect(await isDefaultBrowser(p)).toBe(false)
  })

  it('says no when the user never chose a browser (no UserChoice key)', async () => {
    expect(await isDefaultBrowser(ports('win32', { queryRegistry: async () => null }).ports)).toBe(false)
  })

  it('says it does not know, and logs why, when the registry cannot be read', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { ports: p } = ports('win32', { queryRegistry: () => Promise.reject(new Error('spawn reg.exe ENOENT')) })
    expect(await isDefaultBrowser(p)).toBeNull()
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('[default-browser]'), 'spawn reg.exe ENOENT')
  })
})

describe('is Lucium the default browser, elsewhere', () => {
  it('asks Electron for both schemes and never reads the registry', async () => {
    const yes = ports('darwin', { isClient: () => true })
    expect(await isDefaultBrowser(yes.ports)).toBe(true)
    expect(yes.calls.queried).toEqual([])
    expect(await isDefaultBrowser(ports('darwin', { isClient: (scheme) => scheme === 'http' }).ports)).toBe(false)
  })

  it('on Linux, believes Electron only when the desktop names Lucium too', async () => {
    expect(await isDefaultBrowser(ports('linux', { isClient: () => true }).ports)).toBe(true)
    expect(await isDefaultBrowser(ports('linux', { isClient: () => true, linuxWebBrowser: async () => 'firefox_firefox.desktop\n' }).ports)).toBe(false)
    expect(await isDefaultBrowser(ports('linux', { isClient: (scheme) => scheme === 'http' }).ports)).toBe(false)
  })

  it('on Linux, says it does not know when xdg-settings answers nothing or cannot run', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(await isDefaultBrowser(ports('linux', { isClient: () => true, linuxWebBrowser: async () => null }).ports)).toBeNull()
    expect(await isDefaultBrowser(ports('linux', { isClient: () => true, linuxWebBrowser: () => Promise.reject(new Error('spawn xdg-settings ENOENT')) }).ports)).toBeNull()
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('[default-browser]'), 'spawn xdg-settings ENOENT')
  })

  it('answers the menu at once from Electron, and never dims the entry on Windows, which cannot be read without waiting', () => {
    expect(isDefaultBrowserNow(ports('darwin', { isClient: () => true }).ports)).toBe(true)
    expect(isDefaultBrowserNow(ports('linux', { isClient: () => true }).ports)).toBe(false)
    expect(isDefaultBrowserNow(ports('win32', { isClient: () => true }).ports)).toBe(false)
  })
})

describe('making Lucium the default browser', () => {
  it('opens the default apps of Windows on Lucium and writes no association there', async () => {
    const { ports: p, calls } = ports('win32')
    expect(await makeDefaultBrowser(p)).toBe('system-settings')
    expect(calls.opened).toEqual([WINDOWS_DEFAULT_APPS_URL])
    expect(calls.registered).toEqual([])
  })

  it('does not open Settings from a development copy of Electron, which Windows has no entry for', async () => {
    const { ports: p, calls } = ports('win32', { built: false })
    expect(await makeDefaultBrowser(p)).toBe('failed')
    expect(calls.opened).toEqual([])
  })

  it('says it failed, and logs why, when Settings cannot be opened', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { ports: p } = ports('win32', { openSettings: () => Promise.reject(new Error('no handler for ms-settings')) })
    expect(await makeDefaultBrowser(p)).toBe('failed')
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('[default-browser]'), 'no handler for ms-settings')
  })

  it('registers both schemes on macOS and Linux, and opens nothing', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const { ports: p, calls } = ports(platform)
      expect(await makeDefaultBrowser(p)).toBe('done')
      expect(calls.registered).toEqual(['http', 'https'])
      expect(calls.opened).toEqual([])
    }
  })

  it('fails on macOS when the system refuses a scheme, and from a development copy of Electron without trying', async () => {
    expect(await makeDefaultBrowser(ports('darwin', { setClient: () => false }).ports)).toBe('failed')
    const dev = ports('darwin', { built: false })
    expect(await makeDefaultBrowser(dev.ports)).toBe('failed')
    expect(dev.calls.registered).toEqual([])
  })
})

describe('the registry reader', () => {
  const run = (answer: { error?: Error & { code?: unknown }; stdout?: string }): { run: RunProgram; seen: Array<{ file: string; args: string[] }> } => {
    const seen: Array<{ file: string; args: string[] }> = []
    return { seen, run: (file, args, done) => (seen.push({ file, args }), done(answer.error ?? null, answer.stdout ?? '')) }
  }

  it('runs reg.exe of the system folder with the key and no shell, and hands back what it printed', async () => {
    const { run: fake, seen } = run({ stdout: printed('LuciumURL') })
    expect(await registryReader(fake, 'D:\\Win')('HKCU\\Key')).toBe(printed('LuciumURL'))
    expect(seen).toEqual([{ file: 'D:\\Win\\System32\\reg.exe', args: ['query', 'HKCU\\Key', '/v', 'ProgId'] }])
  })

  it('takes exit code 1 (no such key) for an answer: null', async () => {
    const missing = Object.assign(new Error('Command failed'), { code: 1 })
    expect(await registryReader(run({ error: missing }).run)('HKCU\\Key')).toBeNull()
  })

  it('passes any other failure on, so that the caller says why it does not know', async () => {
    const absent = Object.assign(new Error('spawn reg.exe ENOENT'), { code: 'ENOENT' })
    await expect(registryReader(run({ error: absent }).run)('HKCU\\Key')).rejects.toThrow('ENOENT')
    const timedOut = Object.assign(new Error('timed out'), { code: null })
    await expect(registryReader(run({ error: timedOut }).run)('HKCU\\Key')).rejects.toThrow('timed out')
  })
})

describe('what the menu entry says once the request is answered', () => {
  it('tells Windows users that Settings is open and what to pick there, not that Lucium is offered', () => {
    const notice = defaultBrowserNotice('system-settings')
    expect(notice).toEqual({ type: 'info', message: t('app.les-parametres-de-windows-sont-ouverts'), detail: t('app.choisissez-lucium-pour-http-et-https') })
    expect(notice.message).not.toBe(t('app.lucium-est-propose-comme-navigateur-par'))
  })

  it('keeps the macOS wording for a request the system took, and warns when nothing happened', () => {
    expect(defaultBrowserNotice('done')).toEqual({ type: 'info', message: t('app.lucium-est-propose-comme-navigateur-par'), detail: t('app.macos-peut-demander-une-confirmation') })
    expect(defaultBrowserNotice('failed')).toEqual({ type: 'warning', message: t('app.impossible-de-s-enregistrer-comme-navigateur'), detail: t('app.ouvrez-l-application-installee-puis-reessayez') })
  })
})
