// The task manager writes a share of a processor the way the resource panel does: with the decimal mark and the space of the language of the
// interface ("6,4 %" in French, "6.4%" in English). It wrote the raw number with a point and a space in both. The window mounts itself when
// its module is read, so its source is read here; what the formatter gives is checked in shared/resources.test.ts.

import { afterEach, describe, expect, it } from 'vitest'
import { frenchSpaces } from '@shared/french-typography'
import { setLanguage } from '@shared/i18n'
import { formatPercent } from '@shared/resources'
import source from './taskmanager.tsx?raw'

afterEach(() => setLanguage('fr'))

describe('the processor column of the task manager', () => {
  it('hands both of its figures to the formatter of the resource panel, and writes no percent sign of its own', () => {
    expect(source).toContain('<b>{formatPercent(summary.cpu)}</b>')
    expect(source).toContain("row.asleep ? '—' : formatPercent(row.cpu)")
    expect(source.match(/formatPercent\(/g)).toHaveLength(2)
    // A percent sign in the file would be a figure formatted by hand again (the width of a column is set in the stylesheet, not here).
    expect(source.replace(/\/\/.*$/gm, '')).not.toMatch(/%/)
  })

  it('reads 6.4 as « 6,4 % » in French and as "6.4%" in English', () => {
    expect(formatPercent(6.4)).toBe(frenchSpaces('6,4 %'))
    setLanguage('en')
    expect(formatPercent(6.4)).toBe('6.4%')
  })
})
