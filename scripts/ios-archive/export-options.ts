// The ExportOptions.plist `xcodebuild -exportArchive` reads (docs/ios.md, section 10.3). It is written at the moment of the send, in the output folder
// and not in the repository: the team and the choice between sending and only exporting change from one run to the next. Every key below is one
// that `xcodebuild -help` lists for -exportOptionsPlist in Xcode 27.2.
//
// Pure. Loaded by Node with type stripping: no enum, no parameter property.

export interface ExportOptionsInput {
  /** The Apple developer team, ten letters and digits. Not a secret: it is in every signature. */
  teamId: string
  /** `upload` sends the build to App Store Connect from `-exportArchive`; `export` writes the .ipa and sends nothing. */
  destination: 'upload' | 'export'
  /** The build can be given to internal testers only: App Store Connect then refuses to hand it to external testers or the store. */
  internalOnly: boolean
}

export const TEAM_ID = /^[A-Z0-9]{10}$/

const escapeXml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function exportOptionsPlist(input: ExportOptionsInput): string {
  if (!TEAM_ID.test(input.teamId)) throw new Error(`the team "${input.teamId}" is not an Apple team identifier (ten capital letters and digits)`)
  if (input.destination !== 'upload' && input.destination !== 'export') throw new Error(`the destination "${String(input.destination)}" is neither upload nor export`)
  const entries: Array<[string, string]> = [
    // `app-store` is the name before Xcode 15.3; the help of Xcode 27 gives it as deprecated.
    ['method', '<string>app-store-connect</string>'],
    ['destination', `<string>${input.destination}</string>`],
    ['teamID', `<string>${escapeXml(input.teamId)}</string>`],
    // The archive is signed automatically (project.yml); the export signs it again for distribution in the same way.
    ['signingStyle', '<string>automatic</string>'],
    // The number the script chose is the number that is sent: Xcode does not change it on its own.
    ['manageAppVersionAndBuildNumber', '<false/>']
  ]
  if (input.internalOnly) entries.push(['testFlightInternalTestingOnly', '<true/>'])
  const body = entries.map(([key, value]) => `\t<key>${key}</key>\n\t${value}`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}
</dict>
</plist>
`
}
