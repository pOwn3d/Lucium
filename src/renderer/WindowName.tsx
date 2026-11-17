import { useState } from 'react'
import type { PlusAnchor } from '@shared/plus-menu'
import { WINDOW_NAME_MAX } from '@shared/window-names'
import { api, useSnapshot } from './api'
import { Sheet, SheetField, WindowGlyph, useSpaceHue } from './templates'
import { t } from '@shared/i18n'

/**
 * Fenêtre › Nommer la fenêtre… : the name of this window, as the Window menu and the command bar list it. Empty gives the name back. A sheet of the
 * small editors: centred, or hung from `anchor` when the request knows the element that opened it.
 */
export function WindowName({ anchor }: { anchor?: PlusAnchor }) {
  const snapshot = useSnapshot()
  const [name, setName] = useState<string | null>(null)
  const hue = useSpaceHue()
  const act = api()
  if (!snapshot) return null

  const shown = name ?? snapshot.windowName ?? ''
  // The main process cleans the name and closes the panel.
  const commit = () => act.setWindowName(shown)

  return (
    <Sheet title={t('window-name.nommer-la-fenetre')} glyph={<WindowGlyph />} hue={hue} anchor={anchor} side="bottom" onCancel={() => act.closeOverlay()} primary={{ label: t('templates.enregistrer') }} onSubmit={commit}>
      <SheetField label={t('templates.nom')} help={t('window-name.le-nom-s-affiche-dans-le-menu-fenetre-et-dans')}>
        {(field) => <input className="tk-field" {...field} value={shown} maxLength={WINDOW_NAME_MAX} placeholder={t('window-name.sans-nom')} data-autofocus onChange={(e) => setName(e.target.value)} />}
      </SheetField>
    </Sheet>
  )
}
