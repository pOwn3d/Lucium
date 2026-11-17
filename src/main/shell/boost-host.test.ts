import { describe, expect, it } from 'vitest'
import { parseShareHost } from '@shared/boost-share'
import { isWideHost } from './boost-host'

describe('a host that is a whole family of sites', () => {
  it.each(['com', 'org', 'uk', 'co.uk', 'com.au', 'gov.uk', 'github.io', 'blogspot.com', 'herokuapp.com', 'appspot.com', 'netlify.app', 'vercel.app', 'pages.dev', 'fr', 'xn--p1ai', 'kawasaki.jp', 'compute.amazonaws.com'])('%s covers every site under it', (host) => {
    expect(isWideHost(host)).toBe(true)
  })

  it.each(['example.com', 'www.example.com', 'sub.example.co.uk', 'mon-blog.github.io', 'app.herokuapp.com', 'projet.pages.dev', 'service.gouv.fr', 'example.org', 'a.b.c.example.com', 'xn--bcher-kva.example', 'q8x.io', '5cl.app'])('%s is one site', (host) => {
    expect(isWideHost(host)).toBe(false)
  })

  it('leaves localhost and addresses to the reader of the host, which accepted them on purpose', () => {
    for (const host of ['localhost', '127.0.0.1', '192.168.1.20', '10.0.0.1']) {
      expect(parseShareHost(host).ok, host).toBe(true)
      expect(isWideHost(host), host).toBe(false)
    }
  })

  it('agrees with the reader that a host the reader accepts and a suffix of the list is too wide to share', () => {
    for (const host of ['co.uk', 'github.io']) {
      expect(parseShareHost(host).ok).toBe(true)
      expect(isWideHost(host)).toBe(true)
    }
  })
})
