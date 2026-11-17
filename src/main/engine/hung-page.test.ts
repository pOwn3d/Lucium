// A page whose renderer no longer answers: `unresponsive` lays our page over it, `responsive` takes it away, and « Recharger » ends the
// hung renderer before it reloads. PageErrors (error-pages.ts) on a page without Electron, as status-page.test.ts runs it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeContents, FakeCover, fakeHost } from './page-errors.test-support'

vi.mock('electron', () => ({ clipboard: { writeText: vi.fn() }, shell: { openExternal: vi.fn(async () => undefined) } }))
vi.mock('./page-cover', async () => ({ PageCover: (await import('./page-errors.test-support')).FakeCover }))

const { PageErrors } = await import('./error-pages')

function page() {
  const wc = new FakeContents()
  const host = fakeHost()
  new PageErrors(wc as never, host as never)
  return { wc, host }
}

beforeEach(() => {
  FakeCover.made = []
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('a page that does not answer', () => {
  it('is covered by our page, which says so and offers to reload or to wait', () => {
    const { wc } = page()
    wc.emit('unresponsive')
    expect(FakeCover.made).toHaveLength(1)
    const html = FakeCover.made[0]!.loaded[0]!
    expect(html).toContain('Cette page ne répond plus')
    expect(html).toContain('site.example')
    expect(html).toContain('lucium-error:reload?n=')
    expect(html).toContain('lucium-error:wait?n=')
  })

  it('has its cover taken away as soon as it answers again, and the buttons of that page answer nothing any more', () => {
    const { wc, host } = page()
    wc.emit('unresponsive')
    const cover = FakeCover.made[0]!
    wc.emit('responsive')
    expect(cover.disposed).toBe(true)
    cover.click('reload')
    expect(host.reload).not.toHaveBeenCalled()
    expect(wc.forcefullyCrashRenderer).not.toHaveBeenCalled()
  })

  it('is covered again if it hangs again after it answered', () => {
    const { wc } = page()
    wc.emit('unresponsive')
    wc.emit('responsive')
    wc.emit('unresponsive')
    expect(FakeCover.made).toHaveLength(2)
    expect(FakeCover.made[1]!.disposed).toBe(false)
  })

  it('is left as it is when « Attendre » is clicked: no reload, nothing ended', () => {
    const { wc, host } = page()
    wc.emit('unresponsive')
    const cover = FakeCover.made[0]!
    cover.click('wait')
    expect(cover.disposed).toBe(true)
    expect(host.reload).not.toHaveBeenCalled()
    expect(wc.forcefullyCrashRenderer).not.toHaveBeenCalled()
  })

  it('ends its renderer, then reloads, when « Recharger » is clicked: a hung renderer would never run the reload', () => {
    const { wc, host } = page()
    const order: string[] = []
    wc.forcefullyCrashRenderer.mockImplementation(() => void order.push('end'))
    host.reload.mockImplementation(() => void order.push('reload'))
    wc.emit('unresponsive')
    const cover = FakeCover.made[0]!
    cover.click('reload', 'forged')
    expect(order).toEqual([])
    cover.click('reload')
    expect(cover.disposed).toBe(true)
    expect(order).toEqual(['end', 'reload'])
  })

  it('shows no page of a crash for the renderer it ended itself, and shows one for a real crash after that', () => {
    vi.useFakeTimers()
    const { wc } = page()
    wc.emit('unresponsive')
    FakeCover.made[0]!.click('reload')
    wc.emit('render-process-gone', {}, { reason: 'killed' })
    expect(FakeCover.made).toHaveLength(1)
    wc.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(FakeCover.made).toHaveLength(2)
    expect(FakeCover.made[1]!.loaded[0]).toContain('L’onglet a planté')
  })

  it('shows the page of a crash for a renderer that is gone long after the reload was asked, not for the one it ended', () => {
    vi.useFakeTimers()
    const { wc } = page()
    wc.emit('unresponsive')
    FakeCover.made[0]!.click('reload')
    vi.advanceTimersByTime(60_000)
    wc.emit('render-process-gone', {}, { reason: 'oom' })
    expect(FakeCover.made).toHaveLength(2)
  })

  it('gives its place to the page of a crash when the renderer then dies', () => {
    const { wc } = page()
    wc.emit('unresponsive')
    wc.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(FakeCover.made[0]!.disposed).toBe(true)
    expect(FakeCover.made[1]!.loaded[0]).toContain('L’onglet a planté')
  })

  it('is not covered when the page is gone, or when a page of ours is already over it (an error, a status)', () => {
    const gone = page()
    gone.wc.destroyed = true
    gone.wc.emit('unresponsive')
    expect(FakeCover.made).toHaveLength(0)

    const failed = page()
    failed.wc.fail('https://nope.invalid/')
    failed.wc.emit('unresponsive')
    expect(FakeCover.made).toHaveLength(0)

    // The page of the crash is the only cover, and it stays.
    const crashed = page()
    crashed.wc.emit('render-process-gone', {}, { reason: 'crashed' })
    crashed.wc.emit('unresponsive')
    expect(FakeCover.made).toHaveLength(1)
    expect(FakeCover.made[0]!.disposed).toBe(false)
  })

  it('ends nothing and reloads nothing if the page was destroyed before « Recharger » was clicked', () => {
    const { wc, host } = page()
    wc.emit('unresponsive')
    wc.destroyed = true
    FakeCover.made[0]!.click('reload')
    expect(wc.forcefullyCrashRenderer).not.toHaveBeenCalled()
    expect(host.reload).not.toHaveBeenCalled()
  })

  it('goes with the next navigation', () => {
    const { wc } = page()
    wc.emit('unresponsive')
    wc.emit('did-start-loading')
    expect(FakeCover.made[0]!.disposed).toBe(true)
  })
})
