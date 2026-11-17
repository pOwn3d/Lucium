// How the journal of an extension follows its last line (ExtensionsPage.tsx). The journal is read again every second and a half: only its own list
// moves, and only when the reader was already at its end. Asking the last line to come into view moved every scrolling parent of the list, the
// page included, at each line that came, and took a reader of older lines back to the end.

/** What of a scrolling box these rules read and write. */
export type ScrollBox = Pick<HTMLElement, 'scrollTop' | 'scrollHeight' | 'clientHeight'>

/** How far from its end, in pixels, a list still counts as being at its end (a fraction of a pixel is left by a zoom). */
export const JOURNAL_END_SLACK = 8

/** Whether the list shows its last line. */
export function journalAtEnd(box: ScrollBox): boolean {
  return box.scrollHeight - box.scrollTop - box.clientHeight <= JOURNAL_END_SLACK
}

/** After lines came: the list goes to its end when it was there before them, and stays where the reader put it otherwise. */
export function followJournal(box: ScrollBox, wasAtEnd: boolean): void {
  if (wasAtEnd) box.scrollTop = box.scrollHeight
}
