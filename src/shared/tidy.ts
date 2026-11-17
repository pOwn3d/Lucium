// "Tidy": shorter, cleaner names for pinned tabs and downloaded files. Heuristics of our own,
// kept conservative: when nothing clearly improves a name, it is returned unchanged.

const TITLE_SEPARATOR = /\s+[|\-–—·•]\s+/
// Second-level labels that are part of a public suffix (example.co.uk → "example").
const SUFFIX_LABELS = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac'])

/** The part of a hostname that names the site: "mail.github.com" → "github", "bbc.co.uk" → "bbc". */
export function siteLabel(url: string): string {
  if (!URL.canParse(url)) return ''
  const labels = new URL(url).hostname.replace(/^www\./, '').split('.')
  if (labels.length < 2) return labels[0] ?? ''
  const last = labels.length - 1
  return labels[last - 1 - (labels[last]!.length === 2 && SUFFIX_LABELS.has(labels[last - 1]!) && labels.length > 2 ? 1 : 0)] ?? ''
}

/**
 * `text` without a count at its end, " (3)". The blanks are trimmed first and the pattern does not start with `\s*`: that one is tried again from every
 * blank of a long run before the parenthesis, and a run of 40 000 took close to a second.
 */
const withoutCount = (text: string): string => text.trimEnd().replace(/\(\d+\)$/, '').trimEnd()

const squash = (text: string) => text.replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase()

/**
 * A pinned tab's title shortened to the site's own name when the page title carries it:
 * "Pull requests · org/repo · GitHub" → "GitHub". Unread-count prefixes and suffixes ("(3) ") are dropped.
 */
export function tidyTitle(title: string, url: string): string {
  const cleaned = withoutCount(title.replace(/^\(\d+\)\s*/, '')).replace(/\s+/g, ' ').trim()
  if (!cleaned) return title
  const label = squash(siteLabel(url))
  if (label.length < 2) return cleaned
  const parts = cleaned.split(TITLE_SEPARATOR).map((p) => p.trim()).filter(Boolean)
  if (parts.length < 2) return cleaned
  // The part that is the site's name (a short one: "GitHub", not a long title that mentions it).
  const own = parts.find((p) => p.length <= 24 && squash(p).includes(label))
  return own ?? cleaned
}

// Control characters (C0, DEL, C1), the line and paragraph separators, and the bidirectional formatting characters.
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu

/** A downloaded file's name without the noise of machine-made names: "Rapport_final%20v2 (1).PDF" → "Rapport final v2.pdf". */
export function tidyFilename(filename: string): string {
  const dot = filename.lastIndexOf('.')
  const hasExtension = dot > 0 && filename.length - dot <= 9 && /^[A-Za-z0-9]+$/.test(filename.slice(dot + 1))
  const stem = hasExtension ? filename.slice(0, dot) : filename
  const extension = hasExtension ? filename.slice(dot).toLowerCase() : ''
  let name = stem
  try {
    name = decodeURIComponent(name)
  } catch {
    // A malformed escape (a stray "%") means the name was never URL-encoded: keep it literally.
  }
  name = withoutCount(
    name
      // Decoding brought back what Chromium had taken out of the name: NUL and other control characters, and the characters that reorder
      // text (U+202E turns "fdp.exe" into "exe.pdf" on screen). They are not part of any name worth keeping.
      .replace(UNSAFE_NAME_CHARS, '')
      .replace(/[\\/]+/g, ' ')
      .replace(/[_+]+/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .trim()
  return name ? `${name}${extension}` : filename.replace(UNSAFE_NAME_CHARS, '') || filename
}
