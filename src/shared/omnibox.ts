// chrome.omnibox, in its smallest honest form: an extension that declares a keyword ("omnibox": { "keyword": "gh" }) is reached from the
// command bar by typing the keyword, a space and some text, then Enter. The extension is told that input started, then that it was
// entered, with the text and where it should open (`onInputStarted`, `onInputEntered`). Nothing else of the API happens: no suggestions
// are asked for (`onInputChanged` never fires, `setDefaultSuggestion` is accepted and shows nothing) and no cancellation is reported.
// The keyword is read from the manifest by the engine; the line the bar sends back is checked here before anything is delivered.

import type { ExtensionInfo } from './ipc'

/** A keyword has no space and no control character, and is short: the same shape as the quick searches of the command bar. */
const KEYWORD = /^[^\s\p{Cc}]{1,30}$/u

/** The keyword an extension declared in its manifest, or undefined when it declared none that is usable. */
export function omniboxKeywordOf(manifest: unknown): string | undefined {
  if (typeof manifest !== 'object' || manifest === null) return undefined
  const omnibox = (manifest as { omnibox?: unknown }).omnibox
  if (typeof omnibox !== 'object' || omnibox === null) return undefined
  const keyword = (omnibox as { keyword?: unknown }).keyword
  return typeof keyword === 'string' && KEYWORD.test(keyword) ? keyword : undefined
}

/** Where the extension should open what it finds: the three values of `chrome.omnibox.OnInputEnteredDisposition`. */
export const OMNIBOX_DISPOSITIONS = ['currentTab', 'newForegroundTab', 'newBackgroundTab'] as const
export type OmniboxDisposition = (typeof OMNIBOX_DISPOSITIONS)[number]

/** What is typed after the keyword is a few words, not a document. */
export const OMNIBOX_TEXT_MAX = 2000

export interface OmniboxRequest {
  extensionId: string
  text: string
  disposition: OmniboxDisposition
}

const EXTENSION_ID = /^[a-p]{32}$/

/** The request of the command bar as the main process reads it: exactly these three fields, of these shapes, or nothing. */
export function parseOmniboxRequest(raw: unknown): OmniboxRequest | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const { extensionId, text, disposition, ...extra } = raw as Record<string, unknown>
  if (Object.keys(extra).length > 0) return null
  if (typeof extensionId !== 'string' || !EXTENSION_ID.test(extensionId)) return null
  if (typeof text !== 'string' || text.length > OMNIBOX_TEXT_MAX) return null
  if (typeof disposition !== 'string' || !(OMNIBOX_DISPOSITIONS as readonly string[]).includes(disposition)) return null
  return { extensionId, text, disposition: disposition as OmniboxDisposition }
}

/** The keyword and the text of what is typed in the bar: "gh react hooks" gives `gh` and `react hooks`. Null without a space after the first word. */
export function splitOmniboxInput(input: string): { keyword: string; text: string } | null {
  const match = /^(\S{1,30})\s([\s\S]*)$/.exec(input.trimStart())
  return match ? { keyword: match[1]!, text: match[2]!.slice(0, OMNIBOX_TEXT_MAX) } : null
}

/**
 * The extension a request is for, or the reason it is for none: the function is off, the window is private (no extension runs there), or
 * no extension that is on in this profile declared a keyword and has this id.
 */
export function omniboxTarget(on: boolean, isPrivate: boolean, profileId: string, extensions: readonly ExtensionInfo[], request: OmniboxRequest): ExtensionInfo | string {
  // The reasons are for the journal (browser-commands.ts writes them with console.warn), in English like the rest of it: the person sees none of them.
  if (!on) return 'extension keywords are off (Settings › Navigation and search)'
  if (isPrivate) return 'no extension runs in a private window'
  const found = extensions.find((e) => e.id === request.extensionId && e.profileId === profileId && e.enabled)
  if (!found) return `${request.extensionId} is not on in this profile`
  return found.omniboxKeyword === undefined ? `${found.name} declared no keyword` : found
}

/** What the extension is told, in this order: input started, then entered. Rejects when the worker cannot be reached; `entered` is not sent then. */
export async function deliverOmnibox(deliver: (event: 'onInputStarted' | 'onInputEntered', args: unknown[]) => Promise<void>, request: OmniboxRequest): Promise<void> {
  await deliver('onInputStarted', [])
  await deliver('onInputEntered', [request.text, request.disposition])
}
