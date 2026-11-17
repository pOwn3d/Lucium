import { describe, expect, it } from 'vitest'
import { refuseCheck, refuseLocalFiles, refuseRequest, releaseSessionHooks, type HookedSession } from './session-hooks'

function hookedSession() {
  const calls: string[] = []
  const kept: { filter?: typeof refuseLocalFiles; request?: typeof refuseRequest; check?: typeof refuseCheck } = {}
  const ses: HookedSession = {
    webRequest: {
      onBeforeRequest: (listener) => void (kept.filter = listener),
      onBeforeSendHeaders: (listener) => void calls.push(`onBeforeSendHeaders:${listener}`),
      onHeadersReceived: (listener) => void calls.push(`onHeadersReceived:${listener}`)
    },
    removeAllListeners: (event) => void calls.push(`removeAllListeners:${event}`),
    setPermissionRequestHandler: (handler) => void (kept.request = handler),
    setPermissionCheckHandler: (handler) => void (kept.check = handler),
    setDisplayMediaRequestHandler: (handler) => void calls.push(`setDisplayMediaRequestHandler:${handler}`)
  }
  return { ses, calls, kept }
}

describe('releaseSessionHooks', () => {
  it('lets go of every hook the engine installs on the session of a private window', () => {
    const { ses, calls } = hookedSession()
    releaseSessionHooks(ses)
    expect(calls.sort()).toEqual(['onBeforeSendHeaders:null', 'onHeadersReceived:null', 'removeAllListeners:will-download', 'setDisplayMediaRequestHandler:null'])
  })

  // Electron grants what a page asks for on a session that has no handler, and the pages of the window are still closing.
  it('leaves refusals, not Electron\'s defaults, where a page that is still closing could ask', () => {
    const { ses, kept } = hookedSession()
    releaseSessionHooks(ses)
    const answers: boolean[] = []
    kept.request!(null, 'media', (granted) => answers.push(granted))
    expect(answers).toEqual([false])
    expect(kept.check!()).toBe(false)
    const verdicts: Record<string, boolean> = {}
    for (const url of ['file:///etc/passwd', 'FILE:///etc/hosts', 'https://lucium.app/']) kept.filter!({ url }, ({ cancel }) => (verdicts[url] = cancel))
    expect(verdicts).toEqual({ 'file:///etc/passwd': true, 'FILE:///etc/hosts': true, 'https://lucium.app/': false })
  })
})
