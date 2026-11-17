import { describe, expect, it } from 'vitest'
import { defaultSettings, type Settings } from './model'
import { cleanKeyExtSettings } from './key-ext-settings'

const with_ = (patch: Record<string, unknown>): Settings => ({ ...defaultSettings(), ...patch }) as unknown as Settings

describe('the settings of the keyboard and extension features, read back from a file', () => {
  it('start off, with no site left out', () => {
    expect(cleanKeyExtSettings(defaultSettings())).toEqual({ vimKeys: false, vimKeysExcludedHosts: [], tabGroupFolders: false, omniboxKeywords: false })
  })

  it('are on only when the file holds exactly true', () => {
    expect(cleanKeyExtSettings(with_({ vimKeys: true, tabGroupFolders: true, omniboxKeywords: true }))).toMatchObject({ vimKeys: true, tabGroupFolders: true, omniboxKeywords: true })
    for (const bad of ['true', 1, 'yes', null, undefined, {}, [], 'on']) {
      expect(cleanKeyExtSettings(with_({ vimKeys: bad, tabGroupFolders: bad, omniboxKeywords: bad })), JSON.stringify(bad)).toMatchObject({ vimKeys: false, tabGroupFolders: false, omniboxKeywords: false })
    }
  })

  it('keep the sites left out as hosts, each once, and drop what is not a site', () => {
    const cleaned = cleanKeyExtSettings(with_({ vimKeysExcludedHosts: ['Mail.Example.org', 'https://www.example.com/path', 'mail.example.org', 42, null, '', 'not a host', '../..', { host: 'x.org' }] })).vimKeysExcludedHosts
    expect(cleaned).toEqual(['mail.example.org', 'example.com'])
    expect(cleanKeyExtSettings(with_({ vimKeysExcludedHosts: 'example.org' })).vimKeysExcludedHosts).toEqual([])
    expect(cleanKeyExtSettings(with_({ vimKeysExcludedHosts: undefined })).vimKeysExcludedHosts).toEqual([])
  })
})
