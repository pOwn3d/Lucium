import { describe, expect, it } from 'vitest'
import { rankCandidates } from './command-bar'
import { featureById, isFeatureOn } from './features'
import { COMMANDS, effectiveAccelerator } from './keybindings'
import { menuKey } from './menu-state'
import { defaultSettings } from './model'
import { interfaceMayDispatch } from './ipc-policy'
import { Channel } from './ipc'
import { canOpenInPrivate, privateAction } from './private-window'
import { createInitialState, persistableState, reduce } from './sidebar'
import { exportableState } from './lock'

const ctx = { now: 1, newId: (() => { let n = 0; return () => `id${++n}` })() }
const withManager = (on: boolean) => reduce(createInitialState(ctx), { type: 'settings/update', patch: { passwordManager: on } }, ctx)
const labels = (state: ReturnType<typeof withManager>, query: string, options: { private?: boolean } = {}) => rankCandidates(query, state, [], [], [], options).filter((c) => c.kind === 'action').map((c) => c.label)

describe('the password manager is off until it is switched on', () => {
  it('is off by default and registered as a feature of its own', () => {
    expect(defaultSettings().passwordManager).toBe(false)
    expect(isFeatureOn(defaultSettings(), 'password-manager')).toBe(false)
    expect(featureById('password-manager').key).toBe('passwordManager')
  })

  it('puts nothing about the vault in the state, in what is written, or in what is exported', () => {
    const state = withManager(true)
    const keys = Object.keys(state.settings).filter((key) => /pass|vault|secret|credential|phrase/i.test(key))
    expect(keys).toEqual(['passwordManager'])
    for (const written of [JSON.stringify(persistableState(state)), JSON.stringify(exportableState(state))]) expect(written).not.toMatch(/vault|\"password\"|\"phrase\"|\"username\"/i)
  })

  it('has a channel of its own that the reducer does not carry, and a panel the private window refuses', () => {
    expect(Channel.passwords).toBe('lucium:passwords')
    expect(canOpenInPrivate('passwords')).toBe(false)
    expect(privateAction({ type: 'settings/update', patch: { passwordManager: true } })).toBeNull()
  })

  it('can be switched by the interface like any feature (a Settings window is the interface), and by nothing else', () => {
    expect(interfaceMayDispatch({ type: 'settings/update', patch: { passwordManager: true } }, [])).toBe(true)
  })
})

describe('its commands', () => {
  it('have no default shortcut, and the menu is rebuilt when the switch moves', () => {
    for (const id of ['passwords', 'fillPassword']) {
      expect(COMMANDS.find((c) => c.id === id)?.accelerator, id).toBe('')
      expect(effectiveAccelerator(id, {}), id).toBeUndefined()
    }
    expect(menuKey(withManager(true), [], undefined as never, 0, '')).not.toBe(menuKey(withManager(false), [], undefined as never, 0, ''))
  })

  it('are offered by the command bar only while the manager is on, and never in a private window', () => {
    expect(labels(withManager(true), 'mots de passe')).toContain('Mots de passe')
    expect(labels(withManager(true), 'remplir')).toContain('Remplir l’identifiant et le mot de passe')
    expect(labels(withManager(false), 'mots de passe')).not.toContain('Mots de passe')
    expect(labels(withManager(false), 'remplir')).not.toContain('Remplir l’identifiant et le mot de passe')
    expect(labels(withManager(true), 'mots de passe', { private: true })).not.toContain('Mots de passe')
    expect(labels(withManager(true), 'remplir', { private: true })).not.toContain('Remplir l’identifiant et le mot de passe')
  })
})
