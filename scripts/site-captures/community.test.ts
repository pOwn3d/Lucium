import { describe, expect, it } from 'vitest'
import { SITE_HOST as MAPPED_HOST, hostRules } from './capture'
import { COMMUNITY_IDEAS, DEMO_CHECK_ANSWER, DEMO_CHECK_PATH, SITE_HEADERS, SITE_HOST, VOTED_IDEA, communityApi, communityUrl, langOfReferer, siteFile, type ApiRequest, type CommunityVotes } from './community'
import { SITE_TABS } from './demo'
import { browserNamesIn } from './names'
import { LANGS } from './shots'

const fresh = (): CommunityVotes => ({ voted: new Set() })
const ask = (votes: CommunityVotes, request: Partial<ApiRequest> & { url: string }) => {
  const answer = communityApi(votes, { method: 'GET', signedIn: true, ...request })
  return { status: answer?.status, body: answer ? JSON.parse(answer.body) : null }
}
const list = (votes: CommunityVotes, referer = 'https://lucium.app/communaute/', signedIn = true) =>
  ask(votes, { url: '/api/community/requests?type=idea', referer, signedIn }).body as { signedIn: boolean; requests: Array<{ id: string; title: string; votes: number; voted: boolean }> }

describe('the Community page shown in a tab', () => {
  it('is shown under the site’s own address, which the run maps to the local server with the demonstration domain', () => {
    expect(SITE_HOST).toBe(MAPPED_HOST)
    expect(hostRules(4321)).toBe(`MAP *.example 127.0.0.1:4321, MAP ${SITE_HOST} 127.0.0.1:4321`)
    for (const lang of LANGS) expect(SITE_TABS.find((t) => t.key === 'community')!.url[lang]).toBe(communityUrl(lang))
    expect(communityUrl('fr')).toBe('https://lucium.app/communaute/')
    expect(communityUrl('en')).toBe('https://lucium.app/en/community/')
  })

  it('serves only the two Community pages, the icon of the site and the assets of a known type, by a path of plain names', () => {
    expect(siteFile('/communaute/')).toEqual({ file: 'communaute/index.html', contentType: 'text/html; charset=utf-8' })
    expect(siteFile('/en/community/?x=1')).toEqual({ file: 'en/community/index.html', contentType: 'text/html; charset=utf-8' })
    expect(siteFile('/assets/community-api.js')).toEqual({ file: 'assets/community-api.js', contentType: 'text/javascript; charset=utf-8' })
    expect(siteFile('/assets/icons/boreal.png')).toEqual({ file: 'assets/icons/boreal.png', contentType: 'image/png' })
    // The page draws its header with the icon of the site and its text with the fonts of the site: without them, the image shows a broken logo
    // and the fonts of the system.
    expect(siteFile('/favicon.svg')).toEqual({ file: 'favicon.svg', contentType: 'image/svg+xml' })
    expect(siteFile('/assets/fonts/fraunces.woff2')).toEqual({ file: 'assets/fonts/fraunces.woff2', contentType: 'font/woff2' })
    for (const refused of ['/', '/faq/', '/server.mjs', '/README.md', '/assets/../server.mjs', '/assets/%2e%2e/server.mjs', '/assets/.env', '/assets/icons/.hidden.png', '/assets/data.json', '/pb_hooks/main.pb.js', '/communaute/index.html', '/favicon.ico', '/apple-touch-icon.png']) {
      expect(siteFile(refused), refused).toBeNull()
    }
  })

  it('lets the scripts of the page reach only the local server, and the proof of work run in a worker', () => {
    const policy = SITE_HEADERS['Content-Security-Policy']!
    expect(policy).toContain("default-src 'self'")
    expect(policy).toContain("connect-src 'self'")
    expect(policy).toContain('worker-src blob:')
    expect(policy).not.toMatch(/https?:/)
  })
})

describe('the stand-in of the community API', () => {
  it('opens the votes and lists the made-up ideas in the language of the page, the most voted first, none voted yet', () => {
    const votes = fresh()
    expect(ask(votes, { url: '/api/config' })).toEqual({ status: 200, body: { votingEnabled: true } })
    const fr = list(votes)
    expect(fr.signedIn).toBe(true)
    expect(fr.requests.map((r) => r.title)).toEqual(COMMUNITY_IDEAS.map((i) => i.title.fr))
    expect(list(votes, 'https://lucium.app/en/community/').requests[0]!.title).toBe(VOTED_IDEA.title.en)
    expect(fr.requests.every((r) => !r.voted)).toBe(true)
    expect(VOTED_IDEA.votes).toBe(Math.max(...COMMUNITY_IDEAS.map((i) => i.votes)))
    expect(ask(votes, { url: '/api/community/requests?type=bug' }).body.requests).toEqual([])
  })

  it('counts a vote of a signed-in page once, adds it to the list, and takes it back', () => {
    const votes = fresh()
    const body = JSON.stringify({ requestId: VOTED_IDEA.id, challenge: 'demo-challenge', nonce: '1' })
    expect(ask(votes, { method: 'POST', url: '/api/community/votes', body })).toEqual({ status: 200, body: { votes: VOTED_IDEA.votes + 1, held: false } })
    expect(list(votes).requests[0]).toMatchObject({ id: VOTED_IDEA.id, votes: VOTED_IDEA.votes + 1, voted: true })
    expect(ask(votes, { method: 'POST', url: '/api/community/votes', body }).status).toBe(409)
    expect(ask(votes, { method: 'DELETE', url: '/api/community/votes', body })).toEqual({ status: 200, body: { votes: VOTED_IDEA.votes } })
    expect(list(votes).requests[0]).toMatchObject({ votes: VOTED_IDEA.votes, voted: false })
  })

  it('refuses a vote of a page that is not signed in, or for an idea that is not on the board, and shows no vote to a page signed out', () => {
    const votes = fresh()
    expect(ask(votes, { method: 'POST', url: '/api/community/votes', signedIn: false, body: JSON.stringify({ requestId: VOTED_IDEA.id }) })).toEqual({ status: 401, body: { error: 'authentication-required' } })
    expect(ask(votes, { method: 'POST', url: '/api/community/votes', body: JSON.stringify({ requestId: 'real-42' }) }).status).toBe(404)
    expect(ask(votes, { method: 'POST', url: '/api/community/votes', body: 'not json' }).status).toBe(404)
    expect(votes.voted.size).toBe(0)
    votes.voted.add(VOTED_IDEA.id)
    expect(list(votes, undefined, false).requests[0]).toMatchObject({ voted: false, votes: VOTED_IDEA.votes })
  })

  it('answers the question only it knows, a challenge the page solves at once, and nothing else: no code is sent, no proposal saved', () => {
    const votes = fresh()
    expect(ask(votes, { url: DEMO_CHECK_PATH })).toEqual({ status: 200, body: { demo: DEMO_CHECK_ANSWER } })
    const challenge = ask(votes, { url: '/api/community/challenge' }).body
    expect(challenge.difficulty).toBe(1)
    expect(challenge.salt).toMatch(/^[0-9a-f]{8,100}$/)
    expect(ask(votes, { method: 'POST', url: '/api/community/auth/request', body: '{}' }).status).toBe(404)
    expect(ask(votes, { method: 'POST', url: '/api/community/requests', body: '{}' }).status).toBe(404)
    expect(communityApi(votes, { method: 'GET', url: '/communaute/', signedIn: false })).toBeNull()
  })

  it('tells the language of the page by its address, French by default', () => {
    expect(langOfReferer('https://lucium.app/en/community/')).toBe('en')
    expect(langOfReferer('https://lucium.app/communaute/')).toBe('fr')
    expect(langOfReferer(undefined)).toBe('fr')
    expect(langOfReferer('not an address')).toBe('fr')
  })

  it('names no other browser in its ideas', () => {
    expect(browserNamesIn(COMMUNITY_IDEAS.map((i) => `${i.title.fr} ${i.title.en}`).join('\n'))).toEqual([])
  })
})
