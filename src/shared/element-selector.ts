// The CSS selector written for an element a person points at in a page (the eraser of a Tweak, the picker of an element). It runs in the page,
// so it is a text put into the script that is injected, and the one text both scripts carry: two copies could come to write two forms of
// selector for the same element.

/**
 * The source of `const selectorFor = (element) => string`, for a script injected into a page. The selector goes up from the element, four levels
 * at most, and stops at the first one that has a plain `id`; each level is its tag, its first two plain classes and, among siblings of the same
 * tag, its place. A name that would need escaping (an `id` or a class with a colon, a dot, a leading digit) is left out, never escaped.
 */
export const SELECTOR_FOR = `const selectorFor = (start) => {
    const parts = []
    for (let el = start; el && el.nodeType === 1 && el !== document.documentElement && parts.length < 4; el = el.parentElement) {
      if (el.id && /^[A-Za-z][\\w-]*$/.test(el.id)) { parts.unshift('#' + el.id); break }
      let part = el.tagName.toLowerCase()
      const classes = [...el.classList].filter((c) => /^[A-Za-z_][\\w-]*$/.test(c)).slice(0, 2)
      if (classes.length) part += '.' + classes.join('.')
      const same = [...el.parentNode.children].filter((s) => s.tagName === el.tagName)
      if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(el) + 1) + ')'
      parts.unshift(part)
    }
    return parts.join(' > ')
  }`
