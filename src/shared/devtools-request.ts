// The developer tools (Chromium's DevTools window): what each command asks of them, which call of the DevTools frontend brings it about,
// where a right click points, and what the user is told when a request could not be carried out. Pure: the engine drives the window
// (main/engine/devtools-open.ts), this decides.
//
// The frontend of the installed Chromium (156) offers `DevToolsAPI.showPanel(id)` and `DevToolsAPI.enterInspectElementMode()`: the very
// calls Chromium's own browser process makes (`DevToolsWindow::ScheduleShow`). Measured in Electron 45.0.0, in the castLabs 45.0.0-alpha.14
// build and in the installed application: both exist as soon as the window reports `devtools-opened`, but only do something a little later
// (see `devToolsScript`).

import { COMMANDS, effectiveAccelerator, type KeyBindings } from './keybindings'
import { t } from './i18n'

/** What a command asks of the tools. `tools`: just show them, on the panel they were last on (⌥⌘I, F12). */
export type DevToolsRequest = 'tools' | 'elements' | 'console' | 'network' | 'inspect'

export type DevToolsPanel = 'elements' | 'console' | 'network'

/** What the frontend is told: nothing (raise the window), a panel to show, or to start picking an element of the page. */
export type DevToolsStep = { kind: 'raise' } | { kind: 'panel'; panel: DevToolsPanel } | { kind: 'inspect' }

export function devToolsStep(request: DevToolsRequest): DevToolsStep {
  switch (request) {
    case 'tools':
      return { kind: 'raise' }
    case 'inspect':
      return { kind: 'inspect' }
    default:
      return { kind: 'panel', panel: request }
  }
}

/**
 * The expression the DevTools window runs for a step. It answers `waiting` while the frontend does not offer its calls or has not built its
 * panels (nothing was called: a call made then is lost), `pending` once the call was made but the panel is not the selected one yet (or the
 * picking button not pressed), and `done` when it shows what was asked. The caller asks again until `done`: measured, `showPanel("console")`
 * right at `devtools-opened` leaves the Elements panel, which is why a fixed delay (400 ms) had been put there, and which a loaded machine
 * outlasts. `call: false` only looks (the picking mode is a toggle in the frontend: asked twice, it is left again). What is read back is the
 * tab `#tab-<panel>` and the button whose `jslog` context is `elements.toggle-element-search`; when the frontend no longer has them, there
 * is nothing to check and the call counts as done.
 */
export function devToolsScript(step: Exclude<DevToolsStep, { kind: 'raise' }>, options: { call: boolean } = { call: true }): string {
  const call = step.kind === 'inspect' ? 'api.enterInspectElementMode()' : `api.showPanel(${JSON.stringify(step.panel)})`
  const check =
    step.kind === 'inspect'
      ? `const toggle = deep(document, '[jslog*="elements.toggle-element-search"]')[0]; const button = toggle && toggle.shadowRoot ? toggle.shadowRoot.querySelector('button') : null; if (button && button.getAttribute('aria-pressed') === 'false') return 'pending'`
      : `const tab = deep(document, ${JSON.stringify(`#tab-${step.panel}`)})[0]; if (tab && tab.getAttribute('aria-selected') !== 'true') return 'pending'`
  return [
    '(() => {',
    // `DevToolsAPI` is what Chromium's browser process calls; `InspectorFrontendAPI` is the same set of calls, read when the first lacks one (seen so in another measure).
    `const method = (name) => [globalThis.DevToolsAPI, globalThis.InspectorFrontendAPI].find((api) => api && typeof api[name] === 'function'); const api = { showPanel: (panel) => method('showPanel').showPanel(panel), enterInspectElementMode: () => method('enterInspectElementMode').enterInspectElementMode() };`,
    "if (!method('showPanel') || !method('enterInspectElementMode')) return 'waiting';",
    'const deep = (root, selector, found = []) => { for (const el of root.querySelectorAll("*")) { if (el.shadowRoot) deep(el.shadowRoot, selector, found) } for (const el of root.querySelectorAll(selector)) found.push(el); return found };',
    // Until the tab bar exists the panels are not built and nobody listens to the call.
    "if (deep(document, '[role=tab]').length === 0) return 'waiting';",
    options.call ? `${call};` : '',
    `${check};`,
    "return 'done'",
    '})()'
  ].join(' ')
}

/** What the window answered to `devToolsScript`; anything but its words counts as not there yet. */
export function devToolsReply(value: unknown): 'done' | 'pending' | 'waiting' {
  return value === 'done' || value === 'pending' ? value : 'waiting'
}

/**
 * Where "Inspecter l'élément" points. The `x` and `y` of a page's context menu are the pointer's place in the page multiplied by the zoom
 * of the page (measured: at 150 % a click at 540, 420 reports 810, 630; at 75 %, 203, 158), while `inspectElement` takes the place as the
 * page shows it: handed over as they are, they land on another element (the `html` one, at 150 %).
 */
export function inspectPoint(params: { x: number; y: number }, zoomFactor: number): { x: number; y: number } {
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1
  return { x: Math.round(params.x / zoom), y: Math.round(params.y / zoom) }
}

/** The page the tools open on: a Glance on screen covers the window, so it is the one the user looks at; else the page of the tab. */
export function devToolsTarget(facts: { peekShown: boolean; hasTab: boolean }): 'peek' | 'tab' | 'none' {
  if (facts.peekShown) return 'peek'
  return facts.hasTab ? 'tab' : 'none'
}

/** The usual key for the tools, which a shortcut of the settings cannot spell for two commands at once. */
export const DEVTOOLS_EXTRA_ACCELERATOR = 'F12'

/** F12 opens the tools too, unless the user gave that key to a command (the tools included: it is then their shortcut). */
export function devToolsExtraAccelerator(bindings: KeyBindings | undefined): string | undefined {
  return COMMANDS.some((c) => effectiveAccelerator(c.id, bindings) === DEVTOOLS_EXTRA_ACCELERATOR) ? undefined : DEVTOOLS_EXTRA_ACCELERATOR
}

/** The key of a window with a page of its own (the mini window, an application window), whose keys the menu bar does not see. */
export interface DevToolsKey {
  /** The character of the key (with ⌥ held, macOS gives a composed character: `code` is read for the letters then). */
  key: string
  code?: string
  meta: boolean
  shift: boolean
  alt: boolean
  control: boolean
}

/** What the key asks of the tools, or null: ⌥⌘I, ⌥⌘J and ⌥⌘C (or the keys the user gave them) and F12. */
export function devToolsRequestForKey(input: DevToolsKey, bindings: KeyBindings | undefined): DevToolsRequest | null {
  const letter = input.alt && input.code && /^Key[A-Z]$/.test(input.code) ? input.code.slice(3) : input.key.length === 1 ? input.key.toUpperCase() : input.key
  const modifiers = input.control && input.meta ? 'Ctrl+CmdOrCtrl' : input.meta ? 'CmdOrCtrl' : input.control ? 'Ctrl' : ''
  const pressed = [modifiers, input.alt ? 'Alt' : '', input.shift ? 'Shift' : '', letter].filter(Boolean).join('+')
  const is = (command: string): boolean => {
    const accelerator = effectiveAccelerator(command, bindings)
    // The same keys in whatever order the accelerator spells them.
    return accelerator !== undefined && accelerator.split('+').sort().join('+') === pressed.split('+').sort().join('+')
  }
  if (is('devTools')) return 'tools'
  if (is('inspectElement')) return 'inspect'
  if (is('jsConsole')) return 'console'
  if (is('networkInspector')) return 'network'
  return pressed === DEVTOOLS_EXTRA_ACCELERATOR && devToolsExtraAccelerator(bindings) !== undefined ? 'tools' : null
}

/** Why a request could not be carried out. */
export type DevToolsFailure = 'not-opened' | 'closed' | 'frontend' | 'script'

export type DevToolsOutcome = { ok: true } | { ok: false; reason: DevToolsFailure; detail?: string }

/** The sentence the user reads when the tools did not do what was asked (the journal keeps the reason). */
export function devToolsFailureMessage(reason: DevToolsFailure, request: DevToolsRequest): string {
  // A window that never opened, or went away, has nothing to say about a panel.
  if (reason === 'not-opened' || reason === 'closed' || request === 'tools') return t('browser.les-outils-de-developpement-n-ont-pas-pu-s-ouvrir')
  return request === 'inspect' ? t('browser.les-outils-de-developpement-sont-ouverts-mais-la-selection-d-un-element-n-a-pas-demarre') : t('browser.les-outils-de-developpement-sont-ouverts-mais-le-panneau-demande-n-a-pas-pu-s-afficher')
}
