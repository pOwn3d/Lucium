// When a page's language is read for the translation entry (electron-page.ts): once per document of the page, and only while the translation
// is on (`translateLocal`): switched off, no page is read at all. Without a lang attribute the reading samples the text of the whole page, a
// layout of all of it, and the frames of a page (advertisements, widgets) end their loading again and again, long after the page itself, in the
// background too.

export class LanguageReads {
  private read = false
  /** The number of the document on show: one more at each navigation. */
  private shown = 0

  /** Another document of the page is on show (a navigation of the page, or one within it): its language is still to be read. */
  navigated(): void {
    this.read = false
    this.shown++
  }

  /** The document on show, as a number that a reading begun now keeps (`current`). */
  document(): number {
    return this.shown
  }

  /** Whether `document` is still the one on show: the answer of a reading begun before a navigation is another document's, and is dropped. */
  current(document: number): boolean {
    return document === this.shown
  }

  /**
   * At the end of a loading: true the first time for the document on show, when the caller reads its language; false after that. `wanted`:
   * the translation is on. Off, nothing is read and nothing is used up: a document that loaded while it was off is read at its next end of
   * loading once it is on.
   */
  take(wanted = true): boolean {
    if (!wanted || this.read) return false
    this.read = true
    return true
  }

  /** The reading failed: the next end of loading tries again. */
  failed(): void {
    this.read = false
  }
}
