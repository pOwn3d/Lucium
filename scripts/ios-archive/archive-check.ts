// What is read in an archive before it is exported (docs/ios.md, section 10.3): that it is the build that was asked for, and that it carries the
// files the application cannot do without. An archive that fails either is not exported, so nothing wrong reaches App Store Connect.
//
// The archive's own Info.plist is read as XML text (the script converts it with `plutil -convert xml1`, whatever format Xcode wrote it in), and
// the content of the application is a list of file names. Pure. Loaded by Node with type stripping: no enum, no parameter property.

export interface ArchiveFacts {
  /** The XML text of the archive's Info.plist (`<archive>/Info.plist`). */
  plistXml: string
  /** The names of the files at the root of the application in the archive (`<archive>/Products/Applications/Lucium.app`). */
  appFiles: readonly string[]
  /** The files the application must carry there: the registry of the filter lists, every list file, the page guard's two files. */
  requiredFiles: readonly string[]
  expect: { bundleId: string; build: string }
}

/** The string under a key of the plist, or null. The archive's plist names each of the keys read here once. */
export function plistString(xml: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`<key>${escaped}</key>\\s*<string>([^<]*)</string>`).exec(xml)
  return match ? match[1]! : null
}

/** What is wrong with an archive, in sentences; empty when it may be exported. */
export function archiveProblems(facts: ArchiveFacts): string[] {
  const problems: string[] = []
  const bundleId = plistString(facts.plistXml, 'CFBundleIdentifier')
  if (bundleId === null) problems.push('the archive does not say which application it holds (no CFBundleIdentifier in its Info.plist)')
  else if (bundleId !== facts.expect.bundleId) problems.push(`the archive holds ${bundleId}, not ${facts.expect.bundleId}`)
  const build = plistString(facts.plistXml, 'CFBundleVersion')
  if (build === null) problems.push('the archive does not say its build number (no CFBundleVersion in its Info.plist)')
  else if (build !== facts.expect.build) problems.push(`the archive has the build number ${build}, not ${facts.expect.build}: the setting did not reach the application`)
  const present = new Set(facts.appFiles)
  for (const name of facts.requiredFiles) {
    if (!present.has(name)) problems.push(`the application in the archive does not carry ${name}`)
  }
  return problems
}
