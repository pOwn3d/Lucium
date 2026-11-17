// The one escape of a text put into HTML that the application writes itself (error pages, the reader, the PDF foot, the bookmarks file).

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** Text for an element or a quoted attribute (single or double quotes): the five characters HTML reads are replaced. */
export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => ESCAPES[c]!)
