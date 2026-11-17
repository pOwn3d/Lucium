// "Enregistrer en PDF avec l'adresse…": the page printed to a PDF with its address and the date at the foot of every page. The address is
// the page's and the template is HTML that Chromium lays out, so what goes into it is escaped; the address shown never carries a
// password (the part before "@") nor the fragment.

import { suggestedFileName } from './file-names'
import { escapeHtml } from './html-escape'
import { getLanguage } from './i18n'

/** The longest address written at the foot of a page: a longer one is cut with an ellipsis (the foot is a single line). */
export const PDF_ADDRESS_MAX = 400

/** The address of a web page as it is written in the foot: http or https only, without credentials or fragment; null for anything else. */
export function pdfSourceAddress(url: unknown): string | null {
  if (typeof url !== 'string' || !URL.canParse(url)) return null
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  parsed.username = ''
  parsed.password = ''
  parsed.hash = ''
  const text = parsed.href
  return text.length > PDF_ADDRESS_MAX ? `${text.slice(0, PDF_ADDRESS_MAX)}…` : text
}

export { escapeHtml }

/** "24 octobre 2026", and "24 October 2026" for an interface in English: the foot of the page is in the language of the one who prints it. */
export const pdfDateText = (date: Date): string => date.toLocaleDateString(getLanguage() === 'fr' ? 'fr-FR' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' })

/** No header: Chromium would otherwise print the title and the date of its own at the top of each page. */
export const PDF_HEADER_TEMPLATE = '<span></span>'

/** The foot of every page: the address on the left (cut when too long), the date and "page n/N" on the right. Null when the address is not a web page's. */
export function pdfFooterTemplate(url: unknown, date: Date): string | null {
  const address = pdfSourceAddress(url)
  if (address === null) return null
  return (
    '<div style="width:100%;box-sizing:border-box;padding:0 10mm;display:flex;justify-content:space-between;gap:8px;' +
    "font:8px -apple-system,'Helvetica Neue',Arial,sans-serif;color:#555\">" +
    `<span style="min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${escapeHtml(address)}</span>` +
    `<span style="white-space:nowrap">${escapeHtml(pdfDateText(date))} · <span class="pageNumber"></span>/<span class="totalPages"></span></span>` +
    '</div>'
  )
}

/** What `webContents.printToPDF` is given: the foot, room for it in the margin, the page's backgrounds as they are on screen. Null when there is no foot to print. */
export function pdfPrintOptions(url: unknown, date: Date): { displayHeaderFooter: true; headerTemplate: string; footerTemplate: string; printBackground: true; margins: { top: number; bottom: number; left: number; right: number } } | null {
  const footerTemplate = pdfFooterTemplate(url, date)
  if (footerTemplate === null) return null
  return { displayHeaderFooter: true, headerTemplate: PDF_HEADER_TEMPLATE, footerTemplate, printBackground: true, margins: { top: 0.4, bottom: 0.7, left: 0.4, right: 0.4 } }
}

/** The name proposed for the file: the title of the page, cleaned, with ".pdf" (the title is the page's, so it is cleaned like a download's name). */
export function pdfFileName(title: unknown): string {
  // A title is not a path: "AC/DC" must not lose "AC", and macOS shows a ":" of a file name as "/" in the Finder. Both become a dash.
  const name = suggestedFileName(typeof title === 'string' && title.trim() !== '' ? title.replace(/[/:]/g, '-') : 'page')
  return /\.pdf$/i.test(name) ? name : `${name}.pdf`
}
