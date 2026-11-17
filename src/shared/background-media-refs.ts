// The media files a space background refers to: a picture, a GIF or a video kept in the media folder. Pure, so the sweep
// that deletes what nothing refers to can be tested without a disk.

interface BackgroundRef {
  background?: { type: string; value: string } | undefined
}

/** The file names of every media background of these spaces. A colour background has no file. */
export function referencedBackgroundFiles(spaces: readonly BackgroundRef[]): Set<string> {
  const names = new Set<string>()
  for (const space of spaces) {
    const background = space.background
    if (background && background.type !== 'color' && typeof background.value === 'string' && background.value !== '') names.add(background.value)
  }
  return names
}
