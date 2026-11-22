// Passing ONE space with its tabs to another Mac, with no server: the space is written to a file (Espaces › Exporter cet espace…, sealed with a
// passphrase when the user wants) and read back on the other side (Espaces › Importer un espace…). It reuses the shape of a space put aside
// (`AsideSpace`, sessions.ts): the space, its folders, tabs, split views, the tab on screen and its archive.
//
// What does not travel, on purpose: cookies, storage and passwords (they are not in the state at all), the profile (the space lands on the default
// one: the cookies of this Mac's profile are not shared with a space that came from elsewhere), the pictures kept in the data folder (the space's
// picture, a media background, a tab's picture: they name files this Mac does not have), the containers, and the pages that stand for a favourite.

import type { SidebarState, Space, TabItem } from './model'
import { ASIDE_TABS_MAX, cleanAside, slimTab, asideOf } from './sessions'
import { t } from './i18n'

export const SPACE_TRANSFER_FORMAT = 'lucium-space'
export const SPACE_TRANSFER_VERSION = 1

/** The content of a transfer file: what puts the space back. */
export interface SpaceTransfer {
  format: typeof SPACE_TRANSFER_FORMAT
  version: typeof SPACE_TRANSFER_VERSION
  aside: NonNullable<ReturnType<typeof asideOf>>
}

/** The tab as it travels: without what only means something on the Mac it was made on. */
function portableTab(tab: TabItem): TabItem {
  const { container: _container, windowKey: _window, openerId: _opener, favoriteId: _favorite, image: _image, deadKept: _dead, ...rest } = slimTab(tab)
  return rest
}

function portableSpace(space: Space): Space {
  const { image: _image, ...rest } = space
  // A colour is a value; a picture, a GIF or a video is a file of this Mac's data folder.
  const background = space.background?.type === 'color' ? space.background : undefined
  const { background: _background, ...withoutBackground } = rest
  // The icon was the picture: it falls back to the emoji.
  const { iconKind, ...others } = withoutBackground
  const icon = iconKind === 'image' ? others : withoutBackground
  return { ...icon, profileId: 'default', ...(background ? { background } : {}) }
}

/** The aside, with the space made portable and what stays on this Mac left out; re-validated like any file (`cleanAside`). */
function portable(aside: NonNullable<ReturnType<typeof asideOf>>): NonNullable<ReturnType<typeof asideOf>> | undefined {
  return cleanAside({
    ...aside,
    space: portableSpace(aside.space),
    tabs: aside.tabs.filter((tab) => tab.favoriteId === undefined).map(portableTab),
    archive: aside.archive.map(({ container: _container, ...rest }) => rest)
  })
}

/** Why the space cannot be exported now (a sentence for the user), or null. A locked space would leave in the clear, and a huge one is refused whole. */
export function spaceTransferRefusal(state: SidebarState, spaceId: string, lockedSpaces: readonly string[]): string | null {
  if (!state.spaces.some((s) => s.id === spaceId)) return t('sessions.cet-espace-n-existe-plus')
  if (lockedSpaces.includes(spaceId)) return t('lock.deverrouillez-l-espace-d-abord')
  if (state.tabs.filter((tab) => tab.spaceId === spaceId).length > ASIDE_TABS_MAX) return t('sessions.cet-espace-a-plus-de-aside-tabs-max-onglets', { ASIDE_TABS_MAX })
  return null
}

/** The content of the file for the space, or null when the space is unknown. The caller checked `spaceTransferRefusal`. */
export function spaceTransferOf(state: SidebarState, spaceId: string): SpaceTransfer | null {
  const aside = asideOf(state, spaceId)
  const clean = aside && portable(aside)
  return clean ? { format: SPACE_TRANSFER_FORMAT, version: SPACE_TRANSFER_VERSION, aside: clean } : null
}

/** What a file chosen to be imported holds: the space to add, or the sentence that says why it is not one. */
export function parseSpaceTransfer(raw: unknown): { ok: true; aside: NonNullable<ReturnType<typeof asideOf>> } | { ok: false; message: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || (raw as { format?: unknown }).format !== SPACE_TRANSFER_FORMAT) return { ok: false, message: t('space-transfer.ce-fichier-n-est-pas-un-espace-exporte') }
  const version = (raw as { version?: unknown }).version
  if (typeof version !== 'number' || version > SPACE_TRANSFER_VERSION) return { ok: false, message: t('space-transfer.ce-fichier-vient-d-une-version-plus-recente') }
  const read = cleanAside((raw as { aside?: unknown }).aside)
  const aside = read && portable(read)
  return aside ? { ok: true, aside } : { ok: false, message: t('space-transfer.ce-fichier-ne-contient-aucun-espace-lisible') }
}
