import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { fr } from '@shared/i18n-fr'

/**
 * The keys no source reads: a key is read when its name is written somewhere between two single quotes (a count, `key.one` / `key.other`, is read by
 * its name without the ending). The names written in the sources are found in one reading: looking for each of the thousands of keys in turn reads
 * the whole source thousands of times.
 */
function unusedKeys(keys: readonly string[], sources: string): string[] {
  const quoted = new Set<string>()
  for (const [, name] of sources.matchAll(/'(?=([\w.-]+)')/g)) quoted.add(name!)
  // A key written with another character than the ones above is looked for as it is.
  const isRead = (name: string): boolean => (/^[\w.-]+$/.test(name) ? quoted.has(name) : sources.includes(`'${name}'`))
  return keys.filter((key) => !isRead(key.replace(/\.(one|other)$/, '')))
}

// The French catalogue is the list of the texts the interface reads: a key that no source file reads is a text nobody sees, and a sign that a conversion left a literal behind.
describe('the catalogue keys', () => {
  it('are all read by some source file', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const sources: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name) && !/^i18n-(fr|en)\.ts$/.test(name)) sources.push(readFileSync(path, 'utf8'))
      }
    }
    walk(root)
    const unused = unusedKeys(Object.keys(fr), sources.join('\n'))
    expect(unused, `Clés que le code ne lit pas : ${unused.join(', ')}`).toEqual([])
    // The whole of src is read from the disk, which a busy machine makes slow.
  }, 30_000)

  it('measures what it says: a key nobody reads is named, a count is read by its name without the ending, and a key that is only the end or the start of another name is not read', () => {
    const source = "t('menu.ouvrir')\nplural('menu.onglets', n)\nconst other = 'x.menu.fermer'\nt('menu.aide-longue')\nt('menu.l’aide')\nt('menu.nouveau' + suffix)"
    const keys = ['menu.ouvrir', 'menu.onglets.one', 'menu.onglets.other', 'menu.fermer', 'menu.aide', 'menu.l’aide', 'menu.l’oubli', 'menu.nouveau', 'menu.absent']
    expect(unusedKeys(keys, source)).toEqual(['menu.fermer', 'menu.aide', 'menu.l’oubli', 'menu.absent'])
  })
})
