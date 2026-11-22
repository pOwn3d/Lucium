// Loaded into the main frame of the web pages while « Prévenir avant d’envoyer un mot de passe sans chiffrement » is on (registered by the engine, see
// electron-engine-preloads.ts; Electron loads a preload into the main frame only, so a form in a frame is not covered).
// It does one thing: when a form that holds a password someone typed is about to go to an `http:` address, it asks the main process (which puts a box
// of the browser over the tab) and stops the submission unless the answer is yes. The message is synchronous (`ipcRenderer.sendSync`), as the dialog
// bridge's: the page's own handlers run, and the submission itself waits for the answer. It sends the address and nothing of the form: no value, no name.
//
// What it cannot see: a page that sends its fields with `fetch` or `XMLHttpRequest` from its own script, and `form.submit()` (which fires no event).
// The DOM is read through the prototypes of the isolated world of this script: a page that names a field `action` or `elements` changes nothing here.

import { ipcRenderer } from 'electron'
import { FORM_GUARD } from '../shared/form-guard-wire'

// The page's own world: these are globals here, not imports (the node build has no DOM library).
declare const document: any
declare const HTMLFormElement: any
declare const HTMLInputElement: any

const getterOf = (prototype: any, name: string): ((this: any) => any) | undefined => Object.getOwnPropertyDescriptor(prototype, name)?.get

/** Where the form goes: the address of the button that sent it when it has one of its own (`formaction`), else the form's. Resolved by the DOM. */
function actionOf(form: any, submitter: any): string {
  const own = submitter ? getterOf(Object.getPrototypeOf(submitter), 'formAction') : undefined
  const read = own ? own.call(submitter) : getterOf(HTMLFormElement.prototype, 'action')?.call(form)
  return typeof read === 'string' ? read : ''
}

/** Whether a password field of the form holds something: an empty one sends nothing worth a question. */
function holdsPassword(form: any): boolean {
  const elements = getterOf(HTMLFormElement.prototype, 'elements')?.call(form)
  const type = getterOf(HTMLInputElement.prototype, 'type')
  const value = getterOf(HTMLInputElement.prototype, 'value')
  if (!elements || !type || !value) return false
  return Array.from(elements as ArrayLike<any>).some((field) => field instanceof HTMLInputElement && type.call(field) === 'password' && value.call(field) !== '')
}

function onSubmit(event: any): void {
  try {
    const form = event.target
    if (!(form instanceof HTMLFormElement)) return
    const action = actionOf(form, event.submitter)
    // Only an `http:` address is a question: the main process judges it again (a host of the local network is none).
    if (!/^http:/i.test(action) || !holdsPassword(form)) return
    if (ipcRenderer.sendSync(FORM_GUARD.ask, { action }) !== true) event.preventDefault()
  } catch (error) {
    // A form this cannot read is a form that gets no question; the page is not told, and nothing of its values is written to the console.
    console.warn('[lucium] a form with a password could not be checked:', error instanceof Error ? error.name : typeof error)
  }
}

document.addEventListener('submit', onSubmit, { capture: true })
