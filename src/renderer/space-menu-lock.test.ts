// The menu of a space opened from its header, drawn for a locked space: the rows the lock refuses are greyed out (aria-disabled) and say why
// under the pointer, « Nouveau dossier » among them, since the folder would land in the locked space.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createInitialState } from '@shared/sidebar'
import { t } from '@shared/i18n'

const holder = vi.hoisted(() => ({ snapshot: null as unknown }))
vi.mock('./api', () => ({ api: () => new Proxy({}, { get: () => () => undefined }), useSnapshot: () => holder.snapshot }))

import { SpaceMenu } from './SpaceMenu'

/** The rows of the menu as drawn for the space on screen: their entry, whether they are greyed out, and their tooltip. */
function rows(locked: boolean): Array<{ entry: string; disabled: boolean; title: string | null }> {
  const state = createInitialState({ now: 1, newId: () => 'home' })
  const lock = { active: true, appLocked: false, lockedSpaces: [state.activeSpaceId], guardedSpaces: [state.activeSpaceId], touchId: false, retryInMs: 0 }
  holder.snapshot = { state, ...(locked ? { lock } : {}) }
  const markup = renderToStaticMarkup(createElement(SpaceMenu, { spaceId: state.activeSpaceId, anchor: { x: 20, y: 20, width: 200, height: 30 } }))
  return [...markup.matchAll(/<button\b([^>]*)>/g)].map(([, attrs]) => ({
    entry: /data-entry="([^"]*)"/.exec(attrs!)?.[1] ?? '',
    disabled: /aria-disabled="true"/.test(attrs!),
    title: /title="([^"]*)"/.exec(attrs!)?.[1] ?? null
  }))
}

beforeEach(() => vi.stubGlobal('window', { innerHeight: 800, innerWidth: 1200, addEventListener: () => undefined, removeEventListener: () => undefined }))
afterEach(() => vi.unstubAllGlobals())

describe('the menu of a locked space, from its header', () => {
  it('greys out « Nouveau dossier » and says why under the pointer; free, the row has no tooltip', () => {
    const folder = (drawn: ReturnType<typeof rows>) => drawn.find((row) => row.entry === 'folder')
    expect(folder(rows(false))).toEqual({ entry: 'folder', disabled: false, title: null })
    expect(folder(rows(true))).toEqual({ entry: 'folder', disabled: true, title: t('lock.deverrouillez-l-espace-d-abord') })
    // « Gérer les espaces » is not the lock's to refuse.
    expect(rows(true).find((row) => row.entry === 'manage')).toEqual({ entry: 'manage', disabled: false, title: null })
  })
})
