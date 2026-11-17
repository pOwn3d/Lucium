// What a page summary asks the local model (Ollama, in ollama.ts): its length, the instruction, and the address of the page that goes with
// the text. Nothing here calls the network.

import { getLanguage, type Language } from './i18n'

/** How long the summary is: short (two or three sentences), normal (five at most), long (detailed, with titles and lists). */
export const SUMMARY_LENGTHS = ['short', 'normal', 'long'] as const
export type SummaryLength = (typeof SUMMARY_LENGTHS)[number]

/** How long the summary is, as the instruction says it, in each language of the interface. */
const LENGTH_INSTRUCTION: Readonly<Record<Language, Record<SummaryLength, string>>> = {
  fr: {
    short: 'en deux ou trois phrases',
    normal: 'en cinq phrases au plus',
    long: 'en détail, avec des intertitres et des listes quand cela aide à lire'
  },
  en: {
    short: 'in two or three sentences',
    normal: 'in five sentences at most',
    long: 'in detail, with subheadings and lists when that helps reading'
  }
}

/** The most output tokens a summary may take, by length. */
export const LENGTH_TOKENS: Record<SummaryLength, number> = { short: 300, normal: 800, long: 2000 }

/** The most characters of a page given to the model, by length: the rest is not read. */
export const LENGTH_CHARS: Record<SummaryLength, number> = { short: 8000, normal: 8000, long: 16000 }

/** The address given with the page text: its origin and path. The query and the fragment (often a token, an identifier or a search) are left out. */
export function addressForSummary(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return ''
  }
}

/** The instruction the model gets with the page text: the summary is written in the language of the interface. */
export const summaryPrompt = (text: string, url: string, length: SummaryLength = 'normal', language: Language = getLanguage()): string =>
  language === 'en'
    ? `Summarize in English ${LENGTH_INSTRUCTION.en[length]} the text of this web page (${url}). Format the answer in Markdown: a short title if it helps, the points as a bulleted list, the key ideas in **bold**. Give only the summary.\n\n${text}`
    : `Résume en français ${LENGTH_INSTRUCTION.fr[length]} le texte de cette page web (${url}). Mets la réponse en markdown : un court titre si cela aide, les points en liste à puces, les notions clés en **gras**. Ne donne que le résumé.\n\n${text}`
