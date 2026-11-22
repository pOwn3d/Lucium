// The menu entries of "Rappel d'onglet": the presets of a tab's menu and the list of what waits, in File. Built from the pure rules of
// shared/tab-reminder.ts; the choice only dispatches `reminder/add`, `reminder/open` or `reminder/cancel` (the reducer decides).

import type { MenuItemConstructorOptions } from 'electron'
import { getLanguage, t } from '@shared/i18n'
import type { SidebarState } from '@shared/model'
import { REMINDER_PRESETS, reminderPresetLabel, reminderTime, reminderWhen, tabReminderNotice, tabReminderOutcome } from '@shared/tab-reminder'
import type { Browser } from './browser'

/** "Me le rappeler ▸ Ce soir / Demain matin / Dans une semaine" for the tab `tabId`; the toast says when the tab comes back, and "Annuler" brings it back now. */
export function reminderPresetItems(browser: Browser, store: StateSource, tabId: string): MenuItemConstructorOptions[] {
  return REMINDER_PRESETS.map((preset) => ({
    label: reminderPresetLabel(preset),
    click: () => {
      const before = store.get()
      const tab = before.tabs.find((tb) => tb.id === tabId)
      if (!tab) return
      const dueAt = reminderTime(preset, Date.now())
      const outcome = tabReminderOutcome(before.tabReminders, tab, dueAt, Date.now())
      browser.dispatch({ type: 'reminder/add', tabId, dueAt })
      const saved = store.get().tabReminders.find((r) => r.url === tab.url && r.dueAt === dueAt)
      browser.showToast(tabReminderNotice(outcome, reminderWhen(dueAt, getLanguage())), saved ? { label: t('menu.annuler'), run: () => reopenNow(browser, saved.id) } : undefined)
    }
  }))
}

/** What the menus read the state from (the store of the window). */
type StateSource = { get(): SidebarState }

const reopenNow = (browser: Browser, id: string): void => browser.dispatch({ type: 'reminder/open', id })

/** File › Rappels d'onglets: each pending reminder with its time, and for each "Ouvrir maintenant" and "Annuler le rappel". */
export function pendingReminderItems(browser: Browser, state: SidebarState): MenuItemConstructorOptions[] {
  if (state.tabReminders.length === 0) return [{ label: t('reminder.aucun-rappel'), enabled: false }]
  return state.tabReminders.map((r) => ({
    label: `${reminderWhen(r.dueAt, getLanguage())} — ${r.title}`,
    submenu: [
      { label: t('reminder.ouvrir-maintenant'), click: () => reopenNow(browser, r.id) },
      { label: t('reminder.annuler-le-rappel'), click: () => browser.dispatch({ type: 'reminder/cancel', id: r.id }) }
    ]
  }))
}
