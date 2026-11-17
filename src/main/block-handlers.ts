// The block-exception handlers of the tabs: one per open tab, registered once when the tab appears and forgotten when it closes, not
// registered again on every state change. Pure: the engine calls are handed in (main/index.ts).

/**
 * Returns the function that brings the handlers in line with the open tabs: `register` runs once for a tab that has none, `forget` runs once for a tab that
 * is gone, and a tab that stays open is left alone.
 */
export function createBlockHandlerSync(register: (tabId: string) => void, forget: (tabId: string) => void): (openTabIds: ReadonlySet<string>) => void {
  const handled = new Set<string>()
  return (openTabIds) => {
    for (const id of openTabIds) {
      if (handled.has(id)) continue
      register(id)
      handled.add(id)
    }
    for (const id of [...handled]) {
      if (openTabIds.has(id)) continue
      forget(id)
      handled.delete(id)
    }
  }
}

/**
 * The same, fed with the tabs of the state at each of its changes. The reducer keeps the same array while no tab changes (a setting, a space, a
 * panel): nothing is looked at then, and no set of every tab is built for a change that cannot have opened or closed one.
 */
export function createBlockHandlerFollower(register: (tabId: string) => void, forget: (tabId: string) => void): (tabs: readonly { readonly id: string }[]) => void {
  const sync = createBlockHandlerSync(register, forget)
  let followed: readonly { readonly id: string }[] | null = null
  return (tabs) => {
    if (tabs === followed) return
    followed = tabs
    sync(new Set(tabs.map((tab) => tab.id)))
  }
}
