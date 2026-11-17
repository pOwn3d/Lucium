import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The library draws the icon of an extension as the background image of its button (the `action` part). A rule on that part that sets the
// `background` shorthand resets the image: the icon vanished as soon as the pointer was over it.
const SHEETS = ['styles.css', 'toolbar.css']

describe('the stylesheets of the extension buttons', () => {
  for (const sheet of SHEETS) {
    it(`${sheet}: no rule on ::part(action) sets the background shorthand, which would erase the icon`, () => {
      const css = readFileSync(join(__dirname, '../renderer', sheet), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
      const rules = [...css.matchAll(/([^{}]*::part\(action\)[^{}]*)\{([^}]*)\}/g)]
      expect(rules.length, `${sheet} has rules on the action part`).toBeGreaterThan(0)
      for (const [, selector = '', body = ''] of rules) expect(/(^|[;\s])background\s*:/.test(body), `${selector.trim()} { ${body.trim()} }`).toBe(false)
    })
  }
})
