// @vitest-environment happy-dom
// « Dans le contenu des pages » under the history list: asked only while the setting is on and the search is not empty, the last answer wins, a click opens the page.

import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LuciumApi } from '@shared/ipc'
import type { PageMatch } from '@shared/page-index'
import { PageContentResults } from './PageContentResults'
import { mount, settle, type Mounted } from './dom.test-support'

const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))
const match = (name: string): PageMatch => ({ url: `https://${name}.example/p`, title: `Page ${name}`, snippet: `… la tarte Tatin de ${name} …`, at: 1 })

let mounted: Mounted | null = null
afterEach(() => {
  mounted?.unmount()
  mounted = null
})

async function show(props: { enabled: boolean; query: string }, answer: (query: string) => Promise<PageMatch[]> = async () => [match('alpha')]) {
  const searchPageContent = vi.fn(answer)
  ;(window as unknown as { lucium: Partial<LuciumApi> }).lucium = { searchPageContent }
  const onOpen = vi.fn()
  mounted = mount(createElement(PageContentResults, { ...props, profileId: 'default', onOpen }))
  await settle(() => wait(350))
  return { container: mounted.container, searchPageContent, onOpen }
}

describe('PageContentResults', () => {
  it('lists the pages found, with their text around the words, and opens one on a click', async () => {
    const { container, searchPageContent, onOpen } = await show({ enabled: true, query: 'tatin' })
    expect(searchPageContent).toHaveBeenCalledWith('tatin', 'default')
    expect(container.textContent).toContain('Page alpha')
    expect(container.textContent).toContain('tarte Tatin de alpha')
    container.querySelector<HTMLButtonElement>('button.lp-main')!.click()
    expect(onOpen).toHaveBeenCalledWith('https://alpha.example/p')
  })

  it('asks nothing and shows nothing while the setting is off', async () => {
    const { container, searchPageContent } = await show({ enabled: false, query: 'tatin' })
    expect(searchPageContent).not.toHaveBeenCalled()
    expect(container.textContent).toBe('')
  })

  it('asks nothing for an empty search', async () => {
    const { container, searchPageContent } = await show({ enabled: true, query: '   ' })
    expect(searchPageContent).not.toHaveBeenCalled()
    expect(container.textContent).toBe('')
  })

  it('shows nothing when nothing was found, and says why in the console when the search fails', async () => {
    expect((await show({ enabled: true, query: 'zzz' }, async () => [])).container.textContent).toBe('')
    mounted?.unmount()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const failed = await show({ enabled: true, query: 'zzz' }, () => Promise.reject(new Error('no')))
    expect(failed.container.textContent).toBe('')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[page-index]'), expect.anything())
    warn.mockRestore()
  })
})
