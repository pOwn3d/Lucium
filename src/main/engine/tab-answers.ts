// The answers a tab was given to a permission question without « Se souvenir pour ce site ». Nothing of them is written anywhere: they live in
// memory, for the page that asked, and go with it. Electron answers a permission *check* (`Notification.permission`, `permissions.query`, the
// display of a notification) from the check handler alone, never from the request that was just allowed: without this memory, a site the user
// had just said yes to kept reading "denied". An answer is held for one tab and one site: it gives nothing to another tab, nor to another site.

import type { PermissionDecision } from '@shared/model'

const keyOf = (origin: string, permission: string): string => `${permission} ${origin}`

/** `Scope` is what tabs share their cookies with (Electron's session): a check that names no tab is answered from the tabs of its session. */
export class TabAnswers<Scope extends object> {
  private readonly tabs = new Map<number, { scope: Scope; answers: Map<string, PermissionDecision> }>()

  /** Keeps the answer for this tab. True when it is the first answer the tab holds: the caller then forgets the tab when its page goes. */
  note(tab: number, scope: Scope, origin: string, permission: string, decision: PermissionDecision): boolean {
    const known = this.tabs.get(tab)
    if (known) {
      known.answers.set(keyOf(origin, permission), decision)
      return false
    }
    this.tabs.set(tab, { scope, answers: new Map([[keyOf(origin, permission), decision]]) })
    return true
  }

  /** What this tab was answered for the site, or undefined when it was not asked (or the answer was kept by the user, which is not held here). */
  of(tab: number, origin: string, permission: string): PermissionDecision | undefined {
    return this.tabs.get(tab)?.answers.get(keyOf(origin, permission))
  }

  /** Whether a tab of this session that is still open was allowed it: the answer to a check that names no tab (a frame of another site, a worker). */
  allowedIn(scope: Scope, origin: string, permission: string): boolean {
    const key = keyOf(origin, permission)
    for (const tab of this.tabs.values()) if (tab.scope === scope && tab.answers.get(key) === 'allow') return true
    return false
  }

  /** The page of the tab is gone: so are its answers. */
  forget(tab: number): void {
    this.tabs.delete(tab)
  }
}
