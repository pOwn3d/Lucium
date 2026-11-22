/** The most bytes of a request's body `chrome.webRequest.onBeforeRequest` hands to an extension: past it the extension is told so, and gets none. */
export const REQUEST_BODY_MAX = 256 * 1024

/** A part of an upload as the browser engine tells it (the fields of Electron's `UploadData` that matter here). */
export interface UploadPart {
  bytes?: Uint8Array
  file?: string
  blobUUID?: string
}

/** `details.requestBody` of the extension platform, as far as Lucium fills it: raw parts, or an error. The form is not parsed (the engine does not say the content type at this point). */
export interface RequestBody {
  error?: string
  raw?: Array<{ bytes?: ArrayBuffer; file?: string }>
}

/**
 * What an extension that asked for `requestBody` is told of the upload of a request, bounded. The bytes are copied (the engine's buffers are not the extension's), a file is
 * named by its own name and not by its path (the path is on this machine and says who the person is), and what cannot be read here (a blob) is left out.
 */
export function requestBodyOf(parts: readonly UploadPart[] | undefined): RequestBody | undefined {
  if (!parts || parts.length === 0) return undefined
  let total = 0
  for (const part of parts) total += part.bytes?.byteLength ?? 0
  if (total > REQUEST_BODY_MAX) return { error: 'The body of the request is too large to be handed over.' }
  const raw: NonNullable<RequestBody['raw']> = []
  for (const part of parts) {
    if (part.bytes) raw.push({ bytes: part.bytes.slice().buffer as ArrayBuffer })
    else if (typeof part.file === 'string' && part.file !== '') raw.push({ file: part.file.split(/[\\/]/).pop() ?? '' })
  }
  return { raw }
}
