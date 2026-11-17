// The public keys an update feed must be signed by (update-feed-signature.ts). They are compiled into the main process, hence into app.asar,
// which the integrity fuse and the Developer ID signature seal: a copy believes a feed only when one of these keys signed it.
//
// One key in normal times; two only while the key is being changed (docs/community/release-process.md, "The key of the update feed").
// Each is the 32 bytes of an Ed25519 public key in base64, as `node scripts/feed-key.mjs` prints it. A public key is not a secret. The private
// key never comes into the repository.
//
// While the list is empty, every feed is refused, and scripts/build-drm-release.sh (a build with a feed, or a notarized one) and
// `pnpm verify:app` stop.
export const UPDATE_FEED_PUBLIC_KEYS: readonly string[] = ['ArVqiRUZ8yFs6JCJ88ArgQ71+RTKmcMnAbfhMwwfZIg=']
