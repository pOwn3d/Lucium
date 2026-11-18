// The build number of an archive (CFBundleVersion). App Store Connect wants a larger number at every send of the same version, so a send needs
// a new one. It is made from the clock and handed to `xcodebuild` on the command line
// (CURRENT_PROJECT_VERSION): nothing is committed and no counter has to be kept, on this Mac or another.
//
// The number is the count of minutes since 1 January 2026, UTC: a whole number that grows with time (about 462 600 on 18 November 2026), with no dots and no
// leading zeros to be read two ways. Two sends in the same minute give the same number: the second is refused by App Store Connect, and `--build` gives it another.
//
// Pure. Loaded by Node with type stripping: no enum, no parameter property.

const EPOCH = Date.UTC(2026, 0, 1)

/** A number this script hands over: whole, no leading zero, at most nine digits (a limit of this script, below what a 32-bit reader holds). */
export const isBuildNumber = (text: string): boolean => /^[1-9]\d{0,8}$/.test(text)

/** The build number for a send made at `now`. Throws for a clock set before 2026: a number made from it would be smaller than a real one. */
export function buildNumber(now: Date): string {
  const minutes = Math.floor((now.getTime() - EPOCH) / 60_000)
  if (!Number.isFinite(minutes) || minutes < 1) throw new Error('the clock of this Mac is before 1 January 2026: a build number made from it would be lower than the ones already sent')
  return String(minutes)
}
