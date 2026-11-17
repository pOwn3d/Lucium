// A document that sends the reader to « Réglages › X » names a category the Settings window has. The window was cut again more than once (the 14
// categories, then 16, then the 8 of today), and the documents kept paths to panes that were gone: « Réglages › Avancé », « Réglages › Raccourcis ».

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { tIn, type Language, type MessageKey } from '@shared/i18n'
import { SETTINGS_PAGES } from '@shared/ipc'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** The documents a reader follows today. The changelogs are left out: an entry says where a setting was when its version came out. */
function documents(): string[] {
  const markdown = (folder: string): string[] =>
    readdirSync(join(ROOT, folder))
      .filter((name) => name.endsWith('.md') && !name.startsWith('CHANGELOG'))
      .map((name) => join(folder, name))
  return [...markdown('.'), ...markdown('docs'), ...markdown('docs/community')].sort()
}

const categories = (language: Language): string[] => SETTINGS_PAGES.map((pane) => tIn(language, `settings.cat-${pane}` as MessageKey))

/**
 * What may follow « Réglages › » without being a category: the entry of the command bar that opens the guided setup, which the command bar itself
 * writes « Réglages › Régler en quelques questions », by the name of the guide.
 */
const NOT_A_CATEGORY: Readonly<Record<Language, readonly string[]>> = { fr: [tIn('fr', 'guide.configuration-rapide')], en: [tIn('en', 'guide.configuration-rapide')] }

/** The paths of a text that name no category: « Réglages › Avancé › Extensions » gives "Réglages › Avancé". */
export function stalePaths(text: string, language: Language): string[] {
  // "System Settings › …" is the system's own window, not ours.
  // The rest of the path is looked at without being consumed: « Réglages › A ; puis Réglages › B » is two paths.
  const pattern = language === 'fr' ? /Réglages › (?=([^\n›]{0,60}))/g : /(?<!System )Settings › (?=([^\n›]{0,60}))/g
  const known = [...categories(language), ...NOT_A_CATEGORY[language]]
  return [...text.matchAll(pattern)].filter(([, rest]) => !known.some((name) => rest!.startsWith(name))).map(([whole, rest]) => whole + rest!.split(/[*).,;:»”|(]/)[0]!.trim())
}

describe('the paths to the Settings in the documents', () => {
  it('has the eleven pages the test knows the names of, in both languages', () => {
    expect(categories('fr')).toEqual(['Pour commencer', 'Apparence', 'Onglets et fenêtres', 'Navigation', 'Vie privée et sécurité', 'Téléchargements et fichiers', 'Extensions et outils', 'Clavier et souris', 'Profils', 'Fonctions en option', 'À propos et mises à jour'])
    expect(categories('en')).toEqual(['Start here', 'Appearance', 'Tabs and windows', 'Navigation', 'Privacy and security', 'Downloads and files', 'Extensions and tools', 'Keyboard and mouse', 'Profiles', 'Optional features', 'About and updates'])
  })

  it('tells a path to a pane that is gone from one to a category, a group of it, the guided setup or the system’s own settings', () => {
    expect(stalePaths('voir **Réglages › Avancé › Extensions** et Réglages › Raccourcis ; puis Réglages › Protection.', 'fr')).toEqual(['Réglages › Avancé', 'Réglages › Raccourcis', 'Réglages › Protection'])
    expect(stalePaths('Réglages › Vie privée et sécurité › API matérielles du web, Réglages › Apparence au groupe de la taille, « Réglages › Régler en quelques questions »', 'fr')).toEqual([])
    expect(stalePaths('open *System Settings › Privacy & Security*, then Settings › Start here › Language', 'en')).toEqual([])
    expect(stalePaths('Settings › General › Language', 'en')).toEqual(['Settings › General'])
    expect(stalePaths('Settings › Advanced › Mini Window', 'en')).toEqual(['Settings › Advanced'])
  })

  it('finds none in the documents: every « Réglages › … » and “Settings › …” starts with a category of today', () => {
    const stale: string[] = []
    for (const file of documents()) {
      const text = readFileSync(join(ROOT, file), 'utf8')
      for (const language of ['fr', 'en'] as const) for (const path of stalePaths(text, language)) stale.push(`${file}: ${path}`)
    }
    expect(documents().length).toBeGreaterThan(10)
    expect(stale).toEqual([])
  })
})
