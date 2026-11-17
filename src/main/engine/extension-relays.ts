// The hidden pages of extensions that report the events Electron does not deliver to their worker (see `relayNativeEvent` in the engine):
// one per extension and profile, made at the first such event its worker listens to, and gone with the extension.

/** The page of a relay, as far as this module drives it. */
export interface RelayContents {
  isDestroyed(): boolean
  close(): void
  once(event: 'did-finish-load' | 'destroyed', listener: () => void): unknown
}

/** What the engine does for the relays: make the hidden view of an extension, load it, and have it listen to one event. */
export interface RelayHost<V extends { webContents: RelayContents }> {
  create(profileId: string, extensionId: string): V | null
  load(view: V, extensionId: string): void
  register(view: V, extensionId: string, name: string): void
}

interface Relay<V> {
  view: V
  names: Set<string>
  ready: boolean
}

export class ExtensionRelays<V extends { webContents: RelayContents }> {
  // The view itself is kept, not only its page: an unreferenced view could be collected with its page.
  private readonly relays = new Map<string, Relay<V>>()

  constructor(private readonly host: RelayHost<V>) {}

  /** The worker of the extension listens to `name`: its relay page (made the first time) listens too, now or once it has loaded. */
  listen(profileId: string, extensionId: string, name: string): void {
    const key = `${profileId}:${extensionId}`
    let relay = this.relays.get(key)
    if (!relay) {
      const view = this.host.create(profileId, extensionId)
      if (!view) return
      const created: Relay<V> = { view, names: new Set<string>(), ready: false }
      relay = created
      this.relays.set(key, created)
      const wc = view.webContents
      wc.once('did-finish-load', () => {
        created.ready = true
        for (const known of created.names) this.host.register(view, extensionId, known)
      })
      // Only this relay: the extension may have been unloaded and loaded again, with a new relay under the same key, before this one went.
      wc.once('destroyed', () => {
        if (this.relays.get(key) === created) this.relays.delete(key)
      })
      this.host.load(view, extensionId)
    }
    if (relay.names.has(name)) return
    relay.names.add(name)
    if (relay.ready) this.host.register(relay.view, extensionId, name)
  }

  /**
   * The relay of an extension that leaves its profile goes with it. Kept, it would hold a document of an extension that is no longer
   * there, and the names it already listens to would keep the worker of the extension loaded again (switched back on, updated) from
   * getting a relay of its own: `names` says the event is relayed, and nothing is.
   */
  close(profileId: string, extensionId: string): void {
    const key = `${profileId}:${extensionId}`
    const relay = this.relays.get(key)
    if (!relay) return
    this.relays.delete(key)
    const wc = relay.view.webContents
    if (!wc.isDestroyed()) wc.close()
  }

  get size(): number {
    return this.relays.size
  }
}
