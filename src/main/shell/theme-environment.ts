import { clipboard } from 'electron'
import type { StateStore } from '../store'
import type { Browser } from './browser'
import type { ThemeEnvironment } from './theme-actions'
import { getLockService } from '../lock-service'

/** The theme buttons' view of a window: its state and toasts, and the system clipboard. */
export const themeEnvironment = (browser: Browser, store: StateStore): ThemeEnvironment => ({
  state: () => store.get(),
  dispatch: (action) => browser.dispatch(action),
  toast: (message, action) => browser.showToast(message, action),
  readClipboard: () => clipboard.readText(),
  writeClipboard: (text) => clipboard.writeText(text),
  isPrivate: () => browser.isPrivate(),
  lockedSpaces: () => getLockService()?.lockedSpaces() ?? []
})
