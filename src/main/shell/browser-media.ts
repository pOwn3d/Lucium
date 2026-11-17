// A layer of the class Browser (browser.ts; the order of the layers: docs/architecture.md). Sound and media: mute, the media player of the
// sidebar, the volume of a tab.

import { addPlayer, prunePlayers, type MediaProbe, type MediaRequest } from '@shared/media-player'
import { activeTab } from '@shared/sidebar'
import { hostOf } from '@shared/url'
import { nameShown, openDetailsLabel, refusedNotice, startedNotice, stopLabel } from '@shared/tab-capture'
import type { TabCaptureEvent } from '../engine/types'
import { t } from '@shared/i18n'
import type { FloatingOwner, FloatingVideo } from './floating-video'
import { MEDIA_SETTLE_MS } from './browser-base'
import { BrowserActions } from './browser-actions'

export abstract class BrowserMedia extends BrowserActions {
  toggleMute(tabId: string): void {
    const owner = this.ownerOf(tabId)
    if (owner && owner !== this) return owner.toggleMute(tabId)
    const page = this.pages.get(tabId)
    const current = this.runtime.tabs[tabId]
    if (!page || !current) return
    page.setMuted(!current.muted)
    this.runtime = { ...this.runtime, tabs: { ...this.runtime.tabs, [tabId]: { ...current, muted: !current.muted } } }
    this.publish()
  }

  /**
   * The sound of a tab for an extension (shared/tab-capture.ts). An extension that asks while the person has not allowed it is told to them, in the window they
   * are in, with the way to the switch: its details.
   */
  protected onTabCapture(event: TabCaptureEvent): void {
    if (event.kind === 'refused') return this.noticeWindow().showToast(refusedNotice(event.name), { label: openDetailsLabel(), run: () => this.extensionActions?.menu('manage', event.profileId, event.extensionId) })
    const pageId = this.engine.pageIdOfTabNumber(event.tabNumber)
    const owner = pageId === undefined ? undefined : this.ownerOf(pageId)
    if (pageId === undefined || !owner) return
    if (event.kind === 'ended') return owner.markCaptured(pageId, undefined, event.muted)
    // The mark of the tab says who listens for as long as it lasts; the notice says it once, with the way to stop it. The name is any text its author wrote: the mark gets it cleaned and cut, as the notice does.
    owner.markCaptured(pageId, nameShown(event.name))
    const title = this.store.get().tabs.find((tab) => tab.id === pageId)?.title ?? ''
    this.noticeWindow().showToast(startedNotice(event.name, title), { label: stopLabel(), run: () => owner.stopTabCapture(pageId) })
  }

  /**
   * An extension left the profile (uninstalled, its folder removed) or is no longer the one the person chose (its folder asks for other permissions, or has another identifier):
   * what the person allowed it to capture goes, so that one that comes back with the same identifier has to be allowed again.
   */
  protected forgetTabCaptureConsent(profileId: string, extensionId: string): void {
    if (this.store.get().settings.profiles[profileId]?.tabCaptureExtensions?.includes(extensionId) !== true) return
    this.dispatch({ type: 'extension/set-tab-capture', profileId, extensionId, allowed: false })
  }

  /**
   * The mark of a tab an extension captures the sound of (`by`: its name), or none once the capture is over; then `muted` is the state the sound went back to: the
   * speaker of the row follows the real one, which the person may have changed meanwhile.
   */
  markCaptured(tabId: string, by: string | undefined, muted?: boolean): void {
    if (this.win.isDestroyed()) return
    const current = this.runtime.tabs[tabId]
    if (!current) return
    const { capturedBy: _was, ...rest } = current
    this.runtime = { ...this.runtime, tabs: { ...this.runtime.tabs, [tabId]: { ...rest, ...(muted !== undefined ? { muted } : {}), ...(by !== undefined ? { capturedBy: by } : {}) } } }
    this.layout()
    this.publish()
  }

  /** The person stops the capture of the sound of a tab (its mark, its menu, the notice): the extension is asked to end its stream and the sound comes back. */
  stopTabCapture(tabId: string): void {
    const owner = this.ownerOf(tabId)
    if (owner && owner !== this) return owner.stopTabCapture(tabId)
    const tabNumber = this.engine.tabNumberOf(tabId)
    if (tabNumber !== undefined) this.engine.stopTabCapture(tabNumber)
  }

  // ---- « Image dans l'image »: Lucium's floating video window (floating-video.ts) ----

  /** Lucium's floating video window, made by index.ts for the whole group: the main window's browser holds it. */
  setFloatingVideo(floating: FloatingVideo): void {
    this.floatingVideo = floating
  }

  /** "Image dans l'image" from the menu: the video of the tab on screen (the pane the user is in). Never in a private window; what keeps it from floating is said, and logged. */
  async floatMainVideo(): Promise<void> {
    this.followPaneFocus()
    const tab = activeTab(this.store.get())
    const page = this.activePage()
    if (!tab || !page || this.isPrivate()) {
      console.info(`[pip] stopped before the page: page ${page ? 'there' : 'missing'}, private ${this.isPrivate()}`)
      return
    }
    await this.floatTabVideo(tab.id)
  }

  /**
   * Floats the video of a tab (the menu, the button of the media player): in Lucium's window when the video is in the page itself; in the system's
   * window when it is in a frame of the page (an embedded player, which Lucium's window cannot bring forward: the user is told), or when Lucium's
   * window cannot take the page (logged). Never for a tab of a private window. True when a video floats.
   */
  async floatTabVideo(tabId: string): Promise<boolean> {
    const owner = this.ownerOf(tabId) ?? this
    const page = owner.pages.get(tabId)
    if (!page || owner.isPrivate()) return false
    const floating = this.leader.floatingVideo
    if (floating) {
      const outcome = await floating.float(owner.floatingOwner(), tabId, page)
      const detail = outcome.ok ? undefined : outcome.detail
      console.info(`[pip] "Image dans l'image" in Lucium's window: ${outcome.ok ? 'ok' : outcome.reason}${detail ? ` (${detail})` : ''}`)
      if (outcome.ok) {
        this.leader.autoPip.floatedByHand()
        return true
      }
      if (outcome.reason === 'busy' || outcome.reason === 'gone') return false
      if (outcome.reason === 'no-video') {
        this.showToast(t('browser.aucune-video-a-faire-flotter'))
        return false
      }
      if (outcome.reason === 'frame') {
        const framed = (await page.floatFrameVideo?.()) ?? { ok: false as const, reason: 'no-video' as const }
        if (framed.ok) {
          this.leader.autoPip.floatedByHand()
          this.showToast(t('browser.video-d-un-cadre-fenetre-du-systeme'))
          return true
        }
        console.error(`[pip] the video of a frame did not float (${framed.reason}): ${framed.detail ?? ''}`)
        this.showToast(framed.reason === 'no-video' ? t('browser.aucune-video-a-faire-flotter') : t('browser.image-dans-l-image-n-a-pas-pu-demarrer'))
        return false
      }
      console.warn(`[pip] Lucium's window could not take the page (${detail ?? outcome.reason}): the system's window instead`)
    }
    const outcome = await page.floatMainVideo()
    if (outcome.ok) this.leader.autoPip.floatedByHand()
    const detail = (outcome as { detail?: string }).detail
    console.info(`[pip] "Image dans l'image": ${outcome.ok ? 'ok' : outcome.reason}${detail ? ` (${detail})` : ''}`)
    if (outcome.ok) return true
    if (outcome.reason === 'already' || outcome.reason === 'gone') return false
    console.error(`[pip] "Image dans l'image" failed (${outcome.reason}): ${outcome.detail ?? ''}`)
    this.showToast(outcome.reason === 'no-video' ? t('browser.aucune-video-a-faire-flotter') : t('browser.image-dans-l-image-n-a-pas-pu-demarrer'))
    return false
  }

  /** The mark of a floating tab in the sidebar (`show`: its window comes to the front) or the place of its page (`back`: the video comes back to the tab). */
  floatingVideoTab(tabId: string, command: 'show' | 'back'): void {
    const floating = this.leader.floatingVideo
    if (!floating || floating.floatingTab() !== tabId) return
    if (command === 'back') floating.back(tabId)
    else floating.show()
  }

  /** What the floating video window needs of this window: the tab it shows, its sound, its row and the place of its page. */
  protected floatingOwner(): FloatingOwner {
    return {
      showTab: (tabId, focus) => {
        this.dispatch({ type: 'tab/select', id: tabId })
        if (focus && !this.win.isDestroyed()) {
          this.win.show()
          this.win.focus()
        }
      },
      tabMuted: (tabId) => this.runtime.tabs[tabId]?.muted === true,
      // The sidebar's speaker follows: the same change as its own button.
      setTabMuted: (tabId, muted) => {
        if ((this.runtime.tabs[tabId]?.muted === true) !== muted) this.toggleMute(tabId)
      },
      floatingChanged: (tabId, floating) => this.markFloating(tabId, floating),
      siteOf: (tabId) => hostOf(this.store.get().tabs.find((t) => t.id === tabId)?.url ?? ''),
      windowBounds: () => (this.win.isDestroyed() ? null : this.win.getBounds())
    }
  }

  /** The row of a floating tab carries a mark, and the place of its page says where it is; the page leaves the window or comes back to it. */
  private markFloating(tabId: string, floating: boolean): void {
    // A window that is closing (the application quits) has nothing left to lay out.
    if (this.win.isDestroyed()) return
    const current = this.runtime.tabs[tabId]
    if (current) {
      const { floating: _was, ...rest } = current
      this.runtime = { ...this.runtime, tabs: { ...this.runtime.tabs, [tabId]: floating ? { ...rest, floating: true } : rest } }
    }
    this.layout()
    this.publish()
  }

  // ---- media players: the bar at the foot of the sidebar for a tab that plays sound while it is not on screen (media-player.ts) ----

  /** Plays or pauses the media of a tab, whether or not it is the one on screen: what the page does now decides which. */
  toggleMedia(tabId: string): void {
    void this.toggleMediaOf(tabId).catch((error: unknown) => console.error('[media] cannot play or pause the tab:', error instanceof Error ? error.message : String(error)))
  }

  private async toggleMediaOf(tabId: string): Promise<void> {
    const owner = this.ownerOf(tabId) ?? this
    const page = owner.pages.get(tabId)
    const probe = await page?.probeMedia()
    if (!page || !probe) return
    const command = probe.playing ? 'pause' : 'play'
    // What the click did is shown at once; the events of the page then confirm it (or correct it) with a probe of their own.
    if (await page.controlMedia(command)) owner.noteMedia(tabId, { playing: command === 'play' })
    owner.refreshMedia(tabId)
  }

  /** Opens the player of a tab that was just left while it made sound. */
  protected openMediaPlayer(tabId: string, publish = true): void {
    // What the page was asked for an earlier player (a document with no media, say) is not what it holds now: it is asked again.
    const owner = this.ownerOf(tabId) ?? this
    const current = owner.runtime.tabs[tabId]
    if (current) {
      const { media: _media, playing: _playing, video: _video, ...rest } = current
      owner.runtime = { ...owner.runtime, tabs: { ...owner.runtime.tabs, [tabId]: rest } }
    }
    this.mediaPlayers = addPlayer(this.mediaPlayers, tabId)
    // A tab that is back on screen by now (the picture in picture took a moment to answer) has no use for one.
    this.pruneMediaPlayers()
    this.refreshMedia(tabId)
    if (publish) this.publish()
  }

  /** Takes away the players that no longer make sense, and gives their tabs their own volume back. */
  protected pruneMediaPlayers(): void {
    if (this.mediaPlayers.length === 0) return
    const state = this.store.get()
    const onScreen = new Set(this.visibleIds())
    const group = this.runtimeOfGroup()
    // With the media player switched off the players go, and each tab is given its own volume back.
    const kept = state.settings.mediaPlayer ? prunePlayers(this.mediaPlayers, { exists: (id) => state.tabs.some((t) => t.id === id), visible: (id) => onScreen.has(id), info: (id) => group.tabs[id] }) : []
    if (kept === this.mediaPlayers) return
    const gone = this.mediaPlayers.filter((id) => !kept.includes(id))
    this.mediaPlayers = kept
    for (const id of gone) this.releaseMedia(id)
  }

  /** A player ends: the tab is no longer driven from the sidebar, so it plays at the page's own volume again. */
  protected releaseMedia(tabId: string): void {
    const owner = this.ownerOf(tabId) ?? this
    clearTimeout(owner.mediaDue.get(tabId))
    owner.mediaDue.delete(tabId)
    if (owner.runtime.tabs[tabId]?.volume !== undefined) owner.setTabVolume(tabId, 1)
  }

  /** The buttons of a media player. Only a tab that has a player is driven from here. */
  mediaRequest(request: MediaRequest): void {
    const { tabId } = request
    if (!this.mediaPlayers.includes(tabId)) return
    const owner = this.ownerOf(tabId) ?? this
    const page = owner.pages.get(tabId)
    switch (request.command) {
      case 'back':
        owner.dispatch({ type: 'tab/select', id: tabId })
        break
      case 'close':
        this.mediaPlayers = this.mediaPlayers.filter((id) => id !== tabId)
        this.releaseMedia(tabId)
        this.publish()
        break
      case 'toggle':
        this.toggleMedia(tabId)
        break
      case 'previous':
      case 'next':
        void page?.controlMedia(request.command).catch((error: unknown) => console.error('[media] cannot change the track:', error instanceof Error ? error.message : String(error)))
        break
      case 'pip':
        void this.floatTabVideo(tabId).then(
          // The floating window is the control now.
          (entered) => {
            if (!entered) return
            this.mediaPlayers = this.mediaPlayers.filter((id) => id !== tabId)
            this.releaseMedia(tabId)
            this.publish()
          },
          (error: unknown) => console.error('[pip] cannot enter Picture in Picture:', error)
        )
        break
      case 'volume':
        owner.setTabVolume(tabId, request.volume)
        break
    }
  }

  /** The level of a whole tab, 0 to 1: its pages scale what their media asks for by it (1 puts it back to the page's own). */
  setTabVolume(tabId: string, volume: number): void {
    const owner = this.ownerOf(tabId) ?? this
    const page = owner.pages.get(tabId)
    const current = owner.runtime.tabs[tabId]
    if (!page || !current) return
    page.setVolume(volume)
    const { volume: _before, ...rest } = current
    owner.runtime = { ...owner.runtime, tabs: { ...owner.runtime.tabs, [tabId]: volume === 1 ? rest : { ...rest, volume } } }
    owner.publish()
  }

  /** Asks the page what its media is doing, and keeps the answer for the player. */
  private refreshMedia(tabId: string): void {
    const owner = this.ownerOf(tabId) ?? this
    const page = owner.pages.get(tabId)
    if (!page) return
    void page.probeMedia().then(
      (probe) => (probe ? owner.noteMedia(tabId, probe) : undefined),
      (error: unknown) => console.error('[media] cannot read the media of a page:', error instanceof Error ? error.message : String(error))
    )
  }

  /** What the player shows of a tab's media. A tab whose page has no media left loses its player. */
  private noteMedia(tabId: string, facts: Partial<Pick<MediaProbe, 'playing' | 'media' | 'video'>>): void {
    const current = this.runtime.tabs[tabId]
    if (!current) return
    this.runtime = { ...this.runtime, tabs: { ...this.runtime.tabs, [tabId]: { ...current, ...facts } } }
    for (const browser of this.group) browser.pruneMediaPlayers()
    this.publish()
  }

  /** The media of a tab started or stopped (an event of the page): when it has a player, it is asked what it does now. */
  protected mediaChanged(tabId: string): void {
    if (!this.mediaPlayers.includes(tabId) || this.mediaDue.has(tabId)) return
    this.mediaDue.set(
      tabId,
      setTimeout(() => {
        this.mediaDue.delete(tabId)
        this.refreshMedia(tabId)
      }, MEDIA_SETTLE_MS)
    )
  }
}
