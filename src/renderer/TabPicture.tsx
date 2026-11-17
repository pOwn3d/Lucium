// What stands for a tab: the picture the user chose for it, else its emoji, else its site's icon (SidebarRows.tsx `Favicon`). The picture lives in a
// file of the data folder, like a space's (shared/space-image.ts); the interface knows its name only and asks the main process for it.

import type { TabItem } from '@shared/model'
import { Favicon } from './SidebarRows'
import { useSpaceImage } from './SpaceMark'

/** The picture of a tab; the site's icon shows while it is on its way, and stays if it never comes (the main process then lets the name go). */
function TabImage({ tab, name }: { tab: Pick<TabItem, 'faviconUrl' | 'url' | 'title'>; name: string }) {
  const url = useSpaceImage(name)
  return url ? <img className="favicon tab-picture" src={url} alt="" draggable={false} /> : <Favicon tab={tab} />
}

/** The icon of a tab, as the user chose it: a picture, an emoji, or the site's own. */
export function TabMark({ tab }: { tab: Pick<TabItem, 'faviconUrl' | 'url' | 'title' | 'icon' | 'image'> }) {
  if (tab.image) return <TabImage tab={tab} name={tab.image} />
  if (tab.icon) return <span className="favicon emoji-icon">{tab.icon}</span>
  return <Favicon tab={tab} />
}
