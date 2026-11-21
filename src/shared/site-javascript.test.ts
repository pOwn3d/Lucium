import { describe, expect, it } from 'vitest'
import { JAVASCRIPT_OFF_POLICY, SITE_JAVASCRIPT_MAX, cleanSiteJavascriptOff, isJavascriptOff, javascriptPolicyFor, setJavascriptOff } from './site-javascript'

describe('the JavaScript switch of a site', () => {
  it('keeps valid hosts only, spelled once, bounded', () => {
    expect(cleanSiteJavascriptOff(['Example.ORG', 'https://pas-un-hote.example/chemin', 42, null, 'example.org', 'localhost:3000', 'a b'])).toEqual(['example.org', 'localhost:3000'])
    expect(cleanSiteJavascriptOff('example.org')).toEqual([])
    expect(cleanSiteJavascriptOff(Array.from({ length: SITE_JAVASCRIPT_MAX + 20 }, (_, i) => `s${i}.example`))).toHaveLength(SITE_JAVASCRIPT_MAX)
  })

  it('covers the exact host of a web page, and nothing else', () => {
    const list = ['shop.example']
    expect(isJavascriptOff(list, 'https://shop.example/panier?x=1')).toBe(true)
    expect(isJavascriptOff(list, 'http://shop.example/')).toBe(true)
    expect(isJavascriptOff(list, 'https://www.shop.example/')).toBe(false)
    expect(isJavascriptOff(list, 'https://other.example/')).toBe(false)
    expect(isJavascriptOff(['shop.example:8080'], 'https://shop.example/')).toBe(false)
  })

  it('never covers a page of Lucium or a local file, even if a hand-edited list names it', () => {
    expect(isJavascriptOff(['settings', 'newtab', 'shop.example'], 'lucium://settings')).toBe(false)
    expect(isJavascriptOff(['shop.example'], 'file:///Users/x/shop.example')).toBe(false)
    expect(isJavascriptOff(['shop.example'], 'about:blank')).toBe(false)
    expect(javascriptPolicyFor(['settings'], 'lucium://settings/')).toBeNull()
  })

  it('adds and takes out a site, and changes nothing for what is not a site', () => {
    const on = setJavascriptOff([], 'https://shop.example/panier', true)
    expect(on).toEqual(['shop.example'])
    expect(setJavascriptOff(on, 'shop.example', true)).toEqual(on)
    expect(setJavascriptOff(on, 'shop.example', false)).toEqual([])
    expect(setJavascriptOff([], 'pas un hôte', true)).toEqual([])
    expect(setJavascriptOff(on, 'lucium://settings', true)).toEqual(on)
    expect(setJavascriptOff(on, 'other.example', false)).toEqual(on)
  })

  it('refuses one more site when the list is full, and still lets one go', () => {
    const full = Array.from({ length: SITE_JAVASCRIPT_MAX }, (_, i) => `s${i}.example`)
    expect(setJavascriptOff(full, 'one-more.example', true)).toEqual(full)
    expect(setJavascriptOff(full, 's0.example', false)).toHaveLength(SITE_JAVASCRIPT_MAX - 1)
  })

  it('gives the policy that stops scripts to a listed site only', () => {
    expect(javascriptPolicyFor(['shop.example'], 'https://shop.example/')).toBe(JAVASCRIPT_OFF_POLICY)
    expect(JAVASCRIPT_OFF_POLICY).toContain("script-src 'none'")
    expect(JAVASCRIPT_OFF_POLICY).toContain("script-src-elem 'none'")
    expect(JAVASCRIPT_OFF_POLICY).toContain("script-src-attr 'none'")
    expect(javascriptPolicyFor(['shop.example'], 'https://other.example/')).toBeNull()
    expect(javascriptPolicyFor([], 'https://shop.example/')).toBeNull()
  })
})
