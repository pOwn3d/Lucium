import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Action } from '@shared/sidebar'
import { applyWithDeveloperTools, runDevTools } from './devtools-command'

afterEach(() => vi.restoreAllMocks())

describe('runDevTools', () => {
  it('asks the page for the tools and says nothing when it worked', async () => {
    const notify = vi.fn()
    const page = { openDevTools: vi.fn().mockResolvedValue({ ok: true }) }
    await runDevTools(page, 'console', notify)
    expect(page.openDevTools).toHaveBeenCalledWith('console')
    expect(notify).not.toHaveBeenCalled()
  })

  it('tells the user, and the journal, when the tools did not open', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const notify = vi.fn()
    await runDevTools({ openDevTools: async () => ({ ok: false, reason: 'not-opened', detail: 'no devtools-opened after 10000 ms' }) }, 'tools', notify)
    expect(notify).toHaveBeenCalledWith('Les outils de développement n’ont pas pu s’ouvrir.')
    expect(error).toHaveBeenCalledWith('[devtools] "tools" failed (not-opened):', 'no devtools-opened after 10000 ms')
  })

  it('tells the user when the tools are open but the panel did not follow, and when the picking of an element did not start', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const notify = vi.fn()
    await runDevTools({ openDevTools: async () => ({ ok: false, reason: 'frontend' }) }, 'network', notify)
    await runDevTools({ openDevTools: async () => ({ ok: false, reason: 'script', detail: 'TypeError' }) }, 'inspect', notify)
    expect(notify.mock.calls).toEqual([['Les outils de développement sont ouverts, mais le panneau demandé n’a pas pu s’afficher.'], ['Les outils de développement sont ouverts, mais la sélection d’un élément n’a pas démarré.']])
  })

  it('tells the user when the page itself threw, instead of leaving the rejection unhandled', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const notify = vi.fn()
    await runDevTools({ openDevTools: () => Promise.reject(new Error('Object has been destroyed')) }, 'elements', notify)
    expect(notify).toHaveBeenCalledWith('Les outils de développement sont ouverts, mais le panneau demandé n’a pas pu s’afficher.')
    expect(error).toHaveBeenCalledWith('[devtools] "elements" failed (script):', 'Object has been destroyed')
  })

  it('says there is no page when there is none to open the tools on', async () => {
    const notify = vi.fn()
    await runDevTools(undefined, 'tools', notify)
    expect(notify).toHaveBeenCalledWith('Aucune page ouverte')
  })
})

describe('the Developer Mode row of the site panel', () => {
  const on: Action = { type: 'developer/site', site: 'a.com', enabled: true }
  const off: Action = { type: 'developer/site', site: 'a.com', enabled: false }

  /** A state whose list of developer sites an action changes (or not, as `apply` decides), and a log of what the shell was asked, in order. */
  function setup(hosts: string[], apply: (hosts: string[]) => void) {
    const log: string[] = []
    const io = {
      // The state hands out its list as it is at that moment (a copy: an action replaces the list, it does not edit the one read before).
      developerHosts: () => [...hosts],
      apply: () => {
        log.push('apply')
        apply(hosts)
      },
      showTools: () => void log.push('tools')
    }
    return { log, io }
  }

  it('shows the tools of the page once the interface\'s action went through', () => {
    const { log, io } = setup([], (hosts) => void hosts.push('a.com'))
    applyWithDeveloperTools(on, io)
    expect(log).toEqual(['apply', 'tools'])
  })

  it('shows nothing when the action was refused (the list did not change) or the site was already on', () => {
    const refused = setup([], () => undefined)
    applyWithDeveloperTools(on, refused.io)
    expect(refused.log).toEqual(['apply'])
    const already = setup(['a.com'], () => undefined)
    applyWithDeveloperTools(on, already.io)
    expect(already.log).toEqual(['apply'])
  })

  it('leaves the tools as they are when the mode is switched off', () => {
    const { log, io } = setup(['a.com'], (hosts) => void hosts.splice(0))
    applyWithDeveloperTools(off, io)
    expect(log).toEqual(['apply'])
  })

  it('applies any other action as it is, and shows nothing', () => {
    const applied: Action[] = []
    const shown = vi.fn()
    applyWithDeveloperTools({ type: 'tab/select', id: 'x' }, { developerHosts: () => [], apply: (action) => void applied.push(action), showTools: shown })
    expect(applied).toEqual([{ type: 'tab/select', id: 'x' }])
    expect(shown).not.toHaveBeenCalled()
  })
})
