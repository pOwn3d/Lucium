import { describe, expect, it } from 'vitest'
import { frenchSpaces, NARROW_NBSP, NBSP, plainSpaces } from './french-typography'
import { fr } from './i18n-fr'
import { createTranslator, quoted, tIn, type MessageKey } from './i18n'
import { foldAccents, foldAccentsAndQuotes, foldMarks } from './fold'

describe('the spaces of French typography', () => {
  it('puts a no-break space before a colon and a percent sign, and inside the quotation marks', () => {
    expect(frenchSpaces('Attention : la page')).toBe(`Attention${NBSP}: la page`)
    expect(frenchSpaces('Texte à {percent} %')).toBe(`Texte à {percent}${NBSP}%`)
    expect(frenchSpaces('100 % (opaque)')).toBe(`100${NBSP}% (opaque)`)
    expect(frenchSpaces('Supprimer « {name} » ?')).toBe(`Supprimer «${NBSP}{name}${NBSP}»${NARROW_NBSP}?`)
  })

  it('puts a narrow no-break space before a semicolon, a question mark and an exclamation mark', () => {
    expect(frenchSpaces('Quitter Lucium ?')).toBe(`Quitter Lucium${NARROW_NBSP}?`)
    expect(frenchSpaces('démarrer seul ; Lucium')).toBe(`démarrer seul${NARROW_NBSP}; Lucium`)
    expect(frenchSpaces('Profil manquant !')).toBe(`Profil manquant${NARROW_NBSP}!`)
    expect(frenchSpaces('(pas de connexion ?)')).toBe(`(pas de connexion${NARROW_NBSP}?)`)
    expect(frenchSpaces(' ; ')).toBe(`${NARROW_NBSP}; `)
  })

  it('keeps a number with its unit, and the thousands of a number together', () => {
    expect(frenchSpaces('{hours} h')).toBe(`{hours}${NBSP}h`)
    expect(frenchSpaces('toutes les 30 s.')).toBe(`toutes les 30${NBSP}s.`)
    expect(frenchSpaces(' ({size} Ko)')).toBe(` ({size}${NBSP}Ko)`)
    expect(frenchSpaces('1 à 1 024 caractères')).toBe(`1 à 1${NARROW_NBSP}024 caractères`)
  })

  it('leaves alone what only looks like punctuation or a unit', () => {
    expect(frenchSpaces('tapez !w puis un mot')).toBe('tapez !w puis un mot')
    expect(frenchSpaces('l’adresse ::1')).toBe('l’adresse ::1')
    expect(frenchSpaces('{count} s’ouvrent')).toBe('{count} s’ouvrent')
    expect(frenchSpaces('{count} sites')).toBe('{count} sites')
    expect(frenchSpaces('https://exemple.fr/a?b')).toBe('https://exemple.fr/a?b')
  })

  it('gives back unchanged a text that already has its spaces', () => {
    const once = frenchSpaces('Vider « {name} » : sûr ? 100 %')
    expect(frenchSpaces(once)).toBe(once)
  })

  it('makes them ordinary again for a comparison', () => {
    expect(plainSpaces(frenchSpaces('Vider « {name} » : sûr ?'))).toBe('Vider « {name} » : sûr ?')
  })
})

describe('the French interface', () => {
  // An ordinary space the line could break on, before a high punctuation mark or inside the quotation marks.
  const BREAKABLE = / [:;!?%»](?=$|[\s)\]»,.…])|« /m

  it('shows no text a line could break before « : ; ! ? % » or inside « »', () => {
    const broken = (Object.keys(fr) as MessageKey[]).filter((key) => BREAKABLE.test(tIn('fr', key)))
    expect(broken).toEqual([])
  })

  it('is typed with ordinary spaces in its catalogue: the translator alone puts the others in', () => {
    const typed = Object.entries(fr).filter(([, text]) => /[  ]/.test(text)).map(([key]) => key)
    expect(typed).toEqual([])
    expect(fr['app.quitter-lucium']).toBe('Quitter Lucium ?')
    expect(tIn('fr', 'app.quitter-lucium')).toBe(`Quitter Lucium${NARROW_NBSP}?`)
  })

  it('leaves the English texts and the variables as they are', () => {
    const catalogues = { fr: { a: 'Site : {name}', b: 'Sûr ?' }, en: { a: 'Site : {name}' } }
    const reports: string[] = []
    const french = createTranslator('fr', catalogues, (message) => reports.push(message)) as unknown as (key: string, vars?: Record<string, string>) => string
    const english = createTranslator('en', catalogues, (message) => reports.push(message)) as unknown as (key: string, vars?: Record<string, string>) => string
    expect(french('a', { name: 'a : b ?' })).toBe(`Site${NBSP}: a : b ?`)
    expect(english('a', { name: 'x' })).toBe('Site : x')
    // A key English lacks is read in French, with the spaces of French.
    expect(english('b')).toBe(`Sûr${NARROW_NBSP}?`)
  })

  it('quotes a name with no-break spaces inside the marks', () => {
    expect(quoted('Travail', 'fr')).toBe(`«${NBSP}Travail${NBSP}»`)
    expect(quoted('Work', 'en')).toBe('“Work”')
  })

  it('is found by a search typed with ordinary spaces', () => {
    const label = tIn('fr', 'app.quitter-lucium')
    for (const fold of [foldAccents, foldAccentsAndQuotes, foldMarks]) expect(fold(label)).toBe('quitter lucium ?')
  })
})
