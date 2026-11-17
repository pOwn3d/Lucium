// Marks the page it runs in with an attribute, which the page's document shares with every world: the engine test reads it to see whether
// this content script was injected.
document.documentElement.setAttribute('data-keyext-probe', 'injected')
