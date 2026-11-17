import { useState } from 'react'
import type { PlusAnchor } from '@shared/plus-menu'
import { hostOf } from '@shared/url'
import { api, useSnapshot } from './api'
import { Sheet, SheetField, StarGlyph, useSpaceHue } from './templates'
import { t } from '@shared/i18n'

/**
 * A favourite's name (its menu's Renommer…): the one a tile shows when the pointer rests on it, and the command bar lists. A sheet of the small editors,
 * hung from the tile when it knows it (`anchor`). Nothing is kept before "Enregistrer": Escape and "Annuler" leave the name as it was.
 */
export function FavoriteEditor({ favoriteId, anchor }: { favoriteId: string; anchor?: PlusAnchor }) {
  const snapshot = useSnapshot()
  const favorite = snapshot?.state.favorites.find((f) => f.id === favoriteId)
  const [name, setName] = useState<string | null>(null)
  const hue = useSpaceHue()
  const act = api()
  if (!snapshot || !favorite) return null

  const save = () => {
    // An empty name is the state's to refuse: the tile keeps its name.
    if (name !== null) void act.dispatch({ type: 'favorite/edit', id: favorite.id, patch: { title: name } })
    act.closeOverlay()
  }

  return (
    <Sheet title={t('favorite-editor.renommer-le-favori')} context={hostOf(favorite.url) || favorite.url} glyph={<StarGlyph />} hue={hue} anchor={anchor} side="bottom" onCancel={() => act.closeOverlay()} primary={{ label: t('templates.enregistrer') }} onSubmit={save}>
      <SheetField label={t('templates.nom')} help={favorite.url}>
        {(field) => <input className="tk-field" {...field} value={name ?? favorite.title} data-autofocus onChange={(e) => setName(e.target.value)} />}
      </SheetField>
    </Sheet>
  )
}
