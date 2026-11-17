// Vim-style keyboard navigation in pages (the extensions Vimium and Tridactyl, and requests from the communities of
// other browsers): plain keys scroll the page, label the links to follow, go back and forward, change tab and open the search. It is off by
// default.
//
// The keys are read by a script in the isolated world of the main frame (page-tools.ts), only while the setting is on and the site is not
// in the list of those left out. What the script cannot do by itself (history, tabs, the search bar) it asks the application through
// the tools' console line. The key table and the link labels are pure functions that the script carries as its own source, so that
// the tests and the page run the same code.
//
// Keys (outside a text field, with no ⌘, ⌃ or ⌥ held):
//   j k / h l   scroll down, up / left, right        d u    half a page down, up        gg G    top, bottom
//   f           link hints: type the letters of a link to follow it     F    the same, in a new tab
//   H L         back, forward                         J K    previous, next tab
//   r           reload                                /      search in the page (the application's bar)
//   Échap       leaves the hints

import { VIM_APP_ACTIONS, VIM_URL_MAX, toolPreamble, type ToolScripts } from './page-tools'
import { isSiteExcluded } from './sleep'
import { t } from './i18n'

/** Whether the keys are on for a page: the setting, and the site not in the list of those that are left out. */
export const vimKeysOn = (enabled: boolean, excludedHosts: readonly string[], url: string): boolean => enabled && !isSiteExcluded(url, excludedHosts)

/** What a key of the normal mode does. The empty command is "nothing". */
export type VimCommand =
  | ''
  | 'scroll-down'
  | 'scroll-up'
  | 'scroll-left'
  | 'scroll-right'
  | 'half-down'
  | 'half-up'
  | 'top'
  | 'bottom'
  | 'hints'
  | 'hints-tab'
  | 'back'
  | 'forward'
  | 'reload'
  | 'tab-previous'
  | 'tab-next'
  | 'find'

/** The keys of the normal mode in the order the settings list them, and what each does, in the language of the interface. */
export function vimKeyLabels(): ReadonlyArray<readonly [string, string]> {
  return [
    ['j, k', t('vim-keys.defiler-vers-le-bas-vers-le-haut')],
    ['h, l', t('vim-keys.defiler-a-gauche-a-droite')],
    ['d, u', t('vim-keys.une-demi-page-vers-le-bas-vers-le-haut')],
    ['gg, G', t('vim-keys.haut-de-la-page-bas-de-la-page')],
    ['f', t('vim-keys.reperes-sur-les-liens-taper-leurs-lettres-pour')],
    ['F', t('vim-keys.idem-dans-un-nouvel-onglet')],
    ['H, L', t('vim-keys.page-precedente-page-suivante')],
    ['J, K', t('vim-keys.onglet-precedent-onglet-suivant')],
    ['r', t('menu.actualiser-la-page')],
    ['/', t('cmd.rechercher-dans-la-page')],
    [t('cmd.echap'), t('vim-keys.quitter-les-reperes')]
  ]
}

/** The keys and what they do as one run of text, for the footnote of the settings ("j, k : Défiler vers le bas, vers le haut ; h, l : …"). */
export const vimKeysSummary = (): string => vimKeyLabels().map(([keys, action]) => t('vim-keys.keys-action', { keys, action })).join(t('vim-keys.separateur'))

/** A first `g` waits this long (ms) for the second one: a stray `g` does not send the page to the top a minute later. */
export const VIM_PENDING_MS = 1500

/**
 * One key of the normal mode. `pending` is what an earlier key left half-typed (`g` waits for a second `g`); the result gives what is
 * still pending and the command to run. A key that means nothing here, and a `g` that is not followed by `g`, give no command and are
 * left to the page. Self-contained on purpose: the page script is built from this function's source.
 */
export function vimStep(pending: string, key: string): { pending: string; command: VimCommand } {
  if (pending === 'g') return { pending: '', command: key === 'g' ? 'top' : '' }
  switch (key) {
    case 'g':
      return { pending: 'g', command: '' }
    case 'G':
      return { pending: '', command: 'bottom' }
    case 'j':
      return { pending: '', command: 'scroll-down' }
    case 'k':
      return { pending: '', command: 'scroll-up' }
    case 'h':
      return { pending: '', command: 'scroll-left' }
    case 'l':
      return { pending: '', command: 'scroll-right' }
    case 'd':
      return { pending: '', command: 'half-down' }
    case 'u':
      return { pending: '', command: 'half-up' }
    case 'f':
      return { pending: '', command: 'hints' }
    case 'F':
      return { pending: '', command: 'hints-tab' }
    case 'H':
      return { pending: '', command: 'back' }
    case 'L':
      return { pending: '', command: 'forward' }
    case 'J':
      return { pending: '', command: 'tab-previous' }
    case 'K':
      return { pending: '', command: 'tab-next' }
    case 'r':
      return { pending: '', command: 'reload' }
    case '/':
      return { pending: '', command: 'find' }
    default:
      return { pending: '', command: '' }
  }
}

/** The letters the link labels are made of: the home row first, so that most labels are typed without moving the hand. */
export const VIM_HINT_ALPHABET = 'asdfghjkleiouwr'

/** The page is read for links up to this many candidates: a page of tens of thousands of elements does not freeze on `f`. */
export const VIM_SCAN_MAX = 5000

/** At most this many links are labelled: a page of thousands of links gets the first ones on screen, not a wall of letters. */
export const VIM_HINT_MAX = 400

/**
 * `count` labels no one of which begins another (so that typing a whole label never needs a key to say "that is all"), as short as the
 * alphabet allows: single letters while they are enough, then two, and three only when more than a few hundred links are labelled.
 * Self-contained on purpose: the page script is built from this function's source.
 */
export function hintLabels(count: number, alphabet: string): string[] {
  const letters = Array.from(alphabet)
  if (!(count > 0) || letters.length < 2) return []
  // The leaves of a tree with one branch per letter: the shallowest leaf is split into its children until there are enough leaves.
  const leaves: string[] = letters.slice()
  let head = 0
  while (leaves.length - head < count) {
    const split = leaves[head++] as string
    for (const letter of letters) leaves.push(split + letter)
  }
  return leaves.slice(head, head + count)
}

/** The labels that can still be reached after `typed` was typed, and the one it spells whole (-1 when it is not one). */
export function hintFilter(labels: readonly string[], typed: string): { open: number[]; hit: number } {
  const open: number[] = []
  let hit = -1
  for (let index = 0; index < labels.length; index++) {
    const label = labels[index] as string
    if (!label.startsWith(typed)) continue
    open.push(index)
    if (label === typed) hit = index
  }
  return { open, hit }
}

/** What the script labels: things a click does something to. */
const HINT_SELECTOR = [
  'a[href]',
  'area[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'summary',
  'label[for]',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[onclick]',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

function installScript(nonce: string): string {
  return `(function () {
  'use strict';
  ${toolPreamble(nonce)}
  if (tools.vimKeys) return;
  const step = ${vimStep.toString()};
  const labelsFor = ${hintLabels.toString()};
  const filter = ${hintFilter.toString()};
  const ALPHABET = ${JSON.stringify(VIM_HINT_ALPHABET)};
  const HINT_MAX = ${VIM_HINT_MAX};
  const SCAN_MAX = ${VIM_SCAN_MAX};
  const URL_MAX = ${VIM_URL_MAX};
  const PENDING_MS = ${VIM_PENDING_MS};
  const SELECTOR = ${JSON.stringify(HINT_SELECTOR)};
  const ACTIONS = ${JSON.stringify(VIM_APP_ACTIONS)};
  const SCROLL_STEP = 60;
  const SCROLLING = ['scroll-down', 'scroll-up', 'scroll-left', 'scroll-right', 'half-down', 'half-up'];
  const PASSIVE_INPUT = /^(button|checkbox|radio|submit|reset|image|file|range|color)$/i;
  const TEXT_ROLES = ['textbox', 'searchbox', 'combobox', 'spinbutton'];
  let pending = '';
  let pendingAt = 0;
  let hints = null;
  let scrolling = null;

  // ---- where the keys must be left alone ----
  const isEditable = (node) => {
    if (!(node instanceof Element)) return false;
    if (node.isContentEditable) return true;
    const tag = node.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') return !PASSIVE_INPUT.test(node.type || 'text');
    const role = node.getAttribute('role');
    return role !== null && TEXT_ROLES.includes(role);
  };
  const typing = (event) => {
    if (document.designMode === 'on') return true;
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    if (isEditable(path[0] || event.target)) return true;
    let active = document.activeElement;
    while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
    return isEditable(active);
  };

  // ---- scrolling ----
  const overflows = (element, axis) => axis === 'y' ? element.scrollHeight > element.clientHeight + 1 : element.scrollWidth > element.clientWidth + 1;
  const scrolls = (element, axis) => {
    if (!overflows(element, axis)) return false;
    const style = getComputedStyle(element);
    return /(auto|scroll|overlay)/.test(axis === 'y' ? style.overflowY : style.overflowX);
  };
  // The box that keys scroll: the one around the focus if it scrolls, else the page, else the largest box of the page that does (web apps scroll a pane, not the page).
  const scroller = (axis) => {
    for (let node = document.activeElement; node && node !== document.documentElement && node !== document.body; node = node.parentElement) if (scrolls(node, axis)) return node;
    const root = document.scrollingElement || document.documentElement;
    if (overflows(root, axis)) return root;
    if (scrolling && scrolling.axis === axis && scrolling.element.isConnected && scrolls(scrolling.element, axis) && performance.now() - scrolling.at < 1500) return scrolling.element;
    let best = null;
    let area = 0;
    let seen = 0;
    for (const element of document.querySelectorAll('*')) {
      if (++seen > 4000) break;
      if (!overflows(element, axis)) continue;
      const size = element.clientWidth * element.clientHeight;
      if (size > area && scrolls(element, axis)) { best = element; area = size; }
    }
    scrolling = best ? { element: best, axis, at: performance.now() } : null;
    return best;
  };
  const scrollBy = (dx, dy) => {
    const element = scroller(dy !== 0 ? 'y' : 'x');
    if (element) element.scrollBy({ left: dx, top: dy, behavior: 'instant' });
  };
  const scrollTo = (top) => {
    const element = scroller('y');
    if (element) element.scrollTo({ top: top < 0 ? element.scrollHeight : top, behavior: 'instant' });
  };

  // ---- link hints ----
  const reach = (element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return null;
    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) return null;
    const style = getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0 || style.pointerEvents === 'none') return null;
    const x = (Math.max(rect.left, 0) + Math.min(rect.right, innerWidth)) / 2;
    const y = (Math.max(rect.top, 0) + Math.min(rect.bottom, innerHeight)) / 2;
    const top = document.elementFromPoint(x, y);
    // Something else lies over it (a banner, a menu that is closed but still laid out): not a link the user can follow.
    return top && element.contains(top) ? rect : null;
  };
  const paint = (open) => {
    const shown = new Set(open);
    hints.items.forEach((item, index) => {
      item.box.style.display = shown.has(index) ? 'block' : 'none';
      item.typed.textContent = hints.typed;
      item.rest.textContent = item.label.slice(hints.typed.length);
    });
  };
  const close = () => {
    if (!hints) return;
    const shown = hints;
    hints = null;
    shown.host.remove();
    removeEventListener('scroll', close, true);
    removeEventListener('resize', close, true);
    removeEventListener('mousedown', close, true);
    removeEventListener('blur', close);
  };
  const open = (newTab) => {
    close();
    const found = [];
    const controls = new Set();
    let scanned = 0;
    for (const element of document.querySelectorAll(SELECTOR)) {
      if (found.length >= HINT_MAX || ++scanned > SCAN_MAX) break;
      const rect = reach(element);
      if (rect) { found.push({ element, rect }); controls.add(element); }
    }
    // A label whose field is labelled too would be a second hint for one target.
    const items = found.filter(({ element }) => !(element.tagName === 'LABEL' && element.control && controls.has(element.control)));
    if (items.length === 0) return;
    const labels = labelsFor(items.length, ALPHABET);
    // A plain element: a tag of our own would tell the page which browser draws the hints.
    const host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';
    const shadow = host.attachShadow({ mode: 'closed' });
    const boxes = items.map(({ element, rect }, index) => {
      const box = document.createElement('div');
      box.style.cssText = 'all:initial;position:fixed;left:' + Math.max(0, Math.min(rect.left, innerWidth - 24)) + 'px;top:' + Math.max(0, Math.min(rect.top, innerHeight - 18)) + 'px;padding:1px 4px;border-radius:3px;font:700 11px/14px ui-monospace,Menlo,monospace;text-transform:uppercase;white-space:nowrap;color:#1c1c1e;background:#ffd84a;border:1px solid #b38f00;box-shadow:0 1px 3px rgba(0,0,0,0.35);pointer-events:none';
      const typed = document.createElement('span');
      typed.style.cssText = 'all:initial;font:inherit;text-transform:inherit;opacity:0.4';
      const rest = document.createElement('span');
      rest.style.cssText = 'all:initial;font:inherit;text-transform:inherit';
      rest.textContent = labels[index];
      box.append(typed, rest);
      shadow.append(box);
      return { element, label: labels[index], box, typed, rest };
    });
    hints = { host, items: boxes, labels, typed: '', newTab };
    document.documentElement.append(host);
    addEventListener('scroll', close, true);
    addEventListener('resize', close, true);
    addEventListener('mousedown', close, true);
    addEventListener('blur', close);
  };
  const follow = (element, newTab) => {
    const tag = element.tagName;
    if (newTab && (tag === 'A' || tag === 'AREA')) {
      const url = typeof element.href === 'string' ? element.href : '';
      // Only a web address that fits the line goes to the application; anything else (javascript:, mailto:, a very long address) is clicked as the page meant.
      if (/^https?:/i.test(url) && url.length <= URL_MAX) { report({ tool: 'vim', action: 'open-tab', url }); return; }
    }
    if (tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && !PASSIVE_INPUT.test(element.type || 'text')) || element.isContentEditable) { element.focus(); return; }
    element.click();
  };
  const hintKey = (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    const key = event.key;
    if (key === 'Escape') return close();
    if (key === 'Backspace') {
      if (hints.typed === '') return close();
      hints.typed = hints.typed.slice(0, -1);
      return paint(filter(hints.labels, hints.typed).open);
    }
    if (key.length !== 1) return;
    const letter = key.toLowerCase();
    if (!ALPHABET.includes(letter)) return;
    const next = hints.typed + letter;
    const found = filter(hints.labels, next);
    if (found.open.length === 0) return;
    hints.typed = next;
    if (found.hit < 0) return paint(found.open);
    const target = hints.items[found.hit].element;
    const newTab = hints.newTab;
    close();
    follow(target, newTab);
  };

  // ---- the commands ----
  const run = (command, repeated) => {
    if (repeated && !SCROLLING.includes(command)) return;
    switch (command) {
      case 'scroll-down': return scrollBy(0, SCROLL_STEP);
      case 'scroll-up': return scrollBy(0, -SCROLL_STEP);
      case 'scroll-left': return scrollBy(-SCROLL_STEP, 0);
      case 'scroll-right': return scrollBy(SCROLL_STEP, 0);
      case 'half-down': return scrollBy(0, Math.max(1, Math.floor(innerHeight / 2)));
      case 'half-up': return scrollBy(0, -Math.max(1, Math.floor(innerHeight / 2)));
      case 'top': return scrollTo(0);
      case 'bottom': return scrollTo(-1);
      case 'hints': return open(false);
      case 'hints-tab': return open(true);
      default: if (ACTIONS.includes(command)) report({ tool: 'vim', action: command });
    }
  };
  const onKey = (event) => {
    // Keys the user did not press, chords with ⌘ ⌃ ⌥ (the browser's own shortcuts) and composition are never ours.
    if (!event.isTrusted || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    if (hints) return hintKey(event);
    if (event.defaultPrevented || typing(event)) { pending = ''; return; }
    const now = performance.now();
    if (pending !== '' && now - pendingAt > PENDING_MS) pending = '';
    const result = step(pending, event.key);
    pending = result.pending;
    pendingAt = now;
    if (result.command === '' && result.pending === '') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (result.command !== '') run(result.command, event.repeat === true);
  };
  addEventListener('keydown', onKey, true);
  tools.vimKeys = {
    off() {
      close();
      removeEventListener('keydown', onKey, true);
    }
  };
})()`
}

export const VIM_KEY_SCRIPTS: ToolScripts = {
  install: installScript,
  uninstall: `(function () { const tools = self.__lucium_tools; if (!tools || !tools.vimKeys) return; try { tools.vimKeys.off() } finally { delete tools.vimKeys } })()`
}
