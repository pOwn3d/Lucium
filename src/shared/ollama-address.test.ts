import { describe, expect, it } from 'vitest'
import { cleanOllamaConfig, isLocalOllamaAddress, isOllamaAddress, isPrivateNetworkAddress, ollamaNameOf } from './ollama'

// The page text is given to a model on this Mac or on a computer of the local network, named by a private IP address or by a `.local` name,
// and to nothing else.
describe('the address of the model', () => {
  it('accepts an address of this Mac: localhost, 127.0.0.1 or [::1], on any port', () => {
    expect(isOllamaAddress('http://localhost:11434')).toBe(true)
    expect(isOllamaAddress('http://127.0.0.1:11434')).toBe(true)
    expect(isOllamaAddress('http://[::1]:11434')).toBe(true)
    expect(isOllamaAddress('http://LOCALHOST:8080/')).toBe(true)
    expect(isOllamaAddress('https://localhost')).toBe(true)
  })

  it('accepts a computer of the local network named by its private IP address, and does not take it for this Mac', () => {
    const network = ['http://192.168.1.50:11434', 'http://10.0.0.5:11434', 'http://172.16.0.1:11434', 'http://172.31.255.254:8080/', 'https://192.168.0.2', 'http://[fd12:3456:789a::1]:11434', 'http://[fc00::2]:11434']
    for (const url of network) {
      expect(isOllamaAddress(url), url).toBe(true)
      expect(isLocalOllamaAddress(url), url).toBe(false)
    }
    for (const url of ['http://localhost:11434', 'http://127.0.0.1:11434', 'http://[::1]:11434']) expect(isLocalOllamaAddress(url), url).toBe(true)
    // An address typed in another notation is read as the address it is.
    expect(isOllamaAddress('http://0xC0A80132:11434')).toBe(true)
    expect(isOllamaAddress('http://0x08080808:11434')).toBe(false)
  })

  it('accepts a computer named by an address of the shared range 100.64/10, the one a private mesh network gives, and nothing next to it', () => {
    for (const url of ['http://100.64.0.1:11434', 'http://100.100.20.3:11434', 'https://100.127.255.254']) {
      expect(isOllamaAddress(url), url).toBe(true)
      expect(isLocalOllamaAddress(url), url).toBe(false)
    }
    for (const url of ['http://100.63.255.255:11434', 'http://100.128.0.1:11434', 'http://101.64.0.1:11434']) expect(isOllamaAddress(url), url).toBe(false)
  })

  it('accepts a computer named by a .local name, as a computer of the local network, and gives the name that has to be resolved', () => {
    for (const [url, name] of [['http://mon-mac.local:11434', 'mon-mac.local'], ['https://NAS.Local', 'nas.local'], ['http://atelier.mon-mac.local:8080/', 'atelier.mon-mac.local']] as const) {
      expect(isOllamaAddress(url), url).toBe(true)
      expect(isLocalOllamaAddress(url), url).toBe(false)
      expect(ollamaNameOf(url), url).toBe(name)
    }
    // Only a name is resolved: an IP address, this Mac and a refused address have none.
    for (const url of ['http://192.168.1.50:11434', 'http://100.64.0.1:11434', 'http://localhost:11434', 'https://ollama.exemple.fr', 'http://mon-mac.local.exemple.fr']) expect(ollamaNameOf(url), url).toBeNull()
  })

  it('refuses what only looks like a .local name', () => {
    for (const url of ['http://local:11434', 'http://.local:11434', 'http://mon-mac.local.:11434', 'http://mon-mac.local.exemple.fr:11434', 'http://mon-mac.locale:11434', 'http://mon_mac.local:11434', 'http://-mac.local:11434', 'http://mac-.local:11434', 'http://user@mon-mac.local:11434']) {
      expect(isOllamaAddress(url), url).toBe(false)
      expect(ollamaNameOf(url), url).toBeNull()
    }
  })

  // What a name resolved to is judged by this: a private address of the local network, and nothing else.
  it('tells a private IP address a resolver answered from every other answer', () => {
    for (const address of ['192.168.1.50', '10.0.0.5', '172.20.1.1', '100.64.0.1', '100.127.0.9', 'fd12:3456:789a::1', 'fc00::2']) expect(isPrivateNetworkAddress(address), address).toBe(true)
    for (const address of ['8.8.8.8', '100.128.0.1', '127.0.0.1', '::1', '0.0.0.0', '169.254.1.2', 'fe80::1', 'fe80::1%en0', 'fd00::1%en0', '2a01:e0a::1', '::ffff:192.168.1.50', '192.168.1.999', 'mon-mac.local', '']) expect(isPrivateNetworkAddress(address), address).toBe(false)
  })

  it('keeps a .local name and an address of the shared range read from a saved file, and still switches off for a public host', () => {
    expect(cleanOllamaConfig({ enabled: true, url: 'http://mon-mac.local:11434' })).toMatchObject({ enabled: true, url: 'http://mon-mac.local:11434' })
    expect(cleanOllamaConfig({ enabled: true, url: 'http://100.64.0.1:11434' })).toMatchObject({ enabled: true, url: 'http://100.64.0.1:11434' })
    expect(cleanOllamaConfig({ enabled: true, url: 'http://box.lan:11434' })).toMatchObject({ enabled: false, url: 'http://localhost:11434' })
  })

  it('refuses a public host, by name or by IP address, and every name that is not a .local one', () => {
    const refused = [
      ...['https://ollama.exemple.fr', 'http://8.8.8.8:11434', 'http://1.1.1.1', 'http://[2001:4860:4860::8888]:11434', 'http://nas:11434', 'http://box.lan:11434', 'http://192.168.1.50.exemple.fr:11434'],
      // Just outside the private ranges.
      ...['http://172.15.255.255:11434', 'http://172.32.0.1:11434', 'http://192.169.1.1:11434', 'http://11.0.0.1:11434', 'http://193.168.1.1'],
      // Not an address of a computer of the local network: every interface, link-local, multicast.
      ...['http://0.0.0.0:11434', 'http://169.254.169.254', 'http://[fe80::1]:11434', 'http://224.0.0.1', 'http://[ff02::1]:11434']
    ]
    for (const url of refused) {
      expect(isOllamaAddress(url), url).toBe(false)
      expect(isLocalOllamaAddress(url), url).toBe(false)
    }
  })

  it('refuses a name that only looks like this Mac', () => {
    expect(isOllamaAddress('http://localhost.evil.com')).toBe(false)
    expect(isOllamaAddress('http://127.0.0.1.evil.com:11434')).toBe(false)
    expect(isOllamaAddress('http://evil.com/localhost')).toBe(false)
    expect(isOllamaAddress('http://evil.com:11434/?host=127.0.0.1#localhost')).toBe(false)
    expect(isOllamaAddress('http://localhost@evil.com:11434')).toBe(false)
    expect(isOllamaAddress('http://127.0.0.1:11434@evil.com')).toBe(false)
    expect(isOllamaAddress('http://localhost.:11434')).toBe(false)
    expect(isOllamaAddress('http://[::ffff:192.168.1.50]:11434')).toBe(false)
  })

  it('refuses a file, another scheme, a user name or password, and a value with spaces', () => {
    expect(isOllamaAddress('file:///etc/passwd')).toBe(false)
    expect(isOllamaAddress('javascript:alert(1)')).toBe(false)
    expect(isOllamaAddress('http://user:pass@localhost:11434')).toBe(false)
    expect(isOllamaAddress('http://localhost :11434')).toBe(false)
    expect(isOllamaAddress('pas une adresse')).toBe(false)
  })
})
