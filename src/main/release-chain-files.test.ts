import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The chain that moves Lucium to a newer Electron (docs/mise-a-jour-chromium.md): the two scripts of package.json, and the notarization, which
// goes through a keychain profile. Checked as text: the scripts read the network and the workflow runs on GitHub, so neither is run here; what
// must not change silently is that the notarization never holds a secret.
const here = (relative: string) => fileURLToPath(new URL(`../../${relative}`, import.meta.url))
const read = (relative: string) => readFileSync(here(relative), 'utf8')

/** The lines that are not comments (`//` in a script, `#` in YAML), so that a comment cannot pass for code. */
const code = (text: string, mark: string): string =>
  text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith(mark))
    .join('\n')

describe('the scripts of package.json', () => {
  const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts

  it('run the watch and the upgrade as they are, with nothing added', () => {
    expect(scripts['electron:watch']).toBe('node scripts/electron-watch.mjs')
    expect(scripts['electron:upgrade']).toBe('node scripts/electron-upgrade.mjs')
    expect(existsSync(here('scripts/electron-watch.mjs'))).toBe(true)
    expect(existsSync(here('scripts/electron-upgrade.mjs'))).toBe(true)
  })

  it('leave the line the upgrade rewrites alone: "electron": "<version>" is in package.json once', () => {
    expect(read('package.json').match(/"electron": "/g)).toHaveLength(1)
  })
})

describe('the notarization of scripts/electron-upgrade.mjs', () => {
  const script = code(read('scripts/electron-upgrade.mjs'), '//')

  it('is switched on since the keychain profile exists, and keeps the refusal of --notarize for when it is switched off', () => {
    expect(script).toMatch(/^const NOTARIZATION_ENABLED = true$/m)
    expect(script).toMatch(/if \(args\.notarize && !NOTARIZATION_ENABLED\) throw new Error\(/)
  })

  it('comes after the build and before the report, and is skipped without --notarize', () => {
    expect(script).toContain("const STEPS = ['check', 'branch', 'bump', 'typecheck', 'test', 'ecs', 'build', 'notarize', 'report']")
    expect(script).toMatch(/if \(!args\.notarize\) return say\(`notarize : sautée/)
  })

  it('needs the signature and a keychain profile, and reads no credential itself', () => {
    expect(script).toMatch(/if \(args\.notarize && !args\.sign\) throw/)
    expect(script).toMatch(/if \(args\.notarize && !process\.env\.LUCIUM_NOTARY_PROFILE\?\.trim\(\)\) throw/)
    expect(script).toContain("'--keychain-profile', profile")
    expect(script).not.toMatch(/--password|--apple-id|'--key'|APPLE_API_KEY|APPLE_ID|APPLE_APP_SPECIFIC_PASSWORD/)
  })

  it('refuses an answer of Apple other than Accepted, then staples and checks the ticket', () => {
    expect(script).toMatch(/submit\.status !== 0 \|\| answer\?\.status !== 'Accepted'\) fail\(/)
    // An answer that is not JSON is a failure that says so, never an acceptance.
    expect(script).toMatch(/answer = \{ status: `réponse illisible de notarytool, code \$\{submit\.status\}` \}/)
    for (const step of ["run('xcrun', ['stapler', 'staple', builtApp])", "run('xcrun', ['stapler', 'validate', builtApp])", "run('spctl', ['--assess', '--type', 'execute', '-vv', builtApp])"]) expect(script).toContain(step)
  })
})

// The step downloads from castLabs and is not run here; the decision is src/main/ecs-checksum.ts (tested there). What must not change silently:
// the step asks that function, refuses on its answer, and only then fetches the archive.
describe('the ecs step of scripts/electron-upgrade.mjs', () => {
  const script = code(read('scripts/electron-upgrade.mjs'), '//')

  it('downloads the archive only once SHASUMS256.txt, checksums.json and scripts/ecs-checksums.json agree', () => {
    const decide = script.indexOf('const check = expectedEcsSum({ tag, zipName, shasums: sums, checksumsJson: treeSums, pinned })')
    const refuse = script.indexOf("if (!check.ok) fail(`${check.reason} : rien n'est téléchargé`)")
    const download = script.indexOf('const response = await fetch(`${base}/${zipName}`')
    expect(decide).toBeGreaterThan(0)
    expect(refuse).toBeGreaterThan(decide)
    expect(download).toBeGreaterThan(refuse)
    expect(script).toContain("readPinnedEcsSums(readFileSync(join(root, 'scripts/ecs-checksums.json'), 'utf8'))")
  })
})

// Production builds and their publication are the maintainer's, made on their Mac (GOVERNANCE.md, docs/community/release-process.md): no
// workflow signs, notarizes or publishes an update, and none is given a secret it could leak to a pull request.
describe('the workflows of .github/workflows', () => {
  const dir = here('.github/workflows')
  const workflows = readdirSync(dir).filter((name) => /\.ya?ml$/.test(name)).map((name) => ({ name, text: code(readFileSync(`${dir}/${name}`, 'utf8'), '#') }))

  it('are read: the release workflow is among them', () => {
    expect(workflows.map((w) => w.name)).toContain('release.yml')
  })

  it('hold no secret of GitHub, and neither sign, notarize nor publish an update', () => {
    for (const { name, text } of workflows) {
      expect(text, name).not.toMatch(/\bsecrets\./)
      expect(text, name).not.toMatch(/notarytool|stapler staple|codesign --sign|package:signed|CSC_LINK|APPLE_API_|publish-update|LUCIUM_SIGN_IDENTITY/)
    }
  })

  it('the release workflow builds nothing: no macOS runner, nothing installed, no package, no artifact', () => {
    const release = workflows.find((w) => w.name === 'release.yml')!.text
    expect(release.match(/^ {4}runs-on: .+$/gm)).toEqual(['    runs-on: ubuntu-latest'])
    expect(release).not.toMatch(/pnpm|npm |electron-builder|electron-vite|ditto|upload-artifact|download-artifact/)
    expect(release.match(/uses: [\w./-]+@/g)).toEqual(['uses: actions/checkout@'])
  })
})

// What people download is the DRM variant signed and notarized on the maintainer's Mac, and it is on lucium.app. The Release of GitHub is a
// draft that holds the notes, the SHA-256 sums of those files and a link: no workflow ever puts an application in it.
describe('the draft release of .github/workflows/release.yml', () => {
  const workflow = code(read('.github/workflows/release.yml'), '#')

  it('is a draft with no file, created only by a pushed tag', () => {
    expect(workflow).toMatch(/^on:\n {2}push:\n {4}tags: \['v\*'\]\n {2}workflow_dispatch:$/m)
    expect(workflow).toMatch(/FLAGS=\(--draft --verify-tag --title "Lucium \$VERSION" --notes-file release-notes\.md\)/)
    expect(workflow).toMatch(/\n {8}if: \$\{\{ github\.event_name == 'push' \}\}\n {8}run: \|\n[\s\S]*\n {10}gh release create "\$TAG" "\$\{FLAGS\[@\]\}"\n/)
    // One call, with the tag and the flags and nothing after them: a path there would be attached.
    expect(workflow.match(/gh release \w+[^\n]*/g)).toEqual(['gh release create "$TAG" "${FLAGS[@]}"'])
  })

  it('refuses a tag that is not the version of package.json, and a tag without annotation', () => {
    expect(workflow).toMatch(/if \[ "\$TAG" != "v\$VERSION" \]; then\n[^\n]*::error::[^\n]*\n\s+exit 1\n/)
    expect(workflow).toMatch(/if \[ "\$\(jq -r \.object\.type tag-ref\.json\)" != "tag" \]; then\n[^\n]*::error::[^\n]*\n\s+exit 1\n/)
    expect(workflow).toMatch(/jq -r \.message tag-object\.json > tag-message\.txt/)
  })

  it('writes in the notes the sums read from the tag and the link to the site, and describes the signed and notarized download', () => {
    expect(workflow).toMatch(/echo '### SHA-256'\n[\s\S]*\n\s+cat checksums\.txt\n/)
    expect(workflow).toContain('**[lucium.app](https://lucium.app/en/download/)**')
    expect(workflow).toMatch(/signed with a Developer ID and notarized by Apple/)
    expect(workflow).toContain('This Release holds no application')
    expect(workflow).not.toMatch(/not signed or notarized|Unsigned means unsealed/i)
  })
})
