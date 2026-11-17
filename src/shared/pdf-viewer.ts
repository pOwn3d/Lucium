// The PDF viewer of Chromium is an extension (its id has not changed in years). A PDF is drawn by a frame of that extension inside the tab,
// whatever the address of the document is: `/report.pdf`, `/download?id=3`, a blob served with the MIME type application/pdf.

export const PDF_VIEWER_ORIGIN = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/'

/** Whether the address of a frame is the PDF viewer's. */
export const isPdfViewerUrl = (url: string): boolean => url.startsWith(PDF_VIEWER_ORIGIN)
