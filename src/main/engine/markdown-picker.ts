// The page side of the Markdown export. Two scripts run in an isolated world of the tab (the page cannot see them or reach into them, and
// its Content-Security-Policy does not apply to them), the way the reader mode runs Readability:
//  - the snapshot of what the user selected with the mouse;
//  - the blocks picker: a blue frame follows the pointer, a click keeps or leaves out the block under it, a bar at the foot of the page
//    copies or saves the result, Escape leaves. Same spirit as the Eraser mode of the Tweaks, but the page itself is left untouched.
// Both walk the live DOM, apply what the user chose and hand back a snapshot (shared/markdown-export.ts says what it may hold) as JSON
// text. The main process validates it again: the page is not trusted, and neither is a renderer that may have been compromised.

import type { WebContents } from 'electron'
import { MD_PAGE_CONFIG } from '@shared/markdown-export'
import { getLanguage, t, type MessageKey, type PluralBase } from '@shared/i18n'

/** An isolated world of its own. Any number outside the ones Chromium hands to extensions would do (see SLEEP_WORLD and READER_WORLD). */
export const MARKDOWN_WORLD = 4_200_019

// The code both scripts share: the walk over the DOM that builds the snapshot. `CONFIG` is what shared/markdown-export.ts hands over.
// Built at each use: the one sentence it writes (it ends in the notice and in the report of the archive) is handed over as data, in the
// language of the interface at that moment, since the translator of the main process does not exist in the page.
const library = (): string => String.raw`
const CONFIG = ${JSON.stringify(MD_PAGE_CONFIG)}
const NOT_CONVERTED = ${JSON.stringify(t('markdown-picker.contenu-non-converti'))}
const DROP = new Set(CONFIG.dropped)
const UNSUPPORTED = new Set(CONFIG.unsupported)
const STRUCTURAL = new Set(CONFIG.structural)
const BLOCK_DEFAULT = new Set(CONFIG.blockDefault)
const KEEP_ROOT = new Set(['ul', 'ol', 'dl', 'table', 'thead', 'tbody', 'tfoot', 'tr'])

const resolved = (value) => {
  if (!value || value.length > CONFIG.limits.url) return null
  try {
    const url = new URL(value, document.baseURI).href
    return url.length <= CONFIG.limits.url ? url : null
  } catch (error) {
    return null
  }
}

const childrenOf = (node) => {
  if (node.localName === 'slot') {
    const assigned = node.assignedNodes()
    if (assigned.length > 0) return assigned
  }
  return node.shadowRoot ? node.shadowRoot.childNodes : node.childNodes
}

const closest = (node, name) => {
  for (let at = node.nodeType === 1 ? node : node.parentElement; at; at = at.parentElement) if (at.localName === name) return at
  return null
}

const languageOf = (pre) => {
  for (const holder of [pre, pre.querySelector('code')]) {
    if (!holder) continue
    for (const name of holder.classList) {
      const found = /^(?:language|lang|highlight-source)-([\w+#.-]{1,30})$/.exec(name)
      if (found) return found[1]
    }
  }
  return null
}

const shownInline = (display) => display === 'inline' || display === 'contents' || display === 'ruby' || display.indexOf('inline-') === 0

const attributesOf = (element, tag, style) => {
  const out = {}
  if (tag === 'a') {
    const href = resolved(element.getAttribute('href'))
    if (href) out.href = href
  } else if (tag === 'img') {
    // The address the image really shows, then the ones lazy-loading scripts keep until it scrolls into view.
    for (const candidate of [element.currentSrc, element.getAttribute('src'), element.getAttribute('data-src'), element.getAttribute('data-lazy-src'), element.getAttribute('data-original')]) {
      const url = resolved(candidate)
      if (url && /^https?:/.test(url)) {
        out.src = url
        break
      }
    }
    const alt = element.getAttribute('alt')
    if (alt) out.alt = alt.slice(0, CONFIG.limits.alt)
  } else if (tag === 'ol') {
    const start = element.getAttribute('start')
    if (start) out.start = start
  } else if (tag === 'td' || tag === 'th') {
    for (const name of ['colspan', 'rowspan']) {
      const value = element.getAttribute(name)
      if (value) out[name] = value
    }
  } else if (tag === 'pre') {
    const lang = languageOf(element)
    if (lang) out.lang = lang
  }
  // Only said when the page shows the element otherwise than its tag suggests (a div shown inline, a link stacked as a block).
  if (!STRUCTURAL.has(tag)) {
    const block = !shownInline(style.display)
    if (block !== BLOCK_DEFAULT.has(tag)) out.d = block ? 'b' : 'i'
  }
  return Object.keys(out).length > 0 ? out : null
}

// Builds the snapshot of the given roots ({ node, included }: where the walk starts, and whether what it meets there is kept).
// A scope says what is kept: text(node, included) gives the text of a text node, element(el, included) whether an element is kept,
// skip(el) whether a whole branch is out of the picture.
const snapshotOf = (scope, roots) => {
  const budget = { nodes: CONFIG.limits.nodes, chars: CONFIG.limits.textChars, truncated: false }
  const warnings = []
  const warn = (message) => {
    if (warnings.length < CONFIG.limits.warnings && !warnings.includes(message)) warnings.push(message)
  }
  const visit = (node, included, depth, out) => {
    if (budget.nodes <= 0 || budget.chars <= 0) {
      budget.truncated = true
      return
    }
    if (node.nodeType === 3) {
      const text = scope.text(node, included)
      if (text) {
        budget.nodes--
        budget.chars -= text.length
        out.push(text)
      }
      return
    }
    if (node.nodeType !== 1) return
    const tag = node.localName
    if (DROP.has(tag)) {
      if (included && UNSUPPORTED.has(tag)) warn(NOT_CONVERTED.replace('{tag}', () => tag))
      return
    }
    if (scope.skip(node)) return
    const style = getComputedStyle(node)
    if (node.hidden || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return
    if (depth >= CONFIG.limits.depth) {
      budget.truncated = true
      return
    }
    budget.nodes--
    const inside = scope.element(node, included)
    const children = []
    const kids = childrenOf(node)
    for (let i = 0; i < kids.length; i++) visit(kids[i], inside, depth + 1, children)
    if (!inside) {
      // Left out, but what was chosen inside it again takes its place in the parent.
      for (let i = 0; i < children.length; i++) out.push(children[i])
      return
    }
    const element = { t: tag }
    const attributes = attributesOf(node, tag, style)
    if (attributes) element.a = attributes
    if (children.length > 0) element.c = children
    out.push(element)
  }
  const nodes = []
  for (const root of roots) visit(root.node, root.included, 0, nodes)
  return { nodes, warnings, truncated: budget.truncated }
}

// The text the user selected, with the structure it is in.
const selectionSnapshot = () => {
  const selection = getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed || !String(selection).trim()) return null
  const result = { nodes: [], warnings: [], truncated: false }
  for (let i = 0; i < selection.rangeCount; i++) {
    const range = selection.getRangeAt(i)
    const scope = {
      skip: (element) => !range.intersectsNode(element),
      element: () => true,
      text: (node) => {
        if (!range.intersectsNode(node)) return ''
        const from = node === range.startContainer ? range.startOffset : 0
        const to = node === range.endContainer ? range.endOffset : node.data.length
        return node.data.slice(from, to)
      }
    }
    const root = range.commonAncestorContainer
    // Inside a block of code, the selection stays code. Elsewhere the common ancestor is only the place the selection happens to be in
    // (a li or a p would turn a few selected words into a bullet or a paragraph), except for the lists and tables that give lines meaning.
    const wrapper = closest(root, 'pre') || closest(root, 'code')
    const whole = !wrapper && root.nodeType === 1 && KEEP_ROOT.has(root.localName)
    const roots = (root.nodeType === 3 || whole ? [root] : Array.from(childrenOf(root))).map((node) => ({ node, included: true }))
    const part = snapshotOf(scope, roots)
    let nodes = part.nodes
    if (wrapper) {
      const element = { t: wrapper.localName, c: nodes }
      const lang = wrapper.localName === 'pre' ? languageOf(wrapper) : null
      if (lang) element.a = { lang }
      nodes = [element]
    }
    for (const node of nodes) result.nodes.push(node)
    for (const warning of part.warnings) if (!result.warnings.includes(warning)) result.warnings.push(warning)
    if (part.truncated) result.truncated = true
  }
  return result
}
`

/** The text selected in the page, as a snapshot in JSON; null when nothing is selected. Built at each use, as the picker is. */
export const selectionScript = (): string => `(() => {
${library()}
  const snapshot = selectionSnapshot()
  return snapshot ? JSON.stringify(snapshot) : null
})()`

/**
 * The main content of the page, whole, with no picker: the snapshot of `<main>`, `[role=main]` or the first `<article>` (else the body),
 * without navigation, side columns, dialogs, and, when the page has no main part to hold them, headers and footers. Nothing a person typed
 * goes in: the form fields are dropped by the converter's own list, and an editable region (a mail being written, a document in a web editor)
 * is left out here. Hidden things are skipped by the walk itself. Resolves with the same JSON text as the picker (`parsePick`), as a whole-page save.
 */
export const pageScript = (): string => `(() => {
${library()}
  try {
    const root = document.querySelector('main, [role="main"]') || document.querySelector('article') || document.body || document.documentElement
    const wholeBody = root === document.body || root === document.documentElement
    const AROUND = 'nav, aside, dialog, [role="navigation"], [role="banner"], [role="complementary"], [role="contentinfo"], [role="dialog"], [role="alertdialog"]'
    const snapshot = snapshotOf(
      {
        skip: (element) => element.isContentEditable === true || element.matches(AROUND) || (wholeBody && (element.localName === 'header' || element.localName === 'footer') && !closest(element.parentElement || element, 'article')),
        element: () => true,
        text: (node) => node.data
      },
      [{ node: root, included: true }]
    )
    return JSON.stringify({ action: 'save', scope: 'blocks', snapshot })
  } catch (error) {
    return JSON.stringify({ error: String(error && error.message ? error.message : error) })
  }
})()`

const PICKER_CSS = [
  '*{box-sizing:border-box}',
  '.boxes{position:fixed;inset:0;pointer-events:none}',
  '.box{position:fixed;border-radius:3px;pointer-events:none}',
  '.box.hover{border:2px solid #2f39ff;background:rgba(47,57,255,.14)}',
  '.box.in{border:2px solid #2f39ff;background:rgba(47,57,255,.07)}',
  '.box.out{border:2px dashed #e5484d;background:rgba(229,72,77,.12)}',
  '.tag{position:absolute;left:0;top:0;max-width:100%;padding:2px 6px;border-radius:0 0 4px 0;font:500 11px/14px -apple-system,system-ui,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#fff;background:#2f39ff}',
  '.out .tag{background:#e5484d}',
  '.dock{position:fixed;left:0;right:0;bottom:12px;display:flex;justify-content:center;pointer-events:none}',
  '.bar{max-width:calc(100vw - 24px);display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:6px;padding:7px 7px 7px 14px;border-radius:12px;background:rgba(16,18,46,.9);color:#dedfff;font:400 13px/16px -apple-system,system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.28);pointer-events:auto;user-select:none}',
  '.state{margin-right:6px}',
  '.modes{display:flex;gap:2px;margin-right:6px}',
  'button{height:30px;padding:0 12px;border:0;border-radius:8px;background:rgba(237,238,255,.12);color:#edeeff;font:500 13px/1 -apple-system,system-ui,sans-serif;cursor:default}',
  'button:hover{background:rgba(237,238,255,.22)}',
  'button[aria-pressed=true]{background:rgba(237,238,255,.3)}',
  'button:disabled{opacity:.4}',
  'button.primary{background:#edeeff;color:#2f3033}',
  'button.primary:hover{background:#fff}',
  'button.primary:disabled:hover{background:#edeeff}',
  'button:focus-visible{outline:2px solid #8f95ff;outline-offset:1px}',
  '[hidden]{display:none!important}'
].join('')

/** Both forms of a counted text, `{count}` left in: the script picks one by the plural rules of the language. */
const forms = (base: PluralBase): { one: string; other: string } => ({ one: t(`${base}.one` as MessageKey), other: t(`${base}.other` as MessageKey) })

/**
 * The words of the picker, in the language of the interface when it opens. They are handed to the script as data: it runs in the page,
 * where the translator of the main process does not exist (a `t(…)` written in the script is a ReferenceError there).
 */
function pickerWords() {
  return {
    language: getLanguage(),
    toolbar: t('markdown-picker.export-markdown'),
    wholePage: t('markdown-picker.page-entiere'),
    emptySelection: t('markdown-picker.selection-vide'),
    copy: t('markdown-picker.copier'),
    save: t('pwd.enregistrer'),
    chooseBlocks: t('markdown-picker.choisir-des-blocs'),
    cancel: t('markdown-picker.annuler'),
    kept: t('markdown-picker.garde'),
    left: t('markdown-picker.exclu'),
    hoverExclude: t('markdown-picker.survol-exclure'),
    hoverInclude: t('markdown-picker.survol-inclure'),
    clickToExclude: t('markdown-picker.cliquez-sur-un-bloc-pour-l-exclure'),
    clickToKeep: t('markdown-picker.cliquez-sur-les-blocs-a-garder'),
    selectedChars: forms('markdown-picker.caracteres-selectionnes'),
    wholePageExcept: forms('markdown-picker.page-entiere-sauf-blocs'),
    blocksKept: forms('markdown-picker.blocs-gardes')
  }
}

/**
 * The picker. Resolves, once it ends, with JSON text `{ action, scope, snapshot }` (or `{ error }`), or null when the user left.
 * Starts on the text selection when there is one (copy or save it as it is, or switch to blocks), on the blocks otherwise.
 * `window.__luciumMarkdownStop()` ends it from outside. The interface is built with the DOM calls, not with markup: a page that
 * requires Trusted Types does not get in the way, and it is drawn in a closed shadow root, out of reach of the page's styles and scripts.
 * Built at each opening, so that its words follow the language of the interface.
 */
export const pickerScript = (): string => `(() => {
${library()}
  const WORDS = ${JSON.stringify(pickerWords())}
  const fill = (template, vars) => template.replace(/\\{(\\w+)\\}/g, (whole, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole))
  const pluralRules = new Intl.PluralRules(WORDS.language)
  const counted = (texts, count) => fill(pluralRules.select(count) === 'one' ? texts.one : texts.other, { count })
  return new Promise((resolve) => {
    if (window.__luciumMarkdownStop) window.__luciumMarkdownStop()
    const initial = selectionSnapshot()
    const selectedChars = initial ? String(getSelection()).trim().length : 0
    let mode = initial ? 'selection' : 'blocks'
    let keepByDefault = true
    // Element -> kept (true) or left out (false). What is not in it follows its closest ancestor that is, else keepByDefault.
    const rules = new Map()
    let chain = []
    let level = 0
    let hovered = null
    let finished = false
    let drawQueued = false
    const listeners = []
    const previousFocus = document.activeElement

    const make = (tag, className, text) => {
      const element = document.createElement(tag)
      if (className) element.className = className
      if (text) element.textContent = text
      return element
    }
    const button = (className, label) => {
      const element = make('button', className, label)
      element.type = 'button'
      return element
    }
    const host = document.createElement('div')
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none'
    const ui = host.attachShadow({ mode: 'closed' })
    const style = make('style')
    style.textContent = ${JSON.stringify(PICKER_CSS)}
    const boxes = make('div', 'boxes')
    const bar = make('div', 'bar')
    bar.setAttribute('role', 'toolbar')
    bar.setAttribute('aria-label', WORDS.toolbar)
    const state = make('span', 'state')
    const modes = make('span', 'modes')
    const allButton = button('all', WORDS.wholePage)
    const noneButton = button('none', WORDS.emptySelection)
    modes.append(allButton, noneButton)
    const copyButton = button('primary', WORDS.copy)
    const saveButton = button('', WORDS.save)
    const blocksButton = button('', WORDS.chooseBlocks)
    const cancelButton = button('', WORDS.cancel)
    bar.append(state, modes, copyButton, saveButton, blocksButton, cancelButton)
    // The bar sits in a row of the full width: placed with left: 50%, it would be as wide as half of the page at most.
    const dock = make('div', 'dock')
    dock.appendChild(bar)
    ui.append(style, boxes, dock)

    const effective = (element) => {
      for (let at = element; at; at = at.parentElement) if (rules.has(at)) return rules.get(at)
      return keepByDefault
    }
    const counts = () => {
      let kept = 0
      let left = 0
      for (const value of rules.values()) value ? kept++ : left++
      return { kept, left }
    }

    const box = (element, kind, label) => {
      const rect = element.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1 || rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) return
      const left = Math.max(rect.left, 0)
      const top = Math.max(rect.top, 0)
      const div = make('div', 'box ' + kind)
      div.style.cssText = 'left:' + left + 'px;top:' + top + 'px;width:' + (Math.min(rect.right, innerWidth) - left) + 'px;height:' + (Math.min(rect.bottom, innerHeight) - top) + 'px'
      if (label) div.appendChild(make('span', 'tag', label))
      boxes.appendChild(div)
    }

    const render = () => {
      boxes.replaceChildren()
      const { kept, left } = counts()
      if (mode === 'blocks') {
        for (const [element, value] of rules) if (element.isConnected) box(element, value ? 'in' : 'out', value ? WORDS.kept : WORDS.left)
        if (hovered && hovered.isConnected) box(hovered, 'hover', fill(effective(hovered) ? WORDS.hoverExclude : WORDS.hoverInclude, { tag: hovered.localName }))
      }
      if (mode === 'selection') state.textContent = counted(WORDS.selectedChars, selectedChars)
      else if (keepByDefault) state.textContent = left > 0 ? counted(WORDS.wholePageExcept, left) : WORDS.clickToExclude
      else state.textContent = kept > 0 ? counted(WORDS.blocksKept, kept) : WORDS.clickToKeep
      modes.hidden = mode !== 'blocks'
      blocksButton.hidden = mode !== 'selection'
      allButton.setAttribute('aria-pressed', String(keepByDefault))
      noneButton.setAttribute('aria-pressed', String(!keepByDefault))
      const empty = mode === 'blocks' && !keepByDefault && kept === 0
      copyButton.disabled = empty
      saveButton.disabled = empty
    }
    const redraw = () => {
      if (drawQueued || finished) return
      drawQueued = true
      requestAnimationFrame(() => {
        drawQueued = false
        if (!finished) render()
      })
    }

    const ours = (event) => event.composedPath().includes(host)
    const on = (target, name, handler, options) => {
      target.addEventListener(name, handler, options)
      listeners.push([target, name, handler, options])
    }

    // The block under the pointer: an inline element stands for the block it is in. The arrow keys go up and down the chain from there.
    const aim = (event) => {
      const target = event.composedPath().find((node) => node instanceof Element)
      if (!target || target === document.documentElement) return
      chain = []
      for (let at = target; at && at !== document.documentElement; at = at.parentElement) chain.push(at)
      level = 0
      while (level < chain.length - 1) {
        const display = getComputedStyle(chain[level]).display
        if (display !== 'inline' && display !== 'contents') break
        level++
      }
      hovered = chain[level]
    }
    const climb = (step) => {
      if (chain.length === 0) return
      level = Math.max(0, Math.min(chain.length - 1, level + step))
      hovered = chain[level]
      redraw()
    }

    const toggle = (element) => {
      const now = effective(element)
      const inherited = element.parentElement ? effective(element.parentElement) : keepByDefault
      if (!now === inherited) rules.delete(element)
      else rules.set(element, !now)
      // A rule that says what its surroundings now say anyway is noise: the state stays what a person would write down.
      let changed = true
      while (changed) {
        changed = false
        for (const [other, value] of rules) {
          const around = other.parentElement ? effective(other.parentElement) : keepByDefault
          if (value === around) {
            rules.delete(other)
            changed = true
          }
        }
      }
    }

    const swallowed = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'auxclick', 'contextmenu', 'dblclick', 'submit']
    // Only what a person did counts: a script of the page cannot drive the picker with events of its own.
    const swallow = (event) => {
      if (!event.isTrusted || ours(event)) return
      event.preventDefault()
      event.stopPropagation()
    }
    const onMove = (event) => {
      if (!event.isTrusted || ours(event)) return
      aim(event)
      redraw()
    }
    const onClick = (event) => {
      if (!event.isTrusted || ours(event)) return
      event.preventDefault()
      event.stopPropagation()
      // The block the arrow keys settled on, as long as the click is inside it; else the one under the pointer.
      const target = event.composedPath().find((node) => node instanceof Element)
      if (!hovered || !target || !hovered.contains(target)) aim(event)
      if (hovered) toggle(hovered)
      render()
    }
    const onKey = (event) => {
      if (!event.isTrusted) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        finish(null)
      } else if (mode === 'blocks' && hovered && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        event.preventDefault()
        event.stopPropagation()
        climb(event.key === 'ArrowUp' ? 1 : -1)
      }
    }
    const pageListeners = () => {
      on(window, 'pointermove', onMove, true)
      on(window, 'click', onClick, true)
      for (const name of swallowed) on(window, name, swallow, true)
      on(window, 'scroll', redraw, true)
      on(window, 'resize', redraw)
    }

    const blocksSnapshot = () =>
      snapshotOf(
        {
          skip: () => false,
          element: (element, included) => (rules.has(element) ? rules.get(element) : included),
          text: (node, included) => (included ? node.data : '')
        },
        [{ node: document.body || document.documentElement, included: keepByDefault }]
      )

    function finish(action) {
      if (finished) return
      finished = true
      delete window.__luciumMarkdownStop
      for (const [target, name, handler, options] of listeners) target.removeEventListener(name, handler, options)
      host.remove()
      // The keyboard goes back to where it was in the page.
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true })
      if (!action) return resolve(null)
      try {
        const snapshot = action.scope === 'selection' ? selectionSnapshot() || initial : blocksSnapshot()
        resolve(JSON.stringify({ action: action.name, scope: action.scope, snapshot }))
      } catch (error) {
        resolve(JSON.stringify({ error: String(error && error.message ? error.message : error) }))
      }
    }
    window.__luciumMarkdownStop = () => finish(null)

    // A press on the bar is not a click elsewhere: the selection of the page stays.
    bar.addEventListener('mousedown', (event) => event.preventDefault())
    copyButton.addEventListener('click', () => finish({ name: 'copy', scope: mode }))
    saveButton.addEventListener('click', () => finish({ name: 'save', scope: mode }))
    cancelButton.addEventListener('click', () => finish(null))
    blocksButton.addEventListener('click', () => {
      mode = 'blocks'
      pageListeners()
      render()
    })
    allButton.addEventListener('click', () => {
      keepByDefault = true
      rules.clear()
      render()
    })
    noneButton.addEventListener('click', () => {
      keepByDefault = false
      rules.clear()
      render()
    })
    on(window, 'keydown', onKey, true)
    if (mode === 'blocks') pageListeners()
    document.documentElement.appendChild(host)
    render()
    // The keyboard is the bar's from the start: Tab walks its buttons, Enter presses one, Escape leaves.
    const firstButton = mode === 'selection' ? copyButton : allButton
    firstButton.focus({ preventScroll: true })
  })
})()`

/** Ends a pick that is under way (its promise resolves with null). */
const STOP_SCRIPT = 'window.__luciumMarkdownStop && window.__luciumMarkdownStop()'

/** The page side of the export for one tab. */
export class MarkdownPicker {
  private picking = false

  constructor(private readonly wc: WebContents) {
    // The page is left: the document the picker was drawn in is gone, and its promise with it.
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) this.picking = false
    })
  }

  /** The selection of the page as a JSON snapshot; null when there is none (or the page does not answer). */
  async selection(): Promise<string | null> {
    return this.run(selectionScript())
  }

  /** The main content of the page, whole (see pageScript); null when the page does not answer. */
  async page(): Promise<string | null> {
    return this.run(pageScript())
  }

  /** Shows the picker and waits for the user (see pickerScript). A second call while one is under way ends the first and answers null. */
  async pick(): Promise<string | null> {
    if (this.picking) {
      this.stop()
      return null
    }
    this.picking = true
    try {
      return await this.run(pickerScript())
    } finally {
      this.picking = false
    }
  }

  stop(): void {
    if (this.wc.isDestroyed()) return
    this.wc.executeJavaScriptInIsolatedWorld(MARKDOWN_WORLD, [{ code: STOP_SCRIPT }]).catch((error: unknown) => console.warn('[markdown] cannot end the picker:', error instanceof Error ? error.message : String(error)))
  }

  private async run(code: string): Promise<string | null> {
    if (this.wc.isDestroyed()) return null
    try {
      const reply: unknown = await this.wc.executeJavaScriptInIsolatedWorld(MARKDOWN_WORLD, [{ code }])
      return typeof reply === 'string' ? reply : null
    } catch (error) {
      // The page was left or closed while the script ran: there is nothing to export.
      console.warn('[markdown] the page could not be read:', error instanceof Error ? error.message : String(error))
      return null
    }
  }
}
