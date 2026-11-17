import { afterEach, describe, expect, it } from 'vitest'
import { defaultSettings } from './model'
import { setLanguage } from './i18n'
import {
  ATTACHMENTS_HOST,
  CATALOGUE_HOST,
  CATALOGUE_LIMITS,
  PACK_LIMITS,
  RUNTIME_CATALOGUE_URL,
  RUNTIME_FILE_NAME,
  RUNTIME_LIMITS,
  RUNTIME_MAJOR,
  DEFAULT_PACE,
  TRANSLATE_LIMITS,
  batchIndices,
  planBatches,
  readingOrder,
  usableOffsets,
  catalogueUrl,
  checkReply,
  cleanTranslateSettings,
  detectFromText,
  detectLanguage,
  filterHolds,
  formatSize,
  isLanguageCode,
  isTranslatable,
  parseCatalogue,
  parseManifest,
  parseRuntimeCatalogue,
  parseTranslateRequest,
  planRoute,
  primaryLanguage,
  proposedPair,
  roleOfFileName,
  splitPadding,
  targetLanguage,
  usablePacks,
  type PackEngine,
  type PackRef
} from './translate-local'

afterEach(() => setLanguage('fr'))

const HASH = 'a'.repeat(64)
const file = (role: string, name: string, over: Record<string, unknown> = {}) => ({ role, name, size: 1000, sha256: HASH, ...over })
const manifest = (over: Record<string, unknown> = {}) => ({ schema: 1, engine: 'bergamot', from: 'fr', to: 'en', version: '2.1', files: [file('model', 'model.fren.bin'), file('vocab', 'vocab.fren.spm')], ...over })

describe('the settings', () => {
  it('start on (the entry is offered only for a page in another language), with the interface language as target and the application folder', () => {
    const settings = defaultSettings()
    expect(settings.translateLocal).toBe(true)
    expect(settings.translateTarget).toBe('auto')
    expect(settings.translateModelsDir).toBe('')
  })

  it('are read back strictly: the switch is on only for true, the target is auto or a code, the folder is an absolute path', () => {
    const clean = (patch: Record<string, unknown>) => cleanTranslateSettings({ ...defaultSettings(), ...patch } as never)
    expect(clean({ translateLocal: 'yes' }).translateLocal).toBe(false)
    expect(clean({ translateLocal: true }).translateLocal).toBe(true)
    for (const bad of ['FR', 'français', 'f', 'fr-CA', '', 3, null]) expect(clean({ translateTarget: bad }).translateTarget).toBe('auto')
    expect(clean({ translateTarget: 'de' }).translateTarget).toBe('de')
    for (const bad of ['relatif/dossier', '../x', '~/x', 'file:///x', `/${'a'.repeat(1030)}`, '/ok\nnon', 7, null]) expect(clean({ translateModelsDir: bad }).translateModelsDir).toBe('')
    expect(clean({ translateModelsDir: '/Users/moi/Modèles' }).translateModelsDir).toBe('/Users/moi/Modèles')
    expect(clean({ translateModelsDir: 'C:\\Modeles' }).translateModelsDir).toBe('C:\\Modeles')
  })

  it('translate into the chosen language, else the language of the interface', () => {
    expect(targetLanguage({ translateTarget: 'auto' }, 'en')).toBe('en')
    expect(targetLanguage({ translateTarget: 'de' }, 'en')).toBe('de')
  })

  it('read language tags', () => {
    expect(primaryLanguage('fr-CA')).toBe('fr')
    expect(primaryLanguage('ZH_hans')).toBe('zh')
    for (const none of ['', 'und', 'x-klingon', 'zxx', 'mul', 'français', 3, null, 'f'.repeat(40)]) expect(primaryLanguage(none)).toBeNull()
    expect(isLanguageCode('fil')).toBe(true)
    expect(isLanguageCode('Fr')).toBe(false)
  })
})

describe('detecting the language of a page', () => {
  const samples: Record<string, string> = {
    fr: 'Le gouvernement a annoncé hier que les nouvelles mesures seront appliquées dans toutes les régions, et que les habitants pourront les consulter sur le site officiel.',
    en: 'The government announced yesterday that the new measures will be applied in all the regions, and that residents will be able to read them on the official website.',
    es: 'El gobierno anunció ayer que las nuevas medidas se aplicarán en todas las regiones, y que los habitantes podrán consultarlas en el sitio oficial de la ciudad.',
    de: 'Die Regierung hat gestern angekündigt, dass die neuen Maßnahmen in allen Regionen angewendet werden und dass die Einwohner sie auf der offiziellen Seite lesen können.',
    it: 'Il governo ha annunciato ieri che le nuove misure saranno applicate in tutte le regioni, e che gli abitanti potranno consultarle sul sito ufficiale della città.',
    pt: 'O governo anunciou ontem que as novas medidas serão aplicadas em todas as regiões, e que os habitantes poderão consultá-las no site oficial da cidade.',
    nl: 'De regering heeft gisteren aangekondigd dat de nieuwe maatregelen in alle regio’s zullen worden toegepast en dat de inwoners ze op de officiële website kunnen lezen.'
  }

  it('names the language of a few sentences written in one of the languages it knows', () => {
    for (const [code, sample] of Object.entries(samples)) expect(detectFromText(sample).language, code).toBe(code)
  })

  it('names the languages whose script says it', () => {
    expect(detectFromText('これは日本語のテキストです。ページの言語を判定するためのサンプルです。').language).toBe('ja')
    expect(detectFromText('이것은 페이지의 언어를 알아내기 위한 한국어 문장 예시입니다. 충분히 긴 문장입니다.').language).toBe('ko')
    expect(detectFromText('这是一个用来判断网页语言的中文例句，长度足够用来识别这种语言。').language).toBe('zh')
    expect(detectFromText('Это пример текста на русском языке, достаточно длинный для определения языка страницы.').language).toBe('ru')
    expect(detectFromText('Це приклад тексту українською мовою, достатньо довгий для визначення мови сторінки, їжак.').language).toBe('uk')
  })

  it('says nothing rather than something wrong: too little text, numbers, a language it does not know', () => {
    expect(detectFromText('Bonjour').language).toBeNull()
    expect(detectFromText('1234 5678 9012 3456 7890 1234 5678 9012 3456 7890 1234 5678 9012').language).toBeNull()
    expect(detectFromText('Ez egy magyar nyelvű mondat, amelyet az egyszerű felismerő nem ismer fel, mert nincsenek benne a megszokott szavak.').language).toBeNull()
  })

  it('trusts the words over a page that declares another language, and the declaration when the words say nothing', () => {
    expect(detectLanguage(samples['fr']!, 'en')).toMatchObject({ language: 'fr', source: 'text' })
    expect(detectLanguage(samples['fr']!, 'fr-FR')).toEqual({ language: 'fr', source: 'declared', confidence: 1 })
    expect(detectLanguage('Menu', 'de-AT')).toEqual({ language: 'de', source: 'declared', confidence: 0.6 })
    expect(detectLanguage('Menu', '')).toEqual({ language: null, source: 'none', confidence: 0 })
    expect(detectLanguage('', 'x-unknown').language).toBeNull()
  })

  it('remembers what the page declared when the words overrule it, and only then', () => {
    expect(detectLanguage(samples['fr']!, 'en-US')).toMatchObject({ language: 'fr', source: 'text', declared: 'en' })
    expect(detectLanguage(samples['fr']!, '')).not.toHaveProperty('declared')
    expect(detectLanguage(samples['fr']!, 'fr')).not.toHaveProperty('declared')
    expect(detectLanguage('Menu', 'de-AT')).not.toHaveProperty('declared')
  })
})

// The pair the panel proposes: the panel is opened from « Traduire cette page… », and a button that cannot be pressed is a dead end.
describe('the pair proposed for a page', () => {
  const page = (language: string | null, declared?: string) => ({ language, source: language === null ? ('none' as const) : ('text' as const), confidence: 1, ...(declared !== undefined ? { declared } : {}) })

  it('is the language of the page into the target when they differ', () => {
    expect(proposedPair(page('en'), 'fr', 'fr')).toEqual({ from: 'en', to: 'fr' })
    expect(proposedPair(page('de'), 'en', 'fr')).toEqual({ from: 'de', to: 'en' })
  })

  it('leaves the language of the page open when it was not recognised', () => {
    expect(proposedPair(page(null), 'fr', 'fr')).toEqual({ from: '', to: 'fr' })
  })

  // THE GUARD: a pair that goes nowhere (the same language on both sides) is never proposed, whatever the page says.
  it('follows the language the page declares when its words are in the target language (the menu offered the translation because of it)', () => {
    expect(proposedPair(page('fr', 'en'), 'fr', 'fr')).toEqual({ from: 'en', to: 'fr' })
  })

  it('proposes the language of the interface, else English, as the target of a page already in the target language', () => {
    expect(proposedPair(page('fr'), 'fr', 'fr')).toEqual({ from: 'fr', to: 'en' })
    expect(proposedPair(page('fr'), 'fr', 'en')).toEqual({ from: 'fr', to: 'en' })
    expect(proposedPair(page('es'), 'es', 'fr')).toEqual({ from: 'es', to: 'fr' })
    expect(proposedPair(page('en'), 'en', 'en')).toEqual({ from: 'en', to: 'fr' })
  })

  it('never goes from a language into itself', () => {
    for (const detected of ['fr', 'en', 'es', 'de', 'ja', null]) {
      for (const target of ['fr', 'en', 'es', 'de', 'ja']) {
        for (const ui of ['fr', 'en']) {
          for (const declared of [undefined, 'fr', 'en', 'es']) {
            const pair = proposedPair(page(detected, declared), target, ui)
            if (pair.from !== '') expect(pair.from, JSON.stringify([detected, target, ui, declared])).not.toBe(pair.to)
            expect(pair.to).not.toBe('')
          }
        }
      }
    }
  })
})

describe('which text of a page is translated', () => {
  it('keeps the spacing of the page and translates only the words', () => {
    expect(splitPadding('  Bonjour le monde \n')).toEqual({ lead: '  ', core: 'Bonjour le monde', trail: ' \n' })
    expect(splitPadding('')).toEqual({ lead: '', core: '', trail: '' })
    expect(splitPadding(' \n ')).toEqual({ lead: ' \n ', core: '', trail: '' })
  })

  it('leaves out what has no words in it', () => {
    for (const no of ['', 'x', '123', '12 345,6', '—', 'https://exemple.org/a', 'www.exemple.org', 'moi@exemple.org', 'x '.repeat(TRANSLATE_LIMITS.nodeChars)]) expect(isTranslatable(no), no.slice(0, 20)).toBe(false)
    for (const yes of ['ab', 'Ça va ?', 'Version 2 disponible', '日本語']) expect(isTranslatable(yes), yes).toBe(true)
  })

  it('groups texts for the engine within the size and the count it takes, in order, none lost', () => {
    const lengths = [100, 2000, 2000, 50, 10]
    const batches = batchIndices(lengths, 3000, 3)
    expect(batches).toEqual([[0, 1], [2, 3, 4]])
    expect(batches.flat()).toEqual([0, 1, 2, 3, 4])
    expect(batchIndices([], 3000, 3)).toEqual([])
    // A text longer than a group goes alone, whole.
    expect(batchIndices([5000, 5], 3000, 48)).toEqual([[0], [1]])
    expect(batchIndices(Array(100).fill(1), 3000, 48).map((b) => b.length)).toEqual([48, 48, 4])
  })

  it('cuts a small first batch (what is on screen comes back soon), then larger ones, in order, none lost', () => {
    const pace = { inFlight: 3, first: { chars: 100, items: 2 }, next: { chars: 1000, items: 4 } }
    const batches = planBatches([40, 40, 40, 10, 10, 10, 10, 900, 200], pace)
    expect(batches).toEqual([[0, 1], [2, 3, 4, 5], [6, 7], [8]])
    expect(batches.flat()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
    // A first text longer than the first batch goes alone, whole.
    expect(planBatches([500, 5, 5], pace)).toEqual([[0], [1, 2]])
    expect(planBatches([], pace)).toEqual([])
    // Without a pace, the batches of the models engine (Bergamot), one at a time.
    expect(DEFAULT_PACE).toEqual({ inFlight: 1, first: { chars: TRANSLATE_LIMITS.batchChars, items: TRANSLATE_LIMITS.batchItems }, next: { chars: TRANSLATE_LIMITS.batchChars, items: TRANSLATE_LIMITS.batchItems } })
    expect(planBatches(Array(100).fill(1))).toEqual(batchIndices(Array(100).fill(1)))
  })

  it('translates what is on screen first, then by distance to the viewport (below first at the same distance), the hidden texts last', () => {
    //                 0     1    2  3    4     5   6   7
    const offsets = [-900, null, 0, 300, -300, 0, 50, null]
    expect(readingOrder(offsets)).toEqual([2, 5, 6, 3, 4, 0, 1, 7])
    // Nothing known: the page's order.
    expect(readingOrder([null, null, null])).toEqual([0, 1, 2])
    expect(readingOrder([])).toEqual([])
    // Every position once.
    const many = Array.from({ length: 500 }, (_, i) => (i % 7 === 0 ? null : ((i * 37) % 1000) - 500))
    expect([...readingOrder(many)].sort((a, b) => a - b)).toEqual(many.map((_, i) => i))
  })

  it('takes the offsets the page script gave only when they are one finite number or null for each text', () => {
    expect(usableOffsets([0, -12, 40, null], 4)).toEqual([0, -12, 40, null])
    for (const raw of [undefined, null, 'x', [0, 1], [0, 1, 2, 3, 4], [0, NaN, 1, 2], [0, Infinity, 1, 2], [0, '1', 1, 2], [0, {}, 1, 2]]) expect(usableOffsets(raw, 4), JSON.stringify(raw)).toEqual([null, null, null, null])
  })

  // The engine is code we did not write, or a pack made to misbehave: its answer is checked before it reaches the page.
  it('accepts an answer that is one text for each text sent, and refuses any other', () => {
    const sent = ['Bonjour', 'Le monde']
    expect(checkReply(sent, ['Hello', 'The world'])).toEqual(['Hello', 'The world'])
    expect(checkReply(sent, ['Hello\nworld\t!', 'x'])).toEqual(['Hello\nworld\t!', 'x'])
    for (const bad of [null, 'Hello', ['Hello'], ['a', 'b', 'c'], ['a', 3], ['a', null], ['a', 'b\u0000'], ['a', 'b\u001b[31m'], ['a', 'x'.repeat(8 * 4 + 201)]]) expect(checkReply(sent, bad), JSON.stringify(bad)).toBeNull()
    expect(checkReply([], [])).toEqual([])
  })
})

describe('the manifest of a pack', () => {
  it('accepts a complete one and keeps nothing beyond its schema', () => {
    expect(parseManifest(manifest())).toEqual(manifest())
    expect(parseManifest(manifest({ engine: 'glossary', files: [file('glossary', 'fr-en.glossary.json')] }))).not.toBeNull()
    expect(parseManifest(manifest({ files: [file('model', 'm.bin'), file('srcvocab', 's.spm'), file('trgvocab', 't.spm'), file('lex', 'l.bin')] }))).not.toBeNull()
  })

  it('refuses anything else: a field more or less, a bad value, a name that leaves the folder, a file twice, a pack that cannot translate', () => {
    const refused: Array<[string, unknown]> = [
      ['not an object', 'x'],
      ['an array', []],
      ['an extra key', { ...manifest(), extra: 1 }],
      ['no version', (({ version: _v, ...rest }) => rest)(manifest())],
      ['other schema', manifest({ schema: 2 })],
      ['unknown engine', manifest({ engine: 'google' })],
      ['same language', manifest({ to: 'fr' })],
      ['bad language', manifest({ from: 'FR' })],
      ['bad version', manifest({ version: '2.x' })],
      ['no files', manifest({ files: [] })],
      ['too many files', manifest({ files: Array.from({ length: PACK_LIMITS.files + 1 }, (_, i) => file(i === 0 ? 'model' : 'vocab', `f${i}.bin`)) })],
      ['an extra key on a file', manifest({ files: [file('model', 'm.bin', { url: 'http://x' }), file('vocab', 'v.spm')] })],
      ['a path as a name', manifest({ files: [file('model', '../m.bin'), file('vocab', 'v.spm')] })],
      ['a subfolder', manifest({ files: [file('model', 'a/m.bin'), file('vocab', 'v.spm')] })],
      ['a hidden file', manifest({ files: [file('model', '.m.bin'), file('vocab', 'v.spm')] })],
      ['the manifest itself', manifest({ files: [file('model', 'manifest.json'), file('vocab', 'v.spm')] })],
      ['an unknown role', manifest({ files: [file('weights', 'm.bin'), file('vocab', 'v.spm')] })],
      ['a bad fingerprint', manifest({ files: [file('model', 'm.bin', { sha256: 'xyz' }), file('vocab', 'v.spm')] })],
      ['an upper-case fingerprint', manifest({ files: [file('model', 'm.bin', { sha256: 'A'.repeat(64) }), file('vocab', 'v.spm')] })],
      ['an empty file', manifest({ files: [file('model', 'm.bin', { size: 0 }), file('vocab', 'v.spm')] })],
      ['a fractional size', manifest({ files: [file('model', 'm.bin', { size: 10.5 }), file('vocab', 'v.spm')] })],
      ['a file too big', manifest({ files: [file('model', 'm.bin', { size: PACK_LIMITS.fileBytes + 1 }), file('vocab', 'v.spm')] })],
      ['a pack too big', manifest({ files: [file('model', 'm.bin', { size: PACK_LIMITS.fileBytes }), file('lex', 'l.bin', { size: PACK_LIMITS.fileBytes }), file('vocab', 'v.spm', { size: PACK_LIMITS.fileBytes })] })],
      ['the same name twice', manifest({ files: [file('model', 'm.bin'), file('vocab', 'm.bin')] })],
      ['the same role twice', manifest({ files: [file('model', 'm.bin'), file('model', 'n.bin'), file('vocab', 'v.spm')] })],
      ['no model', manifest({ files: [file('vocab', 'v.spm')] })],
      ['no vocabulary', manifest({ files: [file('model', 'm.bin')] })],
      ['one vocabulary of two', manifest({ files: [file('model', 'm.bin'), file('srcvocab', 's.spm')] })],
      ['a glossary pack without a glossary', manifest({ engine: 'glossary' })]
    ]
    for (const [why, value] of refused) expect(parseManifest(value), why).toBeNull()
  })

  it('names the role of the files of a model by their name', () => {
    expect(roleOfFileName('model.enfr.intgemm.alphas.bin')).toBe('model')
    expect(roleOfFileName('lex.50.50.enfr.s2t.bin')).toBe('lex')
    expect(roleOfFileName('vocab.enfr.spm')).toBe('vocab')
    expect(roleOfFileName('srcvocab.enfr.spm')).toBe('srcvocab')
    expect(roleOfFileName('trgvocab.enfr.spm')).toBe('trgvocab')
    expect(roleOfFileName('fr-en.glossary.json')).toBe('glossary')
    for (const none of ['manifest.json', 'readme.txt', '../model.bin', 'a/model.bin', '.model.bin', 'models.bin']) expect(roleOfFileName(none), none).toBeNull()
  })
})

describe('the catalogue of models', () => {
  const PACKED = 'b'.repeat(64)
  // A record of the v2 collection: the attachment is the file compressed with zstd, the record says what it decompresses into.
  const record = (fileType: string, version: string, over: Record<string, unknown> = {}, attachment: Record<string, unknown> = {}) => ({
    fromLang: 'fr',
    toLang: 'en',
    fileType,
    version,
    name: `${fileType}.fren.bin`,
    decompressedHash: HASH,
    decompressedSize: 1_000_000,
    filter_expression: '',
    attachment: { hash: PACKED, size: 400_000, filename: `${fileType}.fren.bin.zst`, location: `main-workspace/translations-models/${fileType}-${version}.zst`, mimetype: 'application/zstd', ...attachment },
    ...over
  })
  const records = [record('model', '3.0'), record('model', '3.1'), record('lex', '3.1'), record('vocab', '3.1'), record('lex', '3.0'), record('vocab', '3.0'), record('model', '2.1'), record('model', '4.0'), record('model', '3.1', { fromLang: 'en', toLang: 'fr' })]

  it('says which two servers the function speaks to, and the exact addresses of the lists', () => {
    expect(CATALOGUE_HOST).toBe('firefox.settings.services.mozilla.com')
    expect(ATTACHMENTS_HOST).toBe('firefox-settings-attachments.cdn.mozilla.net')
    expect(catalogueUrl('fr', 'en')).toBe('https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/translations-models-v2/records?fromLang=fr&toLang=en')
    expect(RUNTIME_CATALOGUE_URL).toBe('https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/translations-wasm-v2/records?name=bergamot-translator')
  })

  it('makes a plan of the newest complete version of the supported major version, for the pair asked, with where each file comes from and what it weighs', () => {
    const parsed = parseCatalogue({ data: records }, 'fr', 'en')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.plan).toMatchObject({ engine: 'bergamot', from: 'fr', to: 'en', version: '3.1', totalBytes: 1_200_000, diskBytes: 3_000_000 })
    expect(parsed.plan.files.map((f) => [f.role, f.url, f.name])).toEqual([
      ['model', 'https://firefox-settings-attachments.cdn.mozilla.net/main-workspace/translations-models/model-3.1.zst', 'model.fren.bin'],
      ['lex', 'https://firefox-settings-attachments.cdn.mozilla.net/main-workspace/translations-models/lex-3.1.zst', 'lex.fren.bin'],
      ['vocab', 'https://firefox-settings-attachments.cdn.mozilla.net/main-workspace/translations-models/vocab-3.1.zst', 'vocab.fren.bin']
    ])
    // Two fingerprints per file: the decompressed file kept, and the compressed one that travels.
    expect(parsed.plan.files.every((f) => f.sha256 === HASH && f.size === 1_000_000 && f.transfer?.sha256 === PACKED && f.transfer.size === 400_000 && f.transfer.encoding === 'zstd')).toBe(true)
    // What the plan makes is a manifest the store accepts.
    expect(parseManifest({ schema: 1, engine: 'bergamot', from: 'fr', to: 'en', version: parsed.plan.version, files: parsed.plan.files.map(({ role, name, size, sha256 }) => ({ role, name, size, sha256 })) })).not.toBeNull()
  })

  it('never mixes the files of two versions: a newer version that lacks a file gives way to the older complete one', () => {
    const parsed = parseCatalogue({ data: [record('model', '3.2'), record('model', '3.0'), record('vocab', '3.0')] }, 'fr', 'en')
    expect(parsed.ok && parsed.plan.version).toBe('3.0')
    if (parsed.ok) expect(parsed.plan.files.map((f) => f.url)).toEqual(['https://firefox-settings-attachments.cdn.mozilla.net/main-workspace/translations-models/model-3.0.zst', 'https://firefox-settings-attachments.cdn.mozilla.net/main-workspace/translations-models/vocab-3.0.zst'])
  })

  it('takes the records a release build gets, and skips those Mozilla keeps for Nightly, for Android or for anything it cannot read', () => {
    const nightly = (type: string) => record(type, '3.2', { filter_expression: "env.channel == 'default' || env.channel == 'nightly'" })
    const parsed = parseCatalogue({ data: [nightly('model'), nightly('vocab'), record('model', '3.1', { filter_expression: "env.appinfo.OS != 'Android' || env.channel != 'release'" }), record('vocab', '3.1', { filter_expression: null })] }, 'fr', 'en')
    expect(parsed.ok && parsed.plan.version).toBe('3.1')
    expect(parseCatalogue({ data: [nightly('model'), nightly('vocab')] }, 'fr', 'en').ok).toBe(false)
  })

  it('needs both fingerprints of a file: a record without what it decompresses into is not a file it can check', () => {
    const blind = (type: string) => {
      const { decompressedHash: _hash, ...rest } = record(type, '3.1')
      return rest
    }
    expect(parseCatalogue({ data: [blind('model'), blind('vocab')] }, 'fr', 'en').ok).toBe(false)
    expect(parseCatalogue({ data: [record('model', '3.1', { decompressedSize: 0 }), record('vocab', '3.1')] }, 'fr', 'en').ok).toBe(false)
    expect(parseCatalogue({ data: [record('model', '3.1', { decompressedHash: 'zz' }), record('vocab', '3.1')] }, 'fr', 'en').ok).toBe(false)
  })

  // The answer is data from a server: a record that is not what it should be is skipped, and a plan never holds an address elsewhere than the attachments server.
  it('skips a record that is not well formed and never builds an address off the attachments server', () => {
    const hostile = [
      record('model', '3.1', {}, { location: '//evil.example/model.bin' }),
      record('model', '3.1', {}, { location: 'https://evil.example/model.bin' }),
      record('model', '3.1', {}, { location: 'a/../../etc/passwd' }),
      record('model', '3.1', {}, { location: 'x@evil.example/m.bin' }),
      record('model', '3.1', {}, { location: 'x:8080/m.bin' }),
      record('model', '3.1', {}, { location: '/absolute' }),
      record('model', '3.1', {}, { hash: 'zz' }),
      record('model', '3.1', {}, { size: 0 }),
      record('model', '3.1', {}, { size: PACK_LIMITS.fileBytes + 1 }),
      record('model', '3.1', {}, { size: 1.5 }),
      record('model', '3.1', { decompressedSize: PACK_LIMITS.fileBytes + 1 }),
      record('model', 'latest'),
      record('shoes', '3.1'),
      { ...record('model', '3.1'), attachment: null },
      null,
      'x'
    ]
    expect(parseCatalogue({ data: hostile }, 'fr', 'en')).toEqual({ ok: false, reason: expect.stringContaining('fr') })
    // A good record among them still makes its file, and a hostile name becomes a safe one.
    const mixed = parseCatalogue({ data: [...hostile, record('model', '3.1', { name: '../../x' }, { filename: '../../x.zst' }), record('vocab', '3.1')] }, 'fr', 'en')
    expect(mixed.ok).toBe(true)
    if (mixed.ok) expect(mixed.plan.files.map((f) => f.name)).toEqual(['model.bin', 'vocab.fren.bin'])
  })

  it('refuses an answer that is not a list, is too long, lacks a file the engine needs, or lists two files under one name', () => {
    for (const bad of [null, 'x', {}, { data: 'x' }, { data: {} }]) expect(parseCatalogue(bad, 'fr', 'en').ok).toBe(false)
    expect(parseCatalogue({ data: Array(CATALOGUE_LIMITS.records + 1).fill(record('model', '3.1')) }, 'fr', 'en').ok).toBe(false)
    expect(parseCatalogue({ data: [record('model', '3.1')] }, 'fr', 'en')).toMatchObject({ ok: false })
    expect(parseCatalogue({ data: [record('model', '3.1', { name: 'same.bin' }), record('vocab', '3.1', { name: 'same.bin' })] }, 'fr', 'en')).toMatchObject({ ok: false })
    // Two records of one kind in one version: the catalogue contradicts itself.
    expect(parseCatalogue({ data: [record('model', '3.1'), record('model', '3.1', { name: 'other.bin' }), record('vocab', '3.1')] }, 'fr', 'en')).toMatchObject({ ok: false })
    expect(parseCatalogue({ data: [] }, 'fr', 'en')).toMatchObject({ ok: false })
    // And one whose files weigh more than a pack may.
    const heavy = (type: string) => record(type, '3.1', { decompressedSize: PACK_LIMITS.fileBytes })
    expect(parseCatalogue({ data: [heavy('model'), heavy('lex'), heavy('vocab')] }, 'fr', 'en')).toMatchObject({ ok: false })
  })

  it('takes the other pair when it is asked for it', () => {
    expect(parseCatalogue({ data: records }, 'en', 'fr')).toMatchObject({ ok: false })
    expect(parseCatalogue({ data: [record('model', '3.1', { fromLang: 'en', toLang: 'fr' }), record('vocab', '3.1', { fromLang: 'en', toLang: 'fr' })] }, 'en', 'fr').ok).toBe(true)
  })
})

describe('the catalogue of the engine', () => {
  const wasm = (version: string, over: Record<string, unknown> = {}, attachment: Record<string, unknown> = {}) => ({
    name: 'bergamot-translator',
    version,
    release: 'v0.6.0',
    license: 'MPL-2.0',
    decompressedHash: HASH,
    decompressedSize: 4_960_506,
    filter_expression: '',
    attachment: { hash: 'c'.repeat(64), size: 1_500_000, filename: 'bergamot-translator.wasm.zst', location: `main-workspace/translations-wasm/${version}.zst`, mimetype: 'application/zstd', ...attachment },
    ...over
  })

  it('takes the newest binary of the major version the glue fits, for a release build, kept under one fixed name', () => {
    const parsed = parseRuntimeCatalogue({ data: [wasm('4.0'), wasm('4.1'), wasm('5.0'), wasm('3.0'), wasm('4.2', { filter_expression: "env.channel == 'nightly'" }), wasm('4.3', { name: 'fasttext-wasm' })] })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(RUNTIME_MAJOR).toBe(4)
    expect(parsed.plan).toEqual({
      version: '4.1',
      release: 'v0.6.0',
      file: { name: RUNTIME_FILE_NAME, size: 4_960_506, sha256: HASH, url: 'https://firefox-settings-attachments.cdn.mozilla.net/main-workspace/translations-wasm/4.1.zst', transfer: { encoding: 'zstd', size: 1_500_000, sha256: 'c'.repeat(64) } }
    })
  })

  it('refuses a binary off the attachments server, too big, without its fingerprints, or none at all', () => {
    expect(parseRuntimeCatalogue({ data: [wasm('4.0', {}, { location: '//evil.example/x' })] }).ok).toBe(false)
    expect(parseRuntimeCatalogue({ data: [wasm('4.0', { decompressedSize: RUNTIME_LIMITS.bytes + 1 })] }).ok).toBe(false)
    expect(parseRuntimeCatalogue({ data: [wasm('4.0', { decompressedHash: undefined })] }).ok).toBe(false)
    expect(parseRuntimeCatalogue({ data: [] })).toEqual({ ok: false, reason: 'Le catalogue ne donne pas de moteur compatible avec cette version de Lucium.' })
    expect(parseRuntimeCatalogue({ data: 'x' }).ok).toBe(false)
  })
})

describe('the filters of the records', () => {
  it('read the comparisons Mozilla writes, for a release build on this system', () => {
    expect(filterHolds('')).toBe(true)
    expect(filterHolds(undefined)).toBe(true)
    expect(filterHolds("env.channel == 'default' || env.channel == 'nightly'")).toBe(false)
    expect(filterHolds("env.channel == 'default' || env.channel == 'nightly' || env.channel == 'beta'")).toBe(false)
    expect(filterHolds("env.appinfo.OS != 'Android' || env.channel != 'release'")).toBe(true)
    expect(filterHolds("env.appinfo.OS == 'Android' ")).toBe(false)
    expect(filterHolds("env.appinfo.OS == 'Darwin' && env.channel == 'release'")).toBe(true)
    expect(filterHolds("env.appinfo.OS == 'WINNT'", { channel: 'release', os: 'WINNT' })).toBe(true)
  })

  it('take anything else as false, so that a record meant for someone else is never taken', () => {
    for (const unreadable of ["(env.channel == 'release')", "!(env.channel == 'nightly')", "env.version|versionCompare('140') >= 0", "env.locale == 'fr'", 3, {}, 'x'.repeat(600)]) expect(filterHolds(unreadable), String(unreadable)).toBe(false)
  })
})

describe('the engine of a pair', () => {
  const pack = (from: string, to: string, engine: PackEngine): PackRef => ({ from, to, engine })

  it('is the machine translation when its engine is there, the glossary of the pair otherwise', () => {
    const packs = [pack('fr', 'en', 'glossary'), pack('fr', 'en', 'bergamot')]
    expect(planRoute(usablePacks(packs, ['bergamot', 'glossary']), 'fr', 'en')).toEqual({ ok: true, steps: [pack('fr', 'en', 'bergamot')] })
    // The binary is not downloaded yet: the glossary of the pair translates.
    expect(planRoute(usablePacks(packs, ['glossary']), 'fr', 'en')).toEqual({ ok: true, steps: [pack('fr', 'en', 'glossary')] })
  })

  it('is the glossary for a pair Mozilla publishes no model of, also on the way through English', () => {
    const packs = [pack('br', 'en', 'glossary'), pack('en', 'de', 'bergamot')]
    expect(planRoute(usablePacks(packs, ['bergamot', 'glossary']), 'br', 'de')).toEqual({ ok: true, steps: [pack('br', 'en', 'glossary'), pack('en', 'de', 'bergamot')] })
  })

  it('is no engine at all for a model whose engine is not there and that has no glossary: the pair is missing', () => {
    expect(planRoute(usablePacks([pack('fr', 'en', 'bergamot')], ['glossary']), 'fr', 'en')).toEqual({ ok: false, missing: [['fr', 'en']] })
  })
})

describe('the route from one language to another', () => {
  const pack = (from: string, to: string): PackRef => ({ from, to, engine: 'bergamot' })
  it('is the direct pack, else the two through English, else the pairs that are missing', () => {
    const available = [pack('fr', 'en'), pack('en', 'de'), pack('es', 'en')]
    expect(planRoute(available, 'fr', 'en')).toEqual({ ok: true, steps: [pack('fr', 'en')] })
    expect(planRoute(available, 'fr', 'de')).toEqual({ ok: true, steps: [pack('fr', 'en'), pack('en', 'de')] })
    expect(planRoute(available, 'en', 'fr')).toEqual({ ok: false, missing: [['en', 'fr']] })
    expect(planRoute(available, 'de', 'fr')).toEqual({ ok: false, missing: [['de', 'en'], ['en', 'fr']] })
    expect(planRoute(available, 'es', 'de')).toEqual({ ok: true, steps: [pack('es', 'en'), pack('en', 'de')] })
    expect(planRoute(available, 'fr', 'es')).toEqual({ ok: false, missing: [['en', 'es']] })
    expect(planRoute(available, 'fr', 'fr')).toEqual({ ok: true, steps: [] })
    expect(planRoute([], 'fr', 'en')).toEqual({ ok: false, missing: [['fr', 'en']] })
  })

  it('never pivots through anything but English, nor twice', () => {
    expect(planRoute([pack('fr', 'es'), pack('es', 'de')], 'fr', 'de')).toEqual({ ok: false, missing: [['fr', 'en'], ['en', 'de']] })
  })
})

describe('the requests of the panel', () => {
  it('accepts exactly the shapes it defines', () => {
    expect(parseTranslateRequest({ action: 'run', from: 'fr', to: 'en' })).toEqual({ action: 'run', from: 'fr', to: 'en' })
    expect(parseTranslateRequest({ action: 'lookup', from: 'fr', to: 'en' })).toEqual({ action: 'lookup', from: 'fr', to: 'en' })
    for (const action of ['restore', 'folder', 'folder-default', 'refresh', 'packs', 'system-settings']) expect(parseTranslateRequest({ action })).toEqual({ action })
    // The pane of the system's settings is the main process' address: the panel cannot name one.
    expect(parseTranslateRequest({ action: 'system-settings', url: 'x-apple.systempreferences:com.apple.preference.security' })).toBeNull()
    for (const action of ['download', 'adopt', 'remove']) expect(parseTranslateRequest({ action, from: 'de', to: 'en' })).toEqual({ action, from: 'de', to: 'en' })
    // Which of the two packs of a pair goes: an engine this build knows, nothing else.
    expect(parseTranslateRequest({ action: 'remove', from: 'fr', to: 'en', engine: 'glossary' })).toEqual({ action: 'remove', from: 'fr', to: 'en', engine: 'glossary' })
    for (const engine of ['wasm', '../x', 3, null]) expect(parseTranslateRequest({ action: 'remove', from: 'fr', to: 'en', engine })).toBeNull()
    expect(parseTranslateRequest({ action: 'download', from: 'fr', to: 'en', engine: 'bergamot' })).toBeNull()
  })

  it('refuses a path, an address, a surplus field, the same language twice and anything unknown', () => {
    for (const bad of [null, 'run', [], {}, { action: 'format' }, { action: 'run', to: 'en' }, { action: 'run', from: 'fr', to: 'fr' }, { action: 'run', from: '../x', to: 'en' }, { action: 'lookup', from: 'fr', to: 'en', url: 'https://evil.example/' }, { action: 'folder', path: '/etc' }, { action: 'remove', from: 'fr', to: 'en/../..' }, { action: 'download', from: 'fr', to: 'en', files: [] }, { action: 'refresh', extra: 1 }]) {
      expect(parseTranslateRequest(bad), JSON.stringify(bad)).toBeNull()
    }
  })
})

describe('the requests of the toolbar button’s popover', () => {
  it('accepts one click (into the target, or another language), the two switches, and nothing else', () => {
    expect(parseTranslateRequest({ action: 'quick' })).toEqual({ action: 'quick' })
    expect(parseTranslateRequest({ action: 'quick', to: 'de' })).toEqual({ action: 'quick', to: 'de' })
    expect(parseTranslateRequest({ action: 'always', language: 'en', on: true })).toEqual({ action: 'always', language: 'en', on: true })
    expect(parseTranslateRequest({ action: 'always', language: 'en', on: false })).toEqual({ action: 'always', language: 'en', on: false })
    expect(parseTranslateRequest({ action: 'never-site', on: true })).toEqual({ action: 'never-site', on: true })
  })

  it('refuses a language that is not a code, a site named by the interface, a switch that is not one, and surplus fields', () => {
    for (const bad of [
      { action: 'quick', to: 'German' },
      { action: 'quick', to: '../x' },
      { action: 'quick', from: 'en' },
      { action: 'always', language: 'und', on: true },
      { action: 'always', language: 'EN', on: true },
      { action: 'always', language: 'en-US', on: true },
      { action: 'always', language: 'en', on: 'yes' },
      { action: 'always', language: 'en' },
      { action: 'never-site', on: true, host: 'evil.example' },
      { action: 'never-site', url: 'https://evil.example/', on: true },
      { action: 'never-site', on: 1 }
    ]) {
      expect(parseTranslateRequest(bad), JSON.stringify(bad)).toBeNull()
    }
  })
})

describe('sizes', () => {
  it('are written in the language of the interface', () => {
    expect(formatSize(31_561_787)).toBe('30,1\u00a0Mo')
    expect(formatSize(2048)).toBe('2\u00a0Ko')
    expect(formatSize(12)).toBe('12\u00a0o')
    setLanguage('en')
    expect(formatSize(31_561_787)).toBe('30.1\u00a0MB')
  })
})
