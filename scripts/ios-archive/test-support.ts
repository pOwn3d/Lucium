// What the tests of the archive step share: a folder of embedded filter lists made the way the real one is made, and a copy of the repository's
// scripts in a temporary root, with stand-ins for `xcodebuild`, `xcodegen` and `plutil` first on the PATH. The script under test is run from that root, so
// that whatever it does (or stops doing, if a guard is removed) can never reach the real Xcode, a certificate or Apple.
import { chmodSync, cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { convertList, WEBKIT_RULE_LIMIT } from '../ios-filter-lists/abp-to-webkit'
import { buildEmbedded, EMBEDDED_LIST_IDS, type ListInput, type ListSource } from '../ios-filter-lists/embedded-lists'

export const REPO = join(__dirname, '../..')

const sample = '! Version: 202611171200\n||ads.example^\n##.banner\n'
const source = (id: string): ListSource => ({
  id,
  title: { en: id, fr: id },
  category: 'ads',
  author: { en: 'The authors', fr: 'Les auteurs' },
  license: { en: 'GPL-3.0', fr: 'GPL-3.0' },
  licenseUrl: 'https://example.org/licence',
  homepage: 'https://example.org/',
  sourceUrl: `https://example.org/${id}.txt`
})

/** The files of a whole folder of embedded lists (every id the application embeds, small), name → content: what `node scripts/ios-filter-lists.mjs` writes. */
export function wholeListsFolder(ids: readonly string[] = EMBEDDED_LIST_IDS): Record<string, string> {
  const inputs: ListInput[] = ids.map((id) => ({ source: source(id), text: sample, fetchedAt: '2026-11-17T20:00:00Z', converted: convertList(sample) }))
  return buildEmbedded(inputs, '2026-11-17T20:05:00Z', WEBKIT_RULE_LIMIT).files
}

export const stubs: Record<string, string> = {
  uname: 'echo Darwin',
  xcodegen: 'echo "xcodegen $*" >> "$STUB_LOG"',
  // The Info.plist of an archive is read with plutil on a Mac; here the stand-in hands the XML file back as it is.
  plutil: 'cat "${@: -1}"',
  xcodebuild: `
if [ "\${1:-}" = "-version" ]; then echo "Xcode (stand-in)"; exit 0; fi
echo "xcodebuild $*" >> "$STUB_LOG"
# The PATH each run was given, one line per run: Xcode starts the "rsync" it finds there (ios-archive-script.test.ts).
echo "$PATH" >> "$STUB_LOG.path"
fail="\${STUB_FAIL:-}"
build=""; archive=""; export_path=""
for argument in "$@"; do case "$argument" in CURRENT_PROJECT_VERSION=*) build="\${argument#CURRENT_PROJECT_VERSION=}" ;; esac; done
previous=""
for argument in "$@"; do
  case "$previous" in -archivePath) archive="$argument" ;; -exportPath) export_path="$argument" ;; esac
  previous="$argument"
done
if [ "$1" = "archive" ]; then
  [ "$fail" = archive ] && { echo "error: stand-in archive failure"; exit 65; }
  app="$archive/Products/Applications/Lucium.app"
  mkdir -p "$app"
  for name in \${STUB_APP_FILES:-}; do echo x > "$app/$name"; done
  cat > "$archive/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>ApplicationProperties</key><dict>
<key>CFBundleIdentifier</key><string>\${STUB_ARCHIVE_ID:-app.lucium.browser.ios}</string>
<key>CFBundleVersion</key><string>\${STUB_ARCHIVE_BUILD:-$build}</string>
</dict></dict></plist>
PLIST
fi
if [ "$1" = "-exportArchive" ]; then
  [ "$fail" = export ] && { echo "error: stand-in export failure"; exit 70; }
  mkdir -p "$export_path"; echo x > "$export_path/Lucium.ipa"
fi
`
}

export interface FakeRoot {
  root: string
  /** A folder of stand-ins for the tools, to be put first on the PATH. */
  bin: string
  /** Every command the stand-ins were asked to run, one per line; the file does not exist if none was. */
  log: string
}

/**
 * A copy of the scripts of the archive step, of the converter whose modules they read and of the project file, with the application's folders:
 * the page guard is the real one (committed); the filter lists are the ones given (none: the checkout as it is without a run of the lists).
 */
export function fakeRoot(lists: Record<string, string> | null): FakeRoot {
  const root = mkdtempSync(join(tmpdir(), 'lucium-ios-archive-'))
  mkdirSync(join(root, 'scripts'), { recursive: true })
  cpSync(join(REPO, 'scripts/ios-archive.sh'), join(root, 'scripts/ios-archive.sh'))
  cpSync(join(REPO, 'scripts/ios-archive'), join(root, 'scripts/ios-archive'), { recursive: true, filter: (path) => !path.endsWith('.test.ts') })
  cpSync(join(REPO, 'scripts/ios-filter-lists'), join(root, 'scripts/ios-filter-lists'), { recursive: true, filter: (path) => !path.endsWith('.test.ts') && !path.includes('fixtures') })
  mkdirSync(join(root, 'ios/Lucium'), { recursive: true })
  cpSync(join(REPO, 'ios/project.yml'), join(root, 'ios/project.yml'))
  cpSync(join(REPO, 'ios/Lucium/Guard'), join(root, 'ios/Lucium/Guard'), { recursive: true })
  if (lists) {
    mkdirSync(join(root, 'ios/Lucium/FilterLists'))
    for (const [name, content] of Object.entries(lists)) writeFileSync(join(root, 'ios/Lucium/FilterLists', name), content)
  }
  const bin = join(root, 'bin')
  mkdirSync(bin)
  for (const [name, body] of Object.entries(stubs)) {
    writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  return { root, bin, log: join(root, 'stand-in.log') }
}

/** The names of the files a whole application carries beside its code: the lists and the guard, as a space-separated word list for the stand-in. */
export const appFilesFor = (lists: Record<string, string>): string => [...Object.keys(lists), 'guard-runtime.js', 'guard-rules.json'].join(' ')

export const scriptOf = (root: string): string => join(root, 'scripts/ios-archive.sh')
