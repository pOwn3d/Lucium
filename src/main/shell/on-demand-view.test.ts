import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ON_DEMAND_RELEASE_MS, OnDemandView } from './on-demand-view'

let nextId = 1
const made: Array<{ webContents: { id: number; closed: boolean; isDestroyed(): boolean; close(): void } }> = []
const make = () => {
  const webContents = {
    id: nextId++,
    closed: false,
    isDestroyed: () => webContents.closed,
    close: () => {
      webContents.closed = true
    }
  }
  const view = { webContents }
  made.push(view)
  return view
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  made.length = 0
})

describe('a view made on demand (the floating sidebar)', () => {
  it('is not made until it is wanted, then once however often it is wanted', () => {
    const holder = new OnDemandView(make)
    expect(holder.current()).toBeNull()
    expect(made).toHaveLength(0)
    holder.want(true)
    holder.want(true)
    holder.ensure()
    expect(made).toHaveLength(1)
    expect(holder.current()).toBe(made[0])
  })

  it('goes a few minutes after it is no longer wanted, unless it is wanted again before', () => {
    const holder = new OnDemandView(make)
    holder.want(true)
    holder.want(false)
    vi.advanceTimersByTime(ON_DEMAND_RELEASE_MS - 1)
    holder.want(false)
    expect(holder.current()).toBe(made[0])
    holder.want(true)
    vi.advanceTimersByTime(ON_DEMAND_RELEASE_MS * 2)
    expect(made[0]!.webContents.closed).toBe(false)
    holder.want(false)
    vi.advanceTimersByTime(ON_DEMAND_RELEASE_MS)
    expect(made[0]!.webContents.closed).toBe(true)
    expect(holder.current()).toBeNull()
    // Wanted again, a new view is made.
    expect(holder.ensure()).toBe(made[1])
  })

  it('makes nothing to release when it was never made', () => {
    const holder = new OnDemandView(make)
    holder.want(false)
    vi.advanceTimersByTime(ON_DEMAND_RELEASE_MS)
    expect(made).toHaveLength(0)
  })

  it('lets its page speak to the IPC only while it lives, in every set it was given', () => {
    const holder = new OnDemandView(make)
    const trusted = new Set([1000])
    holder.trust(trusted)
    const view = holder.ensure()
    expect(trusted.has(view.webContents.id)).toBe(true)
    holder.release()
    expect([...trusted]).toEqual([1000])
    // A set given while the view lives gets its id at once.
    const later = new Set<number>()
    const again = holder.ensure()
    holder.trust(later)
    expect(later.has(again.webContents.id)).toBe(true)
  })

  it('tells the window of each view it makes, and stands a view closed from outside for none', () => {
    const holder = new OnDemandView(make)
    const seen: number[] = []
    holder.onMade((view) => seen.push(view.webContents.id))
    const first = holder.ensure()
    first.webContents.close()
    expect(holder.current()).toBeNull()
    const second = holder.ensure()
    expect(seen).toEqual([first.webContents.id, second.webContents.id])
  })
})
