import { describe, expect, it } from 'vitest'
import { bypassExceptionsWith, bypassNavigation, bypassRowOf, bypassTarget } from './redirect-bypass'

const ON = { unwrapRedirects: true, unwrapExceptions: [] as string[] }
const b64url = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

describe('bypassTarget: redirectors that write the destination in the address', () => {
  it.each([
    ['https://www.google.com/url?sa=t&q=https%3A%2F%2Fexemple.fr%2Fpage%3Fa%3D1&usg=x', 'https://exemple.fr/page?a=1'],
    ['https://www.google.fr/url?url=https://exemple.fr/p', 'https://exemple.fr/p'],
    ['https://l.facebook.com/l.php?u=https%3A%2F%2Fexemple.fr%2Fa&h=AT0', 'https://exemple.fr/a'],
    ['https://lm.facebook.com/l.php?u=https%3A%2F%2Fexemple.fr%2Fa', 'https://exemple.fr/a'],
    ['https://l.instagram.com/?u=https%3A%2F%2Fexemple.fr%2Fa&e=AT', 'https://exemple.fr/a'],
    ['https://out.reddit.com/t3_abc?url=https%3A%2F%2Fexemple.fr%2Fa&token=x', 'https://exemple.fr/a'],
    ['https://www.youtube.com/redirect?event=video_description&q=https%3A%2F%2Fexemple.fr%2Fa', 'https://exemple.fr/a'],
    ['https://steamcommunity.com/linkfilter/?u=https%3A%2F%2Fexemple.fr%2Fa', 'https://exemple.fr/a'],
    ['https://away.vk.com/away.php?to=https%3A%2F%2Fexemple.fr%2Fa', 'https://exemple.fr/a'],
    ['https://www.linkedin.com/safety/go?url=https%3A%2F%2Fexemple.fr%2Fa', 'https://exemple.fr/a'],
    ['https://slack-redir.net/link?url=https%3A%2F%2Fexemple.fr%2Fa', 'https://exemple.fr/a'],
    [`https://www.bing.com/ck/a?!&&p=1&u=a1${b64url('https://exemple.fr/é?a=1')}&ntb=1`, 'https://exemple.fr/%C3%A9?a=1']
  ])('%s opens the destination', (url, target) => {
    expect(bypassTarget(url)).toEqual({ url: target, kind: 'redirect' })
  })

  it('leaves alone a redirector that does not name a web address', () => {
    expect(bypassTarget('https://www.google.com/url?q=javascript:alert(1)')).toBeNull()
    expect(bypassTarget('https://www.google.com/url?q=file:///etc/hosts')).toBeNull()
    expect(bypassTarget('https://www.google.com/url?q=data:text/html,x')).toBeNull()
    expect(bypassTarget('https://www.google.com/url?q=//exemple.fr')).toBeNull()
    expect(bypassTarget('https://www.google.com/url?sa=t')).toBeNull()
  })

  it('refuses a destination with a login in it (it hides the real host) or a huge one', () => {
    expect(bypassTarget('https://www.google.com/url?q=https%3A%2F%2Fbanque.fr%40pirate.example%2F')).toBeNull()
    expect(bypassTarget(`https://www.google.com/url?q=https://exemple.fr/${'a'.repeat(2048)}`)).toBeNull()
  })

  it('leaves alone a malformed Bing value and a page that is not the redirector', () => {
    expect(bypassTarget('https://www.bing.com/ck/a?u=a1***')).toBeNull()
    expect(bypassTarget('https://www.bing.com/ck/a?u=a1abcde')).toBeNull()
    expect(bypassTarget('https://www.bing.com/ck/a?u=https://exemple.fr')).toBeNull()
    expect(bypassTarget('https://www.google.com/search?q=https%3A%2F%2Fexemple.fr')).toBeNull()
    expect(bypassTarget('https://exemple.fr/url?q=https%3A%2F%2Fautre.fr')).toBeNull()
    expect(bypassTarget('https://notgoogle.com/url?q=https%3A%2F%2Fautre.fr')).toBeNull()
  })

  it('ignores what is not a web address, or not an address at all', () => {
    expect(bypassTarget('ftp://www.google.com/url?q=https%3A%2F%2Fexemple.fr')).toBeNull()
    expect(bypassTarget('pas une adresse')).toBeNull()
  })

  it('unwraps a nested destination one level at a time, each shorter than the last', () => {
    const inner = 'https://exemple.fr/a'
    const middle = `https://l.facebook.com/l.php?u=${encodeURIComponent(inner)}`
    const outer = `https://www.google.com/url?q=${encodeURIComponent(middle)}`
    const first = bypassTarget(outer)!
    expect(first.url).toBe(middle)
    expect(first.url.length).toBeLessThan(outer.length)
    expect(bypassTarget(first.url)!.url).toBe(inner)
  })
})

describe('bypassTarget: AMP caches and viewers', () => {
  it.each([
    ['https://exemple-fr.cdn.ampproject.org/c/s/exemple.fr/article/1?amp_js_v=a6&usqp=mq331', 'https://exemple.fr/article/1'],
    ['https://exemple-fr.cdn.ampproject.org/v/s/exemple.fr/article/1?a=2&amp_gsa=1', 'https://exemple.fr/article/1?a=2'],
    ['https://exemple-fr.cdn.ampproject.org/c/exemple.fr/ancien', 'http://exemple.fr/ancien'],
    ['https://www.google.com/amp/s/exemple.fr/article/1', 'https://exemple.fr/article/1'],
    ['https://www.google.fr/amp/s/exemple.fr/a?p=1#titre', 'https://exemple.fr/a?p=1#titre']
  ])('%s opens the publisher page', (url, target) => {
    expect(bypassTarget(url)).toEqual({ url: target, kind: 'amp' })
  })

  it('keeps a parameter the cache forwarded that the publisher page may use', () => {
    expect(bypassTarget('https://exemple-fr.cdn.ampproject.org/c/s/exemple.fr/a?p=1&amp_js_v=a6&page=2')).toEqual({ url: 'https://exemple.fr/a?p=1&page=2', kind: 'amp' })
  })

  it('leaves alone an AMP address on the publisher, a cache path of another kind and a viewer that is not Google', () => {
    expect(bypassTarget('https://exemple.fr/article/1/amp')).toBeNull()
    expect(bypassTarget('https://exemple-fr.cdn.ampproject.org/static/x.js')).toBeNull()
    expect(bypassTarget('https://exemple.fr/amp/s/autre.fr/a')).toBeNull()
    expect(bypassTarget('https://exemple-fr.cdn.ampproject.org/c/s/')).toBeNull()
  })
})

describe('bypassNavigation: the switch and the sites left alone', () => {
  const wrapped = 'https://l.facebook.com/l.php?u=https%3A%2F%2Fexemple.fr%2Fa'

  it('does nothing while the switch is off', () => {
    expect(bypassNavigation(wrapped, { unwrapRedirects: false, unwrapExceptions: [] })).toBeNull()
  })

  it('opens the destination while it is on', () => {
    expect(bypassNavigation(wrapped, ON)).toEqual({ url: 'https://exemple.fr/a', kind: 'redirect' })
  })

  it('leaves the links of a site on the list as they are, at either end', () => {
    expect(bypassNavigation(wrapped, { ...ON, unwrapExceptions: ['facebook.com'] })).toBeNull()
    expect(bypassNavigation(wrapped, { ...ON, unwrapExceptions: ['exemple.fr'] })).toBeNull()
    expect(bypassNavigation(wrapped, { ...ON, unwrapExceptions: ['autre.fr'] })).not.toBeNull()
  })

  it('leaves an address that is not wrapped', () => {
    expect(bypassNavigation('https://exemple.fr/a', ON)).toBeNull()
  })
})

describe('bypassRowOf and bypassExceptionsWith: the row of the site panel', () => {
  it('has no row while the option is off, or on a page that is not on the web', () => {
    expect(bypassRowOf('https://exemple.fr/', { unwrapRedirects: false, unwrapExceptions: [] })).toBeNull()
    expect(bypassRowOf('lucium-ui://newtab/', ON)).toBeNull()
  })

  it('says whether the links of the site are unwrapped or left as they are', () => {
    expect(bypassRowOf('https://www.exemple.fr/a', ON)).toEqual({ host: 'exemple.fr', active: true })
    expect(bypassRowOf('https://blog.exemple.fr/a', { ...ON, unwrapExceptions: ['exemple.fr'] })).toEqual({ host: 'blog.exemple.fr', active: false })
  })

  it('adds the site to the list when switched off, and takes it out when switched on again', () => {
    expect(bypassExceptionsWith(['a.fr'], 'exemple.fr', true)).toEqual(['a.fr', 'exemple.fr'])
    expect(bypassExceptionsWith(['a.fr', 'exemple.fr'], 'blog.exemple.fr', false)).toEqual(['a.fr'])
  })
})
