import { describe, expect, it } from 'vitest'
import { siteLabel, tidyFilename, tidyTitle } from './tidy'

describe('siteLabel', () => {
  it('names the site from its hostname', () => {
    expect(siteLabel('https://www.github.com/x')).toBe('github')
    expect(siteLabel('https://mail.github.com/')).toBe('github')
    expect(siteLabel('https://news.bbc.co.uk/')).toBe('bbc')
    expect(siteLabel('http://localhost:3000/')).toBe('localhost')
    expect(siteLabel('not a url')).toBe('')
  })
})

describe('tidyTitle', () => {
  it('keeps only the site name when the title carries it', () => {
    expect(tidyTitle('Pull requests · org/repo · GitHub', 'https://github.com/org/repo/pulls')).toBe('GitHub')
    expect(tidyTitle('Vidéo géniale - YouTube', 'https://www.youtube.com/watch?v=1')).toBe('YouTube')
  })

  it('drops unread counters', () => {
    expect(tidyTitle('(3) YouTube', 'https://www.youtube.com/')).toBe('YouTube')
    expect(tidyTitle('Inbox (12)', 'https://example.org/')).toBe('Inbox')
  })

  it('leaves a title alone when no part is the site name', () => {
    expect(tidyTitle('Boîte de réception - moi@exemple.fr - Courrier', 'https://mail.google.com/')).toBe('Boîte de réception - moi@exemple.fr - Courrier')
    expect(tidyTitle('Une page', 'https://example.org/')).toBe('Une page')
  })

  it('does not take a long title that merely mentions the site for the site name', () => {
    const long = 'Why we left GitHub for something else entirely, part two'
    expect(tidyTitle(`${long} | Blog`, 'https://github.com/')).toBe(`${long} | Blog`)
  })

  it('does not match a one-letter site name against everything', () => {
    expect(tidyTitle('Une page | Autre', 'https://t.co/x')).toBe('Une page | Autre')
  })

  it('returns an empty title as it was', () => {
    expect(tidyTitle('   ', 'https://github.com/')).toBe('   ')
  })
})

describe('tidyFilename', () => {
  it('turns machine-made names into readable ones and lowercases the extension', () => {
    expect(tidyFilename('Rapport_final%20v2.PDF')).toBe('Rapport final v2.pdf')
    expect(tidyFilename('IMG_0012 (1).JPG')).toBe('IMG 0012.jpg')
  })

  it('never produces a path or a hidden file', () => {
    expect(tidyFilename('..%2F..%2Fetc%2Fpasswd')).toBe('etc passwd')
    expect(tidyFilename('.bashrc')).toBe('bashrc')
    expect(tidyFilename('a/b\\c.txt')).toBe('a b c.txt')
  })

  it('does not bring back, by decoding, what Chromium took out of the name: NUL, line breaks and the characters that reorder text', () => {
    // Decoding "%00" gives a NUL, "%E2%80%AE" the right-to-left override that makes "fdp.exe" read as "exe.pdf".
    expect(tidyFilename('Invoice.command%00.pdf')).toBe('Invoice.command.pdf')
    expect(tidyFilename('Invoice%E2%80%AEfdp.exe')).toBe('Invoicefdp.exe')
    expect(tidyFilename('a%0Ab%0D%0Ac.txt')).toBe('abc.txt')
    expect(tidyFilename('x%E2%80%8Fy%E2%80%8Ez%E2%81%A6w%E2%81%A9.txt')).toBe('xyzw.txt')
    expect(tidyFilename('tab%09and%7Fdel%C2%85.txt')).toBe('tabanddel.txt')
    for (const name of ['Invoice.command%00.pdf', 'Invoice%E2%80%AEfdp.exe', 'a%0Ab.txt', '%E2%80%AE%00.bin']) {
      expect(tidyFilename(name)).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u)
    }
  })

  it('keeps a name it cannot improve and tolerates a stray percent sign', () => {
    expect(tidyFilename('100%.txt')).toBe('100%.txt')
    expect(tidyFilename('archive.tar.gz')).toBe('archive.tar.gz')
    expect(tidyFilename('___')).toBe('___')
  })
})

describe('a long run of blanks', () => {
  // The counter at the end was cut by a pattern that started with `\s*`: tried again from every blank of the run, a run of 40 000 took close to a second.
  const BLANKS = ' '.repeat(40_000)
  const SECONDS = 0.25
  const taken = (run: () => unknown): number => {
    const start = performance.now()
    run()
    return (performance.now() - start) / 1000
  }

  it('is cut fast from a title, at its end and in the middle', () => {
    expect(taken(() => tidyTitle(`Inbox${BLANKS}`, 'https://example.org/'))).toBeLessThan(SECONDS)
    expect(taken(() => tidyTitle(`Inbox${BLANKS}x`, 'https://example.org/'))).toBeLessThan(SECONDS)
    expect(taken(() => tidyTitle(`Inbox${BLANKS}(`, 'https://example.org/'))).toBeLessThan(SECONDS)
  })

  it('is cut fast from the name of a file, at its end and in the middle', () => {
    expect(taken(() => tidyFilename(`rapport${BLANKS}.pdf`))).toBeLessThan(SECONDS)
    expect(taken(() => tidyFilename(`rapport${BLANKS}x.pdf`))).toBeLessThan(SECONDS)
    expect(taken(() => tidyFilename(`rapport${BLANKS}(.pdf`))).toBeLessThan(SECONDS)
  })

  it('still takes a counter off the end of a name that ends in blanks, as it takes it off one that does not', () => {
    expect(tidyTitle('Inbox (12)  ', 'https://example.org/')).toBe('Inbox')
    expect(tidyTitle(`Inbox${BLANKS}(12)${BLANKS}`, 'https://example.org/')).toBe('Inbox')
    expect(tidyFilename('IMG_0012 (1) .JPG')).toBe('IMG 0012.jpg')
    expect(tidyFilename(`rapport${BLANKS}(2).pdf`)).toBe('rapport.pdf')
  })
})
