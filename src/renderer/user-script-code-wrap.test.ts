// The code of a user script is shown before it is added, and that reading is the only guard of the feature (shared/userscript.ts refuses what
// reorders a line). A line that ran on out of sight could hide code after a long run of spaces, beyond the right edge of the box: the box wraps
// its lines. What the sheet does with the class is read from the sheet itself (style contracts, as in stylesheets.test.ts).

import { describe, expect, it } from 'vitest'
import settings from './settings.css?raw'

/** The declarations of the rule written for exactly this selector. */
function ruleOf(css: string, selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const body = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1]
  if (body === undefined) throw new Error(`no rule for ${selector}`)
  return Object.fromEntries(
    body
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => [part.slice(0, part.indexOf(':')).trim(), part.slice(part.indexOf(':') + 1).trim()])
  )
}

describe('the box that shows the code of a user script', () => {
  it('wraps its lines, so that no code waits out of sight past the right edge', () => {
    const rule = ruleOf(settings, '.us-code')
    expect(rule['white-space']).toBe('pre-wrap')
    expect(rule['overflow-wrap']).toBe('anywhere')
  })

  it('is not set back to one line per line of code by the box of the review', () => {
    const review = ruleOf(settings, '.us-review .us-code')
    expect(review['white-space']).toBeUndefined()
    expect(review['overflow-wrap']).toBeUndefined()
  })
})
