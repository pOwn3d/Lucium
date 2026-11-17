// The surface of Lucium's floating video window: its bar, laid over the page (shell/floating-video.ts). The language and the accessibility
// preferences are the interface's (the first snapshot); the window itself comes and goes with the video it floats.

import { mountRoot } from './root'
import { api, useSnapshot } from './api'
import { FloatingVideoBar } from './FloatingVideoBar'
import type { FloatingVideoCommand } from '@shared/floating-video'
import './floating-video.css'
import { lockDocumentDrops } from './surface'

lockDocumentDrops()

const act = (command: FloatingVideoCommand): void => api().floatingVideoAction(command)

/** The bar once the snapshot has set the language of the interface: before it, every text would be read in French. */
function FloatingVideoPage() {
  const snapshot = useSnapshot()
  if (!snapshot) return null
  return <FloatingVideoBar act={act} />
}

mountRoot(<FloatingVideoPage />)
