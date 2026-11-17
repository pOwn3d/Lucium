// The name of a window (the Window menu, Mission Control): the page's own <title> is only the application's name, and the name in the language
// of the interface is known once the first snapshot has set it. Written after the drawing is kept, never during it: a drawing React gives up
// writes nothing.

import { useEffect } from 'react'

/** Names the window `title`; null (the language is not known yet) leaves the name it has. */
export function useWindowTitle(title: string | null): void {
  useEffect(() => {
    if (title !== null) document.title = title
  }, [title])
}
