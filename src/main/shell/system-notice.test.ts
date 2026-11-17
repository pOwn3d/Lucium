import { afterEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({ supported: true, shown: [] as Array<{ title: string; body: string; silent: boolean }>, throwOnShow: false }))
vi.mock('electron', () => ({
  Notification: class {
    static isSupported(): boolean {
      return electron.supported
    }
    constructor(private readonly options: { title: string; body: string; silent: boolean }) {}
    show(): void {
      if (electron.throwOnShow) throw new Error('no notification centre')
      electron.shown.push(this.options)
    }
  }
}))

import { setNoticeSink, showSystemNotice } from './system-notice'

afterEach(() => {
  electron.supported = true
  electron.shown.length = 0
  electron.throwOnShow = false
})

describe('showSystemNotice', () => {
  it('shows a silent notice with the title and the text, and says it reached the system', () => {
    expect(showSystemNotice({ title: 'Données effacées', body: 'example.com' })).toBe(true)
    expect(electron.shown).toEqual([{ title: 'Données effacées', body: 'example.com', silent: true }])
  })

  it('says it did not when the system has no notifications, so the caller can tell the user another way', () => {
    electron.supported = false
    expect(showSystemNotice({ title: 'a', body: 'b' })).toBe(false)
    expect(electron.shown).toEqual([])
  })

  it('says it did not, and logs, when showing throws', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    electron.throwOnShow = true
    expect(showSystemNotice({ title: 'a', body: 'b' })).toBe(false)
    expect(log).toHaveBeenCalledTimes(1)
    log.mockRestore()
  })
})

describe('setNoticeSink', () => {
  it('records notices instead of showing them, and puts the system back when released', () => {
    const recorded: string[] = []
    const release = setNoticeSink((notice) => (recorded.push(notice.title), true))
    expect(showSystemNotice({ title: 'recorded', body: '' })).toBe(true)
    expect(electron.shown).toEqual([])
    release()
    showSystemNotice({ title: 'system', body: '' })
    expect(recorded).toEqual(['recorded'])
    expect(electron.shown.map((n) => n.title)).toEqual(['system'])
  })

  it('treats a recorder that throws as a refusal', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const release = setNoticeSink(() => {
      throw new Error('broken recorder')
    })
    expect(showSystemNotice({ title: 'a', body: 'b' })).toBe(false)
    release()
    log.mockRestore()
  })
})
