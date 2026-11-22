import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FORM_GUARD } from '../shared/form-guard-wire'

// The preload runs in Electron's isolated world; here the DOM is a few plain classes with the getters the preload reads on their prototypes.
const ipcRenderer = { sendSync: vi.fn() }
vi.mock('electron', () => ({ ipcRenderer }))

class FakeInput {
  constructor(
    readonly kind: string,
    readonly text: string
  ) {}
  formAction = ''
  get type(): string {
    return this.kind
  }
  get value(): string {
    return this.text
  }
}
class FakeForm {
  constructor(
    readonly target: string,
    readonly fields: FakeInput[]
  ) {}
  get action(): string {
    return this.target
  }
  get elements(): FakeInput[] {
    return this.fields
  }
}
class FakeButton {
  constructor(readonly formTarget: string) {}
  get formAction(): string {
    return this.formTarget
  }
}

const globals = globalThis as unknown as Record<string, unknown>
let listener: ((event: unknown) => void) | undefined

beforeEach(async () => {
  ipcRenderer.sendSync.mockReset()
  vi.resetModules()
  globals['HTMLFormElement'] = FakeForm
  globals['HTMLInputElement'] = FakeInput
  globals['document'] = { addEventListener: (name: string, given: (event: unknown) => void, options: { capture?: boolean }) => name === 'submit' && options.capture === true && (listener = given) }
  listener = undefined
  await import('./form-guard')
})

afterEach(() => {
  for (const name of ['HTMLFormElement', 'HTMLInputElement', 'document']) delete globals[name]
  vi.restoreAllMocks()
})

const submit = (form: unknown, submitter?: unknown) => {
  const event = { target: form, submitter, preventDefault: vi.fn() }
  listener!(event)
  return event
}
const login = (target: string, password = 'hunter2') => new FakeForm(target, [new FakeInput('text', 'me'), new FakeInput('password', password)])

describe('the form guard of the page', () => {
  it('listens in the capture phase of the document, once', () => {
    expect(listener).toBeTypeOf('function')
  })

  it('asks, with the address alone, before a password goes to an http address, and lets the form go on a yes', () => {
    ipcRenderer.sendSync.mockReturnValue(true)
    const event = submit(login('http://shop.example.com/in'))
    expect(ipcRenderer.sendSync).toHaveBeenCalledWith(FORM_GUARD.ask, { action: 'http://shop.example.com/in' })
    expect(JSON.stringify(ipcRenderer.sendSync.mock.calls)).not.toContain('hunter2')
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('stops the form on a no, and on any answer that is not a yes', () => {
    for (const answer of [false, undefined, null, 'true', 1]) {
      ipcRenderer.sendSync.mockReturnValue(answer)
      expect(submit(login('http://shop.example.com/in')).preventDefault, String(answer)).toHaveBeenCalledTimes(1)
    }
  })

  it('does not ask for https, for a form with no password, or for a password field that is empty', () => {
    submit(login('https://shop.example.com/in'))
    submit(new FakeForm('http://shop.example.com/in', [new FakeInput('text', 'me')]))
    submit(login('http://shop.example.com/in', ''))
    expect(ipcRenderer.sendSync).not.toHaveBeenCalled()
  })

  it('reads the address of the button that sent the form when it has one of its own', () => {
    ipcRenderer.sendSync.mockReturnValue(true)
    submit(login('https://shop.example.com/in'), new FakeButton('http://other.example.net/in'))
    expect(ipcRenderer.sendSync).toHaveBeenCalledWith(FORM_GUARD.ask, { action: 'http://other.example.net/in' })
    ipcRenderer.sendSync.mockClear()
    submit(login('http://shop.example.com/in'), new FakeButton('https://safe.example.net/in'))
    expect(ipcRenderer.sendSync).not.toHaveBeenCalled()
  })

  it('leaves what is not a form alone (a submit event a script dispatches on another element)', () => {
    const imposter = Object.assign(new FakeInput('password', 'hunter2'), { target: 'http://shop.example.com/in', fields: [new FakeInput('password', 'hunter2')] })
    submit(imposter)
    expect(ipcRenderer.sendSync).not.toHaveBeenCalled()
  })

  it('says so on the console, without the values, and does not stop the form, when the form cannot be read', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    ipcRenderer.sendSync.mockImplementation(() => {
      throw new Error('hunter2 was here')
    })
    const event = submit(login('http://shop.example.com/in'))
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0])).not.toContain('hunter2')
    expect(event.preventDefault).not.toHaveBeenCalled()
  })
})
