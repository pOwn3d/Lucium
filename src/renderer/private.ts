// A private window loads the same UI as the main one; this marks it so private.css can set it apart. A guest window is private underneath
// (same rules) but must not look like one: it gets `guest` and none of the private marks.
import { isGuestSurface, isPrivateSurface } from '@shared/ipc'
import './private.css'

if (isGuestSurface(location.search)) document.documentElement.classList.add('guest')
else if (isPrivateSurface(location.search)) document.documentElement.classList.add('private')
