// What is synchronised, field by field (docs/synchronisation.md §10.2, §10.3, §10.5). Every field of the five kinds of the model is in ONE of three classes:
//   synced  merged field by field (§11);
//   seed    copied when the entity is created on the other device, then local: the other device changes it without it coming back (the page a pinned tab is on is noise);
//   local   never sent (a file that only exists on the device, a runtime flag, the clock of the last use…).
// A field the model gains without a decision here is in no class: `field-classes.test.ts` lists the members of the five interfaces of model.ts and fails for it, so that a
// new field does not travel by default. A field a LATER version added crosses as opaque (§11.6) and is not in this table.

import { SYNCED_SETTING_KEYS } from '@shared/sidebar-sync'
import { TODAY_TAB_FIELD_CLASSES, TODAY_TAB_KIND } from '@shared/sync-today'

export type EntityKind = 'space' | 'folder' | 'tab' | 'favorite' | 'archived'

export interface FieldClass {
  synced: readonly string[]
  seed: readonly string[]
  local: readonly string[]
}

export const FIELD_CLASSES: Readonly<Record<EntityKind, FieldClass>> = {
  space: { synced: ['id', 'name', 'emoji', 'theme', 'profileId', 'hideHeader', 'iconKind', 'iconLetter', 'iconColor', 'iconRound'], seed: [], local: ['image', 'background', 'webPanels'] },
  folder: { synced: ['id', 'spaceId', 'name', 'parentId', 'atBottom', 'atTodayStart', 'noWake', 'icon'], seed: ['collapsed'], local: ['live'] },
  tab: {
    synced: ['id', 'spaceId', 'pinned', 'anchorUrl', 'customTitle', 'icon', 'folderId', 'keepAwake'],
    seed: ['url', 'title'],
    local: ['image', 'faviconUrl', 'deadKept', 'autoReload', 'container', 'windowKey', 'openerId', 'parentId', 'treeCollapsed', 'favoriteId', 'createdAt', 'lastActiveAt', 'private']
  },
  favorite: { synced: ['id', 'url', 'title', 'profileId'], seed: [], local: ['faviconUrl'] },
  archived: { synced: ['id', 'spaceId', 'url', 'title', 'archivedAt', 'source', 'pinned', 'anchorUrl', 'folderId'], seed: [], local: ['history', 'container'] }
}

/** The five kinds of the shared vectors (`sync-message-vectors.json`): the ones `FIELD_CLASSES` types. */
export const KINDS: readonly EntityKind[] = ['space', 'folder', 'tab', 'favorite', 'archived']

/**
 * Every kind of entity this version writes into the state: the five above and `todayTab` (§27.2), a projection of the open tabs of Today. Its classes are not in
 * `FIELD_CLASSES`, which is the table of the shared message vectors; they are those of the contract (`TODAY_TAB_FIELD_CLASSES`), with the fields only a pinned tab has counted
 * as local, so that a device cannot set them on a Today tab.
 */
export type SyncKind = EntityKind | typeof TODAY_TAB_KIND
export const SYNC_KINDS: readonly SyncKind[] = [...KINDS, TODAY_TAB_KIND]

export const isKind = (value: string): value is SyncKind => (SYNC_KINDS as readonly string[]).includes(value)

const TODAY_CLASSES: FieldClass = {
  synced: TODAY_TAB_FIELD_CLASSES.synced,
  seed: TODAY_TAB_FIELD_CLASSES.seed,
  local: [...TODAY_TAB_FIELD_CLASSES.local, ...TODAY_TAB_FIELD_CLASSES.notApplicable]
}

/** The classes of the fields of a kind. */
export const classesOf = (kind: SyncKind): FieldClass => (kind === TODAY_TAB_KIND ? TODAY_CLASSES : FIELD_CLASSES[kind])

/** The kinds that are code or secrets: never sent, never taken, whatever a device says (§10.5). */
export const NEVER_KINDS: readonly string[] = ['boost', 'userScript', 'extension', 'password', 'vault', 'lock', 'history', 'cookie', 'session']

/** The closed list of settings (§10.3): nothing is « every setting but these ». It is the list the reducer that writes them knows (shared/sidebar-sync.ts). */
export const SYNCED_SETTINGS = SYNCED_SETTING_KEYS
export type SyncedSetting = (typeof SYNCED_SETTINGS)[number]

/** The most archived tabs of one space that are sent: the latest (§10.1). */
export const ARCHIVE_PER_SPACE_SENT = 500
