// What the translations of the session keep of the pages (translate/memory.ts: the texts of the pages translated, and their translations, in
// memory) goes when the user erases what was browsed: a profile's data, the browsing history, the data of a site. The memory is a cache, so all of
// it goes each time: it cannot tell which profile a text came from, and what is lost is only the time to translate a text again.

import { sessionTranslations } from '../translate/memory'

export function forgetTranslations(): void {
  sessionTranslations.clear()
}
