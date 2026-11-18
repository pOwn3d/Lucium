import { t } from '@shared/i18n'
import { api } from './api'
import { tipProps } from './tooltip'

/** Three lines: the button that stands for the menu bar of a window that has none. */
export const AppMenuIcon = () => (
  <svg viewBox="0 0 20 20" width={20} height={20} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3.500 6h13M3.500 10h13M3.500 14h13" />
  </svg>
)

/**
 * The button ☰ (Windows): the system's buttons lie over the window and the page draws its title bar, so the window has no menu bar; this opens the same menu, with
 * the same shortcuts, under the button. The main process reads the point again (`showAppMenu`).
 */
export function AppMenuButton({ className }: { className: string }) {
  return (
    <button
      className={`${className} app-menu-button`}
      aria-label={t('toolbar.menu-de-lucium')}
      aria-haspopup="menu"
      {...tipProps(t('toolbar.menu-de-lucium'))}
      onClick={(event) => {
        const { left, bottom } = event.currentTarget.getBoundingClientRect()
        api().showAppMenu({ x: left, y: bottom })
      }}
    >
      <AppMenuIcon />
    </button>
  )
}
