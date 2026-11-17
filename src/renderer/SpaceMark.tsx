// What stands for a space in the sidebar (its header, the selector of the footer, the lists of spaces): its emoji, its coloured letters, or the picture the
// user chose for it, as `iconKind` says (shared/space-icon.ts). The picture lives in a file of the data folder; the interface only knows its name and asks
// the main process for it.

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import type { Space } from '@shared/model'
import { cleanIconLetter, letterStyle, spaceIconKind } from '@shared/space-icon'
import { api } from './api'

/** The pictures already fetched, by name: a name is never reused for another picture (they are named at random), so the cache never goes stale. */
const fetched = new Map<string, string>()

/** A stored picture (a space's or a tab's), as a `data:` URL once the main process has sent it; null until then, and for good if it cannot be read. */
export function useSpaceImage(name: string): string | null {
  const [url, setUrl] = useState<string | null>(() => fetched.get(name) ?? null)
  useEffect(() => {
    const known = fetched.get(name)
    if (known) return setUrl(known)
    setUrl(null)
    let live = true
    api()
      .spaceImage({ op: 'read', name })
      .then((reply) => {
        // A picture that cannot be read is let go of by the main process (the space shows its emoji again at the next snapshot).
        if (!live || !reply.ok || !reply.dataUrl) return
        fetched.set(name, reply.dataUrl)
        setUrl(reply.dataUrl)
      })
      .catch((error: unknown) => console.warn('[space image] cannot ask for the picture of a space:', error))
    return () => {
      live = false
    }
  }, [name])
  return url
}

function SpaceImage({ name, emoji, className }: { name: string; emoji: string; className: string }) {
  const url = useSpaceImage(name)
  // The emoji shows while the picture is on its way, and stays if it never comes.
  return url ? <img className={`space-image ${className}`} src={url} alt="" draggable={false} /> : <>{emoji}</>
}

/** The letters of a space on their colour: white on the colours the picker offers (all of them hold 4.5:1), round or rounded square as chosen. */
function SpaceLetters({ space, className }: { space: Pick<Space, 'iconLetter' | 'iconColor' | 'iconRound'>; className: string }) {
  const { color, round } = letterStyle(space)
  return (
    <span className={`space-letter ${className}${round ? ' round' : ''}`} style={{ background: color } as CSSProperties} aria-hidden="true">
      {cleanIconLetter(space.iconLetter)}
    </span>
  )
}

/**
 * The icon a space wears: its picture, its coloured letters or its emoji. `enabled` is what the setting "Choisir une image pour un espace" used to be: since
 * the unified picker the space's own choice decides, and the prop is kept only for the callers that still pass it.
 */
export function SpaceMark({ space, className }: { space: Pick<Space, 'emoji' | 'image' | 'iconKind' | 'iconLetter' | 'iconColor' | 'iconRound'>; className: string }): ReactNode {
  const kind = spaceIconKind(space)
  if (kind === 'image' && space.image) return <SpaceImage name={space.image} emoji={space.emoji} className={className} />
  if (kind === 'letter') return <SpaceLetters space={space} className={className} />
  return <>{space.emoji}</>
}
