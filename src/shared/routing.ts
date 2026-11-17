import type { LinkRoute, Space } from './model'
import { hostnameOf, matchesHost } from './url'

/**
 * The space a link from another app should open in: the most specific matching rule
 * (longest host) whose space still exists. Undefined means "use the current space".
 */
export function routeFor(url: string, routes: LinkRoute[], spaces: Pick<Space, 'id'>[]): string | undefined {
  if (hostnameOf(url) === '') return undefined
  return routes
    .filter((r) => spaces.some((s) => s.id === r.spaceId) && matchesHost(r.host, url))
    .sort((a, b) => b.host.length - a.host.length)[0]?.spaceId
}
