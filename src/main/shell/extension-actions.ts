// What the user can do with an extension from the menu of its icon, the Extensions menu and Settings: switch it off in a profile,
// uninstall it, look for updates, look at an update that asks for more. The decisions are here, with their notices; the engine does
// the work (engine/web-store.ts) and the window supplies the confirmation box. Every outcome ends in a sentence for the user.

import type { ExtensionInfo } from '@shared/ipc'
import { profileLabel } from '@shared/profiles'
import type { SidebarState } from '@shared/model'
import type { Action } from '@shared/sidebar'
import { updateSummary, type UpdateReport } from '@shared/web-store'
import type { Engine, ExtensionMenuAction } from '../engine/types'
import { t } from '@shared/i18n'
import { settingsPath } from '@shared/settings-path'

export interface ExtensionActionsEnv {
  engine: Pick<Engine, 'listAllExtensions' | 'uninstallExtension' | 'checkExtensionUpdates' | 'reviewExtensionUpdate'>
  state(): SidebarState
  dispatch(action: Action): void
  toast(message: string, action?: { label: string; run: () => void }): void
  /** A box with two buttons; resolves true for the first. */
  confirm(options: { message: string; detail: string; ok: string }): Promise<boolean>
  /** The Extensions page, on the page of the extension when one is named ("Gérer les extensions…" of the menu of its icon). */
  openExtensions(profileId?: string, extensionId?: string): void
}

export class ExtensionActions {
  constructor(private readonly env: ExtensionActionsEnv) {}

  private find(profileId: string, extensionId: string): ExtensionInfo | undefined {
    return this.env.engine.listAllExtensions().find((e) => e.profileId === profileId && e.id === extensionId)
  }

  private label(profileId: string): string {
    return profileLabel(this.env.state().settings, profileId)
  }

  /** An entry of the menu of an extension's icon. */
  menu(action: ExtensionMenuAction, profileId: string, extensionId: string): void {
    if (action === 'manage') return this.env.openExtensions(profileId, extensionId)
    if (action === 'uninstall') {
      void this.uninstall(profileId, extensionId)
      return
    }
    this.setEnabled(profileId, extensionId, false)
  }

  /** Switches an extension off (or on again) in one profile; the other profiles keep their own choice. */
  setEnabled(profileId: string, extensionId: string, enabled: boolean): void {
    const name = this.find(profileId, extensionId)?.name ?? t('extension-actions.l-extension')
    this.env.dispatch({ type: 'extension/set-enabled', profileId, extensionId, enabled })
    this.env.toast(
      t(enabled ? 'extension-actions.name-est-reactivee-dans-le-profil-profile' : 'extension-actions.name-est-desactivee-dans-le-profil-profile', { name, profile: this.label(profileId) }),
      enabled ? undefined : { label: t('menu.annuler'), run: () => this.setEnabled(profileId, extensionId, true) }
    )
  }

  async uninstall(profileId: string, extensionId: string): Promise<'uninstalled' | 'cancelled' | 'failed'> {
    const info = this.find(profileId, extensionId)
    if (!info) {
      this.env.toast(t('extension-actions.cette-extension-n-est-pas-installee-dans-ce'))
      return 'failed'
    }
    if (info.source !== 'store') {
      this.env.toast(t('extension-actions.name-n-a-pas-ete-installee-depuis-le-chrome-web', { name: info.name, settingsPath: settingsPath('extensions') }))
      return 'failed'
    }
    const confirmed = await this.env.confirm({
      message: t('extension-actions.desinstaller-name', { name: info.name }),
      detail: t('extension-actions.supprimee-du-profil', { profile: this.label(profileId) }),
      ok: t('extension-actions.desinstaller')
    })
    if (!confirmed) return 'cancelled'
    try {
      await this.env.engine.uninstallExtension(profileId, extensionId)
      this.env.toast(t('extension-actions.name-est-desinstallee', { name: info.name }))
      return 'uninstalled'
    } catch (error) {
      console.error(`[extensions] cannot uninstall ${extensionId} from profile ${profileId}:`, error)
      this.env.toast(t('extension-actions.la-desinstallation-de-name-a-echoue-reason', { name: info.name, reason: (error as Error).message }))
      return 'failed'
    }
  }

  /** "Rechercher les mises à jour": asks Google about the Web Store extensions, once, because the user asked. */
  async checkUpdates(): Promise<UpdateReport> {
    this.env.toast(t('extension-actions.recherche-des-mises-a-jour-des-extensions'))
    let report: UpdateReport
    try {
      report = await this.env.engine.checkExtensionUpdates()
    } catch (error) {
      console.error('[extensions] the update check failed:', error)
      report = { checked: 0, updated: [], waiting: [], failed: (error as Error).message }
    }
    this.env.toast(updateSummary(report))
    return report
  }

  /** The sheet of an update that waits for the user's agreement. */
  async reviewUpdate(profileId: string, extensionId: string): Promise<'updated' | 'declined' | 'none'> {
    const name = this.find(profileId, extensionId)?.name ?? t('extension-actions.l-extension')
    let outcome: 'updated' | 'declined' | 'none'
    try {
      outcome = await this.env.engine.reviewExtensionUpdate(profileId, extensionId)
    } catch (error) {
      console.error(`[extensions] cannot review the update of ${extensionId}:`, error)
      this.env.toast(t('extension-actions.la-mise-a-jour-de-name-a-echoue-reason', { name, reason: (error as Error).message }))
      return 'declined'
    }
    this.env.toast(outcome === 'updated' ? t('extension-actions.name-est-mise-a-jour', { name }) : outcome === 'none' ? t('extension-actions.aucune-mise-a-jour-n-attend-name', { name }) : t('extension-actions.la-mise-a-jour-de-name-n-est-pas-appliquee', { name }))
    return outcome
  }
}
