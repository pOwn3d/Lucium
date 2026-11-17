// Runs inside a page: the class names, ids and link targets its markup uses, so the generic hide rules that concern them
// (".ad-slot", "#sponsor", "a[href*=...]") can be looked up instead of shipping every one of them to every page.
// Bounded, since a page can hold tens of thousands of elements.

export const DOM_HINTS_SCRIPT = `(() => {
  const classes = new Set()
  const ids = new Set()
  const hrefs = new Set()
  let seen = 0
  for (const element of document.querySelectorAll('[class],[id],a[href]')) {
    if (++seen > 8000) break
    const id = element.getAttribute('id')
    if (id) ids.add(id)
    const names = element.getAttribute('class')
    if (names) for (const name of names.split(/\\s+/)) if (name) classes.add(name)
    const href = element.tagName === 'A' ? element.getAttribute('href') : null
    if (href && href.length < 500 && hrefs.size < 1500) hrefs.add(href)
  }
  return { classes: [...classes].slice(0, 5000), ids: [...ids].slice(0, 3000), hrefs: [...hrefs] }
})()`
