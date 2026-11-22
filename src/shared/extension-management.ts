import type { ExtensionInfo } from './ipc'

/** What `chrome.management.getAll` tells of one extension: a sober subset of the platform's ExtensionInfo (no permission, no path, no icon). */
export interface ManagementInfo {
  id: string
  name: string
  shortName: string
  version: string
  type: 'extension'
  enabled: boolean
  /** A folder the person loaded is `development`; the Web Store's is `normal`. */
  installType: 'development' | 'normal'
  isApp: false
  /** Only the person switches an extension off, in Lucium: another extension may not. */
  mayDisable: false
  offlineEnabled: false
}

/** The extensions of the caller's profile only (the same rule as every other shimmed API), in the platform's shape. */
export function managementGetAll(all: readonly ExtensionInfo[], profileId: string): ManagementInfo[] {
  return all
    .filter((extension) => extension.profileId === profileId)
    .map((extension) => ({
      id: extension.id,
      name: extension.name,
      shortName: extension.name,
      version: extension.version,
      type: 'extension',
      enabled: extension.enabled,
      installType: extension.source === 'unpacked' ? 'development' : 'normal',
      isApp: false,
      mayDisable: false,
      offlineEnabled: false
    }))
}
