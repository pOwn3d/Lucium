// The name the Sessions panel proposes ("Enregistrer la session…"): the automatic name, in the language of the interface. The language comes with the
// first snapshot and the panel has none at its first render, so a name worked out then was French in the English interface. Drawn here the way it is on
// screen: first without a snapshot, then with one (the hook of `api.ts` sets the language of the settings while it draws a snapshot, as the mock does).

import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyLanguage, setLanguage } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import type { Settings } from '@shared/model'
import { createInitialState } from '@shared/sidebar'
import { expandedElements, rendersOf } from './render.test-support'

const world = vi.hoisted(() => ({ snapshot: null as UiSnapshot | null }))
vi.mock('./api', async () => {
  const { applyLanguage: apply } = await import('@shared/i18n')
  return {
    api: () => ({ sessionBackups: () => new Promise(() => undefined) }),
    useSnapshot: () => {
      if (world.snapshot) apply(world.snapshot.state.settings, 'fr-FR')
      return world.snapshot
    }
  }
})

import { Sessions } from './Sessions'
import { ListPanel } from './templates'

const snapshotWith = (patch: Partial<Settings>): UiSnapshot => {
  const state = createInitialState({ now: 1, newId: () => 'id' })
  return { state: { ...state, settings: { ...state.settings, ...patch } }, extensions: [], downloads: [] } as unknown as UiSnapshot
}

/** The value of the name field at each of the two draws: before the snapshot (nothing drawn), and with it. */
function nameFieldValues(snapshot: UiSnapshot, focus?: 'save'): Array<string | undefined> {
  return rendersOf(2, (pass) => {
    world.snapshot = pass === 0 ? null : snapshot
    // The frame of the panel has hooks of its own and is drawn only once the snapshot is there: it is listed, not called, and what it holds is read.
    const field = expandedElements(createElement(Sessions, focus ? { focus } : {}), (type) => type === ListPanel).find((element) => element.props['id'] === 'sessions-name')
    return field?.props['value'] as string | undefined
  })
}

afterEach(() => {
  world.snapshot = null
  setLanguage('fr')
})

describe('the name the Sessions panel proposes', () => {
  it('draws no field before the first snapshot, and the automatic name in the language of the interface once it is there', () => {
    const english = nameFieldValues(snapshotWith({ interfaceTranslated: true, language: 'en' }), 'save')
    expect(english[0]).toBeUndefined()
    expect(english[1]).toMatch(/^Session from \d{2} [A-Z][a-z]{2} \d{4} at \d{2}:\d{2}$/)
    setLanguage('en')
    const french = nameFieldValues(snapshotWith({ interfaceTranslated: false, language: 'en' }), 'save')
    expect(french[1]).toMatch(/^Session du \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/)
  })

  it('follows the language of the settings, not the one the process had when the panel opened', () => {
    // The process is still in French when the English snapshot arrives (the first render of a window), and the reverse.
    applyLanguage({ interfaceTranslated: false, language: 'auto' }, 'fr-FR')
    expect(nameFieldValues(snapshotWith({ interfaceTranslated: true, language: 'en' }), 'save')[1]).toMatch(/^Session from /)
    applyLanguage({ interfaceTranslated: true, language: 'en' }, 'en-GB')
    expect(nameFieldValues(snapshotWith({ interfaceTranslated: false, language: 'en' }), 'save')[1]).toMatch(/^Session du /)
  })

  it('leaves the field empty when the panel is not opened to save', () => {
    expect(nameFieldValues(snapshotWith({ interfaceTranslated: true, language: 'en' }))[1]).toBe('')
  })
})
