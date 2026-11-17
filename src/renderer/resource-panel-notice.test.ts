// @vitest-environment happy-dom
// The panel of the resources mounted in a document: what ☾ and ✕ of a row say, and when. « Onglet mis en veille » is said in a live region, so a
// screen reader hears it: it must be true (the main process answered that it was done), and not said for a tab that was refused or a request lost.

import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, t } from '@shared/i18n'
import type { LuciumApi } from '@shared/ipc'
import { memoryGauge, resourceActionDone, type ResourceAction, type ResourceActionReply, type ResourceReport } from '@shared/resources'
import { ResourcePanel } from './ResourcePanel'
import { click, mount, settle, type Mounted } from './dom.test-support'

const REPORT: ResourceReport = {
  memoryMb: 2000,
  cpu: 10,
  gauge: memoryGauge(2048, 16 * 1024, 1),
  tabs: [
    { tabId: 't1', name: 'Twitch', url: 'https://twitch.example/', memoryMb: 584, cpu: 7.4 },
    { tabId: 't2', name: 'Perso', url: 'https://perso.example/', memoryMb: 278, cpu: 0.2, pinned: true }
  ],
  hidden: 1
}

let mounted: Mounted | null = null
let answer: (reply: ResourceActionReply) => void = () => undefined
let fail: (error: Error) => void = () => undefined
let asked: ResourceAction[] = []

/** The panel with two rows; each action waits for `answer` or `fail`. */
function panel(): HTMLElement {
  asked = []
  ;(window as unknown as { lucium: Partial<LuciumApi> }).lucium = {
    onResources: (listener) => {
      listener(REPORT)
      return () => undefined
    },
    resourcePanel: () => undefined,
    resourceAction: (action) => {
      asked.push(action)
      return new Promise<ResourceActionReply>((resolve, reject) => {
        answer = resolve
        fail = reject
      })
    }
  }
  mounted = mount(createElement(ResourcePanel, { closing: false, onClose: () => undefined }))
  return mounted.container
}

const said = (container: Element): string => container.querySelector('.rp-notice')?.textContent ?? ''
const named = (container: Element, label: string): Element => {
  const found = container.querySelector(`[aria-label="${label}"]`)
  if (!found) throw new Error(`nothing is named "${label}"`)
  return found
}

beforeEach(() => setLanguage('fr'))
afterEach(() => {
  mounted?.unmount()
  mounted = null
  vi.restoreAllMocks()
})

describe('what the main process answers to ☾ and ✕', () => {
  it('is a success only when it says the tab was put to sleep or closed', () => {
    expect(resourceActionDone({ done: true })).toBe(true)
    expect(resourceActionDone({ done: false })).toBe(false)
    expect(resourceActionDone(null)).toBe(false)
    expect(resourceActionDone({ slept: 3 })).toBe(false)
  })
})

describe('☾ of a row', () => {
  it('says nothing before the answer, then « Onglet mis en veille » once the main process did it', async () => {
    const container = panel()
    await click(named(container, t('resources.mettre-en-veille-name', { name: 'Twitch' })))
    expect(asked).toEqual([{ kind: 'sleep', tabId: 't1' }])
    expect(said(container)).toBe('')
    await settle(() => answer({ done: true }))
    expect(said(container)).toBe(t('taskmanager.onglet-mis-en-veille'))
  })

  it('says that the tab could not be put to sleep when the main process refused it', async () => {
    const container = panel()
    await click(named(container, t('resources.mettre-en-veille-name', { name: 'Twitch' })))
    await settle(() => answer({ done: false }))
    expect(said(container)).toBe(t('resources.veille-impossible'))
  })

  it('says the same when the request is lost, and the error is in the console', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const container = panel()
    await click(named(container, t('resources.mettre-en-veille-name', { name: 'Twitch' })))
    await settle(() => fail(new Error('the window is gone')))
    expect(said(container)).toBe(t('resources.veille-impossible'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('the action sleep of the panel failed'), 'the window is gone')
  })
})

describe('✕ of a row', () => {
  it('says what was done once it was: a pinned tab stays pinned', async () => {
    const container = panel()
    await click(named(container, t('resources.fermer-name', { name: 'Perso' })))
    expect(asked).toEqual([{ kind: 'close', tabId: 't2' }])
    expect(said(container)).toBe('')
    await settle(() => answer({ done: true }))
    expect(said(container)).toBe(t('taskmanager.onglet-epingle-ferme'))
  })

  it('says that the tab could not be closed when nothing was done', async () => {
    const container = panel()
    await click(named(container, t('resources.fermer-name', { name: 'Twitch' })))
    await settle(() => answer(null))
    expect(said(container)).toBe(t('resources.fermeture-impossible'))
  })
})
