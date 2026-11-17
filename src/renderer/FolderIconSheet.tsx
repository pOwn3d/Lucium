// « Icône… » of a folder's menu (shared/ipc.ts, panel `foldericon`): the picker of the spaces with its emoji tab alone. The emoji is kept at « Enregistrer »
// (`folder/icon`), « Retirer l'icône » gives the folder drawing back, Escape and « Annuler » leave the folder as it was. The state checks the emoji again.

import { useState } from 'react'
import { t } from '@shared/i18n'
import { emojiOnlyChoice } from '@shared/space-icon'
import { api, useSnapshot } from './api'
import { IconPicker } from './IconPicker'
import { FolderGlyph, Sheet, useSpaceHue } from './templates'

export function FolderIconSheet({ folderId }: { folderId: string }) {
  const snapshot = useSnapshot()
  const hue = useSpaceHue()
  const act = api()
  // The emoji picked and not saved yet; null until one is picked (the folder's own is then what shows).
  const [picked, setPicked] = useState<string | null>(null)
  const folder = snapshot?.state.folders.find((each) => each.id === folderId)
  if (!folder) return null

  const shown = picked ?? folder.icon ?? ''
  const save = () => {
    if (picked !== null) void act.dispatch({ type: 'folder/icon', id: folder.id, icon: picked })
    act.closeOverlay()
  }

  return (
    <Sheet
      title={t('folder-icon.icone-du-dossier')}
      context={folder.name}
      glyph={<FolderGlyph />}
      hue={hue}
      onCancel={() => act.closeOverlay()}
      primary={{ label: t('templates.enregistrer'), disabled: picked === null || picked === folder.icon }}
      onSubmit={save}
      footStart={
        folder.icon !== undefined ? (
          <button
            type="button"
            className="tk-btn quiet"
            onClick={() => {
              void act.dispatch({ type: 'folder/icon', id: folder.id, icon: null })
              act.closeOverlay()
            }}
          >
            {t('folder-icon.retirer-l-icone')}
          </button>
        ) : undefined
      }
    >
      <IconPicker emojiOnly choice={emojiOnlyChoice(shown)} onChange={(next) => setPicked(next.emoji)} />
      <p className="sh-help">{t('folder-icon.aide')}</p>
    </Sheet>
  )
}
