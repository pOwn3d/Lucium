// Run as a file by the probe: marks the document it runs in with its origin, and answers the text of that document.
document.documentElement.setAttribute('data-lent-ran', location.origin)
document.body ? document.body.innerText : null
