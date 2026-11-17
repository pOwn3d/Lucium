// Makes the key the update feed is signed with, and checks the public keys the builds carry. Run by the maintainer, on the Mac that publishes.
//
//   node scripts/feed-key.mjs            makes the key pair, once: the private key in the folder below, the public key printed
//   node scripts/feed-key.mjs --next     makes the pair that takes over, for a change of key (docs/community/release-process.md)
//   node scripts/feed-key.mjs --show     prints the public key of each private key that is there (nothing is made)
//   node scripts/feed-key.mjs --check    checks the public keys of src/main/update-feed-keys.ts, and prints them: no private key is read.
//                                        scripts/build-drm-release.sh runs it before a build that will be handed out
//
// The private key is written in ~/Library/Application Support/lucium-secrets/ (or the folder the environment variable LUCIUM_FEED_KEY_DIR
// names), as feed-key.pem (feed-key-next.pem with --next), mode 600, in a folder of mode 700. It is NEVER printed, and a key that is there
// is never replaced: the script stops instead. Only scripts/publish-update.mjs reads it, to sign a feed.
//
// The public key is printed with where it goes: the list UPDATE_FEED_PUBLIC_KEYS of src/main/update-feed-keys.ts. It is not a secret.
// Keep a copy of the private key somewhere safe and offline before the first publication: a lost key means that no installed copy
// believes a feed any more.
//
// Exit code: 0 done, 1 refused (a key is there already, a public key is wrong: it says which), 2 the arguments are wrong.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

process.removeAllListeners('warning')
process.on('warning', (warning) => {
  if (/** @type {NodeJS.ErrnoException} */ (warning).code !== 'MODULE_TYPELESS_PACKAGE_JSON') console.error(`${warning.name}: ${warning.message}`)
})
const { FEED_KEY_FILE, FEED_KEY_FOLDER, NEXT_FEED_KEY_FILE, PREVIOUS_FEED_KEY_FILE, newFeedKeyPair, publicKeyOfPrivate, publicKeyProblems } = await import('../src/main/update-feed-signature.ts')
const { UPDATE_FEED_PUBLIC_KEYS } = await import('../src/main/update-feed-keys.ts')

const usage = () => console.error(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'))
const args = process.argv.slice(2)
const MODES = ['--next', '--show', '--check']
if (args.includes('--help') || args.includes('-h')) {
  usage()
  process.exit(0)
}
if (args.length > 1 || (args.length === 1 && !MODES.includes(args[0]))) {
  console.error(`Error: one option at most, among ${MODES.join(', ')}`)
  usage()
  process.exit(2)
}
const mode = args[0] ?? '--make'
const KEYS_FILE = 'src/main/update-feed-keys.ts'

if (mode === '--check') {
  const problems = publicKeyProblems(UPDATE_FEED_PUBLIC_KEYS)
  if (problems.length > 0) {
    for (const problem of problems) console.error(`❌ ${problem}`)
    process.exit(1)
  }
  for (const key of UPDATE_FEED_PUBLIC_KEYS) console.log(key)
  process.exit(0)
}

const dir = process.env.LUCIUM_FEED_KEY_DIR?.trim() || join(homedir(), ...FEED_KEY_FOLDER)

if (mode === '--show') {
  let found = 0
  for (const name of [FEED_KEY_FILE, NEXT_FEED_KEY_FILE, PREVIOUS_FEED_KEY_FILE]) {
    const path = join(dir, name)
    if (!existsSync(path)) continue
    found++
    try {
      const publicKey = publicKeyOfPrivate(readFileSync(path, 'utf8'))
      console.log(`${name}: public key ${publicKey}${UPDATE_FEED_PUBLIC_KEYS.includes(publicKey) ? ` (in ${KEYS_FILE})` : ` (NOT in ${KEYS_FILE})`}`)
    } catch (error) {
      console.error(`❌ ${path} cannot be used: ${error instanceof Error ? error.message : String(error)}`)
      process.exit(1)
    }
  }
  if (found === 0) {
    console.error(`❌ No key of the feed in ${dir}: \`node scripts/feed-key.mjs\` makes one`)
    process.exit(1)
  }
  process.exit(0)
}

const name = mode === '--next' ? NEXT_FEED_KEY_FILE : FEED_KEY_FILE
const path = join(dir, name)
// lstat, not exists: a link that leads nowhere is still a name that is taken.
if (lstatSync(path, { throwIfNoEntry: false })) {
  console.error(`❌ ${path} is there already, and is never replaced: installed copies believe the feeds it signs.`)
  console.error(`   Its public key: node scripts/feed-key.mjs --show. To change the key: docs/community/release-process.md, "The key of the update feed".`)
  process.exit(1)
}
if (mode === '--next' && !existsSync(join(dir, FEED_KEY_FILE))) {
  console.error(`❌ ${join(dir, FEED_KEY_FILE)} does not exist: --next makes the key that takes over from it. Without a first key, run the script with no option`)
  process.exit(1)
}
mkdirSync(dir, { recursive: true, mode: 0o700 })
const pair = newFeedKeyPair()
// 'wx': the file is made here or not at all, so that a key written meanwhile is not replaced. The mode is set again, whatever the umask.
writeFileSync(path, pair.privatePem, { mode: 0o600, flag: 'wx' })
chmodSync(path, 0o600)

console.log(`✅ The private key is written: ${path} (mode 600). It is not shown, here or anywhere.`)
console.log('')
console.log(`The public key, to put in the list UPDATE_FEED_PUBLIC_KEYS of ${KEYS_FILE}:`)
console.log('')
console.log(`  '${pair.publicKey}'`)
console.log('')
if (mode === '--next') {
  console.log('Add it AFTER the key that is there (two keys during the change), build and publish a version, and follow')
  console.log('docs/community/release-process.md, "The key of the update feed", for the rest of the change.')
} else {
  console.log(`Commit ${KEYS_FILE}, then check: node scripts/feed-key.mjs --check`)
}
console.log('Copy the private key to a safe place that is not this Mac (an encrypted disk kept offline) before the first publication.')
