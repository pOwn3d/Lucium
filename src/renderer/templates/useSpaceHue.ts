import { useSnapshot } from '../api'
import { activeSpaceHue } from './hue'

/** The hue of the space of the window the panel was opened from; `undefined` until the first snapshot has arrived. */
export function useSpaceHue(): number | undefined {
  const state = useSnapshot()?.state
  return state ? activeSpaceHue(state.spaces, state.activeSpaceId) : undefined
}
