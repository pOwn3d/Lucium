// The system clipboard as the password service uses it for a password: the text and, in the same atomic write, the marker that tells clipboard
// managers not to keep it (the convention of nspasteboard.org, which 1Password and the others follow). Electron's promise-based
// clipboard writes a raw platform format through the `electron application/osclipboard;format="…"` key; whether macOS then carries the marker is
// the one thing only a real run can show (docs/gestionnaire-mots-de-passe.md §5).

/** The macOS pasteboard type that marks a copy as a secret. */
export const CONCEALED_TYPE = 'org.nspasteboard.ConcealedType'

/** The two things of Electron's clipboard that are used here, so that a test can stand in for them. */
export interface ElectronClipboardLike<Item> {
  write(items: Item[]): Promise<void>
}

/** Writes `text` and the concealed marker in one call: all the entries of a `write()` are committed together, so the text is never there unmarked. */
export function concealedWriter<Item>(clipboard: ElectronClipboardLike<Item>, makeItem: (entries: Record<string, string>) => Item): (text: string) => Promise<void> {
  return (text) => clipboard.write([makeItem({ 'text/plain': text, [`electron application/osclipboard;format="${CONCEALED_TYPE}"`]: '1' })])
}
