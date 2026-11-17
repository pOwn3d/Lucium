// The pages that draw a space's media from its bytes (Sidebar.tsx for an image background, SpaceMediaPanel.tsx for the preview and the pictures of the
// videos Lucium comes with) make blob URLs of them: their policy lets an <img> and a <video> load those, or the picture shows broken.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const policyOf = (page: string): Record<string, string[]> => {
  const html = readFileSync(join(__dirname, page), 'utf8')
  const content = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? ''
  return Object.fromEntries(
    content
      .split(';')
      .map((part) => part.trim().split(/\s+/))
      .filter((words) => words[0])
      .map(([name, ...sources]) => [name!, sources])
  )
}

describe('the policy of the pages that draw a space’s media', () => {
  for (const page of ['index.html', 'overlay.html']) {
    it(`${page} lets a picture and a video be drawn from the bytes the main process sent (blob:)`, () => {
      const policy = policyOf(page)
      expect(policy['img-src']).toContain('blob:')
      expect(policy['media-src']).toContain('blob:')
      // Scripts stay the page's own.
      expect(policy['script-src'] ?? policy['default-src']).toEqual(["'self'"])
    })
  }
})

// A page of the interface holds `window.lucium`. Should markup ever be injected into one, it must not be able to move the base every relative
// address is read from (the scripts of the page are relative), nor send a form anywhere. `frame-ancestors` is left out: a policy given in a
// <meta> ignores it, and `object-src` falls back on `default-src`.
describe('the policy of every page of the interface', () => {
  const pages = readdirSync(__dirname).filter((file) => file.endsWith('.html'))

  it('covers the eleven pages', () => {
    expect(pages.length).toBeGreaterThanOrEqual(11)
  })

  for (const page of pages) {
    it(`${page} takes its scripts from the application only, has no <base> and sends no form`, () => {
      const policy = policyOf(page)
      expect(policy['default-src']).toEqual(["'self'"])
      expect(policy['script-src']).toBeUndefined()
      expect(policy['object-src']).toBeUndefined()
      expect(policy['base-uri']).toEqual(["'none'"])
      expect(policy['form-action']).toEqual(["'none'"])
    })
  }
})

