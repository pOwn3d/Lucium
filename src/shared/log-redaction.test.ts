import { describe, expect, it } from 'vitest'
import { redactLogLine } from './log-redaction'

describe('the paths of a home', () => {
  it('keep only their file name, in a message or in the quotes of a Node error', () => {
    expect(redactLogLine('[history] cannot write /Users/jane/Library/Application Support/Lucium/history.json')).toBe('[history] cannot write history.json')
    expect(redactLogLine("ENOENT: no such file or directory, open '/Users/jane/Library/Application Support/Lucium/state.json'")).toBe("ENOENT: no such file or directory, open 'state.json'")
    expect(redactLogLine('{ errno: -2, syscall: "open", path: "/Users/jane/Downloads/rapport final.pdf" }')).toBe('{ errno: -2, syscall: "open", path: "rapport final.pdf" }')
    expect(redactLogLine('[downloads] cannot move download d1 from /Users/jane/.tmp/d1.part to /Users/jane/Downloads/film.mkv: EXDEV')).toBe('[downloads] cannot move download d1 from d1.part to film.mkv: EXDEV')
  })

  it('keep only their file name between quotes or brackets whatever the spaces in the folders: the closing mark ends the path', () => {
    expect(redactLogLine("open '/Users/jane/Documents/Mes notes de réunion importantes/Compte rendu.txt' failed")).toBe("open 'Compte rendu.txt' failed")
    expect(redactLogLine('at fn (/Users/jane/Mes projets perso de 2026/app/x.js:1:2)')).toBe('at fn (x.js:1:2)')
    expect(redactLogLine('see [~/Mes projets perso de 2026/a b.md] and <~/Mes projets perso de 2026/c d.md>')).toBe('see [a b.md] and <c d.md>')
  })

  it('stop at the end of a path when another one follows in the same sentence', () => {
    expect(redactLogLine('moved /Users/jane/a.txt to ~/b.txt, then /Users/jane/c.txt and done')).toBe('moved a.txt to b.txt, then c.txt and done')
  })

  it('keep only their file name when written with ~ ', () => {
    expect(redactLogLine('cannot read ~/Library/Preferences/lucium.plist')).toBe('cannot read lucium.plist')
    expect(redactLogLine("cannot read '~/Documents/Mes notes/a.txt'")).toBe("cannot read 'a.txt'")
  })

  it('keep only their file name in a stack frame, with the line and column', () => {
    expect(redactLogLine('Error: boom ⏎ at Object.run (/Users/jane/Dev/lucium/out/main/index.js:120:15) ⏎ at async /Users/jane/Dev/lucium/out/main/boot.js:8:3')).toBe('Error: boom ⏎ at Object.run (index.js:120:15) ⏎ at async boot.js:8:3')
    expect(redactLogLine('at fn (/Users/jane/Library/Application Support/Lucium/x.js:1:2)')).toBe('at fn (x.js:1:2)')
  })

  it('never keep the name of the account: a home alone comes out as ~, and so does a folder with spaces in it', () => {
    expect(redactLogLine('home is /Users/jane')).toBe('home is ~')
    expect(redactLogLine("cannot list '/Users/jane/'")).toBe("cannot list '~'")
    expect(redactLogLine('cannot list /Users/jane/Documents/Clients ACME/Contrat.pdf')).toBe('cannot list Contrat.pdf')
    expect(redactLogLine('/System/Volumes/Data/Users/jane/Desktop/a.txt')).toBe('a.txt')
    expect(redactLogLine('three paths /Users/jane/a.txt, /Users/jane.doe/b.txt and ~/c.txt')).not.toMatch(/jane/)
  })

  it('are left alone when they are not under a home', () => {
    const line = 'cannot read /Applications/Lucium.app/Contents/Resources/app.asar/out/main/index.js:12:3 and /private/var/folders/ab/T/x.tmp'
    expect(redactLogLine(line)).toBe(line)
    expect(redactLogLine('a path like src/Users/shared.ts and a ~tilde and 10~20')).toBe('a path like src/Users/shared.ts and a ~tilde and 10~20')
  })
})

describe('the addresses', () => {
  it('keep only their host: no path, no query, no fragment', () => {
    expect(redactLogLine('[site] cannot load https://www.example.com/compte/factures?token=abc123&user=jane#haut')).toBe('[site] cannot load www.example.com')
    expect(redactLogLine("url: 'https://example.com/a?q=secret', status: 404")).toBe("url: 'example.com', status: 404")
    expect(redactLogLine('failed: wss://chat.example.org:8443/socket?key=k1, then http://localhost:5173/src/main.tsx?t=1')).toBe('failed: chat.example.org:8443, then localhost:5173')
    expect(redactLogLine('page at chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html?tab=3 threw')).toBe('page at abcdefghijklmnopabcdefghijklmnop threw')
  })

  it('drop the user and the password of an address, and keep the whole of a query that holds brackets or commas', () => {
    expect(redactLogLine('cannot load https://jane:pw1234@intranet.example/admin?ids[]=1,2,3&f={a:1}')).toBe('cannot load intranet.example')
    expect(redactLogLine('see https://en.wikipedia.org/wiki/Foo_(bar)?x=(y) for details')).toBe('see en.wikipedia.org for details')
    expect(redactLogLine('http://[::1]:3000/path?q=1')).toBe('[::1]:3000')
  })

  it('leave the full stop that ends a sentence where it was', () => {
    expect(redactLogLine('The page https://example.com/a/b?c=d. Then another.')).toBe('The page example.com. Then another.')
    expect(redactLogLine('blob:https://example.com/0f8f-uuid failed')).toBe('blob:example.com failed')
  })

  it('reduce a file address to its file name, on the home or elsewhere, query and fragment dropped', () => {
    expect(redactLogLine('at async file:///Users/jane/Dev/lucium/out/renderer/index.html?x=1#top')).toBe('at async index.html')
    expect(redactLogLine('at fn (file:///Users/jane/Library/Application%20Support/Lucium/a.js:3:4)')).toBe('at fn (a.js:3:4)')
    expect(redactLogLine('load file:///Applications/Lucium.app/Contents/Resources/page.html failed')).toBe('load page.html failed')
    expect(redactLogLine("opened 'file:///Users/jane/'")).toBe("opened '~'")
    expect(redactLogLine('opened file:///')).toBe('opened file://')
  })
})

describe('everything else', () => {
  it('is left as it was: other schemes, hosts without a scheme, prose, numbers', () => {
    for (const line of [
      '2026-11-05T10:00:00.000Z [blocking] update failed: Error: net::ERR_NAME_NOT_RESOLVED',
      'data:image/png;base64,iVBORw0KGgo= was refused, mailto:example.com too',
      'the host example.com is slow (4.5 s) and 3/4 of the lists are missing',
      '[ui] Uncaught TypeError: Cannot read properties of undefined (reading "map")',
      'about:blank, lucium:settings and C:\\temp\\x are not addresses with an authority',
      ''
    ]) {
      expect(redactLogLine(line), line).toBe(line)
    }
  })

  it('is idempotent: a line that was redacted comes out unchanged', () => {
    const line = "open '/Users/jane/Library/Application Support/Lucium/state.json' from https://a.example/x?y=1 at (/Users/jane/Dev/x.js:1:2) file:///Users/jane/p.html ~/q.txt"
    const once = redactLogLine(line)
    expect(once).toBe("open 'state.json' from a.example at (x.js:1:2) p.html q.txt")
    expect(redactLogLine(once)).toBe(once)
  })
})

describe('an address whose path holds an apostrophe or a parenthesis', () => {
  it('loses its whole path and query: neither mark ends an address', () => {
    expect(redactLogLine("cannot load https://shop.example/it's/reset?token=abc123 now")).toBe('cannot load shop.example now')
    expect(redactLogLine("cannot load https://shop.example's/reset?token=abc123 now")).toBe('cannot load shop.example now')
    expect(redactLogLine('cannot load https://shop.example/a)b/reset?token=abc123 now')).toBe('cannot load shop.example now')
    expect(redactLogLine('cannot load https://shop.example/a(b/reset?token=abc123 now')).toBe('cannot load shop.example now')
  })

  it('still gives back the marks that close the sentence it was written in', () => {
    expect(redactLogLine("url: 'https://example.com/a?q=secret', status: 404")).toBe("url: 'example.com', status: 404")
    expect(redactLogLine('(see https://example.com/a/b?c=d).')).toBe('(see example.com).')
    expect(redactLogLine('at fn (https://example.com/app.js:1:2)')).toBe('at fn (example.com)')
    expect(redactLogLine('see https://en.wikipedia.org/wiki/Foo_(bar) and [https://example.com/x]')).toBe('see en.wikipedia.org and [example.com]')
    expect(redactLogLine('{"url":"https://example.com/a?b=c","status":404}')).toBe('{"url":"example.com","status":404}')
  })
})

describe('what names a person outside a home', () => {
  it('reduces a path on an external disk to its file name: the name of the disk is not kept', () => {
    expect(redactLogLine('cannot read /Volumes/Disque de Jane/Photos 2026/a.jpg')).toBe('cannot read a.jpg')
    expect(redactLogLine("open '/Volumes/JANE-USB/notes privées/b.txt' failed")).toBe("open 'b.txt' failed")
    expect(redactLogLine('mounted /Volumes/JANE-USB')).toBe('mounted ~')
    // The firmlink of the home is not a disk.
    expect(redactLogLine('/System/Volumes/Data/Users/jane/Desktop/a.txt')).toBe('a.txt')
  })

  it('reduces a mailto: address to its host, with or without a subject, and leaves a reduced one alone', () => {
    expect(redactLogLine('cannot open mailto:jane.doe@example.com?subject=Bonjour&body=secret, sorry')).toBe('cannot open mailto:example.com, sorry')
    expect(redactLogLine("link 'mailto:jane@example.com,bob@other.example' ignored")).toBe("link 'mailto:example.com' ignored")
    expect(redactLogLine('mailto:example.com and mailto: are not mailboxes')).toBe('mailto:example.com and mailto: are not mailboxes')
  })
})

describe('the cost of reducing a line', () => {
  it('ends the search for a closing mark at the next opening one: a parenthesis that is never closed is not read to the end of the line', () => {
    // Read to the end of the line, the first parenthesis would take « ~/a (~/b.txt » for one path and keep « b.txt » alone.
    expect(redactLogLine('(~/a (~/b.txt)')).toBe('(a (b.txt)')
    expect(redactLogLine('[/Users/jane/x </Users/jane/y.txt>')).toBe('[x <y.txt>')
  })

  it('stays proportional to the length of the line, for the texts that made it quadratic', () => {
    // 400 000 characters: a few milliseconds when each opening mark is read once, more than half a minute (far past the time a test is given) when
    // each one reads the line to its end.
    for (const unit of ['(~/a', '[/Users/jane/a', '<~/a b', "'~/a(", 'mailto:', 'https://e.example/(', ' ~/a b']) {
      const line = `https://e.example/ ${unit.repeat(Math.ceil(400_000 / unit.length))}`
      expect(typeof redactLogLine(line), unit).toBe('string')
    }
  })
})
