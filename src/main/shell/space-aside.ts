// Espaces › Mettre l’espace de côté… (the menu bar, the space's menu and the command bar all come here): the user is asked first, because the pages
// of the space are closed (what was typed in them and not sent is lost), then the reducer's `space/aside` does the rest in one step. The notice
// that follows (shell/browser.ts) brings the space back in one click.

import { dialog, type BrowserWindow } from 'electron'
import { confirmButtons, type ConfirmButtons } from '@shared/confirm-box'
import { asideRefusal } from '@shared/sessions'
import { windowsAreIndependent, withEveryTab } from '@shared/window-tabs'
import type { SidebarState } from '@shared/model'
import type { StateStore } from '../store'
import type { Browser } from './browser'
import { t } from '@shared/i18n'

/**
 * The question, as the native box asks it. The pages are closed, and what was typed in them and not sent is lost: "Annuler" is the default button,
 * so that a Return typed at once does not close them.
 */
export function asideQuestion(name: string, tabCount: number): { message: string; detail: string } & ConfirmButtons {
  // A whole sentence for each case: no tab and one tab say no number, and the words agree with the count.
  const closed =
    tabCount === 0
      ? t('space-aside.il-n-a-aucun-onglet-et-garde-dans-une-session')
      : tabCount === 1
        ? t('space-aside.son-onglet-est-ferme-et-garde-dans-une-session')
        : t('space-aside.ses-count-onglets-sont-fermes-et-gardes-dans-une', { count: tabCount })
  return {
    message: t('space-aside.mettre-l-espace-name-de-cote', { name }),
    detail: `${closed} ${t('space-aside.les-pages-sont-rechargees-a-la-reouverture')}`,
    ...confirmButtons(t('space-aside.mettre-de-cote'), t('confirm-box.annuler'), true)
  }
}

/**
 * The state a window shows, with the tabs the other windows list: with windows that have tabs of their own, putting a space aside or deleting it closes
 * the tabs every window has in it, so the question counts them all.
 */
export function withEveryWindowsTabs(store: StateStore): SidebarState {
  const view = store.get()
  return windowsAreIndependent(view) ? withEveryTab(view, store.root().get()) : view
}

/**
 * Asks, then puts the space aside. A space that cannot be (the only one, 100 sessions, too many tabs) says why in a notice and nothing is asked.
 * `ask` is the question's answer (true to go on): the native box by default.
 */
export function asideSpace(browser: Browser, store: StateStore, win: BrowserWindow | undefined, spaceId: string, ask?: (question: ReturnType<typeof asideQuestion>) => boolean): void {
  const state = withEveryWindowsTabs(store)
  const refusal = asideRefusal(state, spaceId)
  if (refusal !== null) return browser.showToast(refusal)
  const space = state.spaces.find((s) => s.id === spaceId)!
  const question = asideQuestion(space.name, state.tabs.filter((t) => t.spaceId === spaceId).length)
  const confirmed = ask
    ? ask(question)
    : (win ? dialog.showMessageBoxSync(win, { type: 'question', ...question }) : dialog.showMessageBoxSync({ type: 'question', ...question })) === 0
  if (confirmed) browser.dispatch({ type: 'space/aside', id: spaceId })
}
