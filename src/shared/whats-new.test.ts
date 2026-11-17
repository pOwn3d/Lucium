// "Quoi de neuf" (N9): the changelog read as news, and when a launch shows them. The text is the one the build puts in the application.

import { describe, expect, it } from 'vitest'
import { NEWS_FEATURED, NEWS_TEXT_MAX, cleanVersion, newsOf, newsPointOf, whatsNewDecision, whatsNewSheetOf } from './whats-new'

const CHANGELOG = `# Changelog

## [Unreleased]

### Added

- **Pages by address**: \`chrome://history\` opens the page of Lucium that stands for it (or says there is none).
- Fixes of 2026-10-25 (\`docs/notes.md\`): lock, reducers and network corrections.

### Fixed

- **Tab names**: a long [title](https://example.org) is cut.

## [0.1.0] - 2026-10-24

### Added

- **First release**: tabs, spaces and a sidebar.
`

describe('the changelog as news', () => {
  it('takes the bold title of a line as the title and the rest as plain text, without markup', () => {
    expect(newsPointOf('- **Pages by address**: `chrome://history` opens it.')).toEqual({ title: 'Pages by address', text: 'chrome://history opens it.' })
    expect(newsPointOf('- **Tab names**: a long [title](https://example.org) is cut.')).toEqual({ title: 'Tab names', text: 'A long title is cut.' })
  })

  it('keeps a parenthesis that follows the title in the title, and never starts the text with what joined it', () => {
    expect(newsPointOf('- **Command bar** (⌘T, ⌘L): addresses and a calculator.')).toEqual({ title: 'Command bar (⌘T, ⌘L)', text: 'Addresses and a calculator.' })
    expect(newsPointOf('- **Chrome extensions (Manifest V3)**, loaded unpacked or from the store.')).toEqual({ title: 'Chrome extensions (Manifest V3)', text: 'Loaded unpacked or from the store.' })
    expect(newsPointOf('- **Barre de commandes (⌘T)** : adresses et calcul.')).toEqual({ title: 'Barre de commandes (⌘T)', text: 'Adresses et calcul.' })
  })

  it('takes the first sentence of a line with no bold title', () => {
    expect(newsPointOf('- Fixes of 2026-10-25 (`docs/notes.md`): lock, reducers and network corrections.')).toMatchObject({ title: 'Fixes of 2026-10-25 (docs/notes.md)' })
    expect(newsPointOf('-   ')).toBeNull()
  })

  it('reads the section of the version, in the order of the changelog, and only its changes (not the headings)', () => {
    expect(newsOf(CHANGELOG, '0.1.0').map((point) => point.title)).toEqual(['First release'])
  })

  it('falls back to [Unreleased] for a build ahead of its release notes, and to nothing without it', () => {
    expect(newsOf(CHANGELOG, '0.2.0').map((point) => point.title)).toEqual(['Pages by address', 'Fixes of 2026-10-25 (docs/notes.md)', 'Tab names'])
    expect(newsOf('# Changelog\n\n## [0.1.0]\n\n- **A**: b\n', '0.3.0')).toEqual([])
  })

  it('bounds the length of what a line gives, so that a paragraph of the changelog does not make the sheet', () => {
    const point = newsPointOf(`- **${'T'.repeat(300)}** ${'word '.repeat(200)}`)!
    expect(point.title.length).toBeLessThanOrEqual(90)
    expect(point.text.length).toBeLessThanOrEqual(NEWS_TEXT_MAX)
  })

  it('makes the sheet with the featured count, and says whether the update opened it', () => {
    expect(whatsNewSheetOf(CHANGELOG, '0.1.0', true)).toEqual({ version: '0.1.0', points: [{ title: 'First release', text: 'Tabs, spaces and a sidebar.' }], featured: NEWS_FEATURED, fromUpdate: true })
  })
})

describe('when a launch shows the news', () => {
  it('shows them when the version changed, records it when none was recorded, and does nothing otherwise', () => {
    expect(whatsNewDecision({ enabled: true, last: '0.1.0', current: '0.2.0' })).toBe('show')
    expect(whatsNewDecision({ enabled: true, last: '', current: '0.2.0' })).toBe('record')
    expect(whatsNewDecision({ enabled: true, last: '0.2.0', current: '0.2.0' })).toBe('none')
  })

  it('does nothing when the function is off: not even the version is noted', () => {
    expect(whatsNewDecision({ enabled: false, last: '0.1.0', current: '0.2.0' })).toBe('none')
    expect(whatsNewDecision({ enabled: false, last: '', current: '0.2.0' })).toBe('none')
  })

  it('reads the version of a state file as a version or as nothing', () => {
    expect(cleanVersion('0.1.0')).toBe('0.1.0')
    expect(cleanVersion('1.2.3-beta.1')).toBe('1.2.3-beta.1')
    for (const bad of ['', 'x'.repeat(65), ' 1.0', '1\n0', 12, null, undefined, {}]) expect(cleanVersion(bad), String(bad)).toBe('')
  })
})
