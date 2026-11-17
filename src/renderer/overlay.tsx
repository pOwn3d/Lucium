import { OverlayHost } from './OverlayHost'
import { mountRoot } from './root'
import './styles.css'
import './private'
import { lockDocumentDrops } from './surface'
import { api } from './api'
import { cycleKeyRelay } from './cycle-key-relay'

lockDocumentDrops()

// The panel of ⌃Tab has the keyboard while it is up, and the shell needs to hear ⌃ go up. The keys are listened to from the moment the panel is
// asked for, before it has been drawn (a key that comes before the request is kept for it), so that a quick tap is not lost, and only for that
// panel: no other panel's keys are ever reported (cycle-key-relay.ts).
const relay = cycleKeyRelay((key) => api().cycleKey(key))
api().onShowOverlay((request) => relay.show(request))
window.addEventListener('keydown', relay.key, true)
window.addEventListener('keyup', relay.key, true)

mountRoot(<OverlayHost />)
