import { describe, expect, it } from 'vitest'
import { ERROR_LINE_MAX, ERROR_LOG_MAX, ERROR_TEXT_MAX, ErrorLog, installErrorLog } from './error-log'

describe('the error log of the main process', () => {
  it('keeps the last lines, oldest first, each with its time, on one line and cut short', () => {
    const log = new ErrorLog(() => Date.UTC(2026, 9, 28, 15, 1, 12))
    log.add(['[blocking] update failed:', new Error('boom\n    at somewhere')])
    log.add(['x'.repeat(ERROR_LINE_MAX * 2)])
    const [first, second] = log.lines()
    expect(first).toMatch(/^2026-10-28T15:01:12\.000Z \[blocking\] update failed: Error: boom ⏎ at somewhere/)
    expect(first).not.toContain('\n')
    expect(second!.length).toBeLessThanOrEqual('2026-10-28T15:01:12.000Z '.length + ERROR_LINE_MAX + 1)
    expect(second!.endsWith('…')).toBe(true)
  })

  it('forgets the oldest line when the fifty-first comes', () => {
    const log = new ErrorLog()
    for (let i = 0; i < ERROR_LOG_MAX + 5; i++) log.add([`line ${i}`])
    expect(log.lines()).toHaveLength(ERROR_LOG_MAX)
    expect(log.lines()[0]).toContain('line 5')
    expect(log.lines().at(-1)).toContain(`line ${ERROR_LOG_MAX + 4}`)
  })

  it('says so, and keeps going, when an argument cannot be written', () => {
    const log = new ErrorLog()
    // `%s` calls the toString of the argument, and this one throws.
    const hostile = { toString: () => { throw new Error('revoked') } }
    log.add(['%s', hostile])
    expect(log.lines()[0]).toContain('could not be written')
  })

  it('feeds the log from console.error without taking the console away, and puts it back', () => {
    const written: unknown[][] = []
    const target = { error: (...args: unknown[]) => void written.push(args) }
    const log = new ErrorLog()
    const restore = installErrorLog(log, target)
    target.error('[history] cannot write', 42)
    expect(written).toEqual([['[history] cannot write', 42]])
    expect(log.lines()[0]).toContain('[history] cannot write 42')
    restore()
    target.error('after')
    expect(log.lines()).toHaveLength(1)
    expect(written).toHaveLength(2)
  })

  it('keeps no path of a home and no address of a page: a file name and a host, whatever the way the line was written', () => {
    const log = new ErrorLog()
    const error = Object.assign(new Error("ENOENT: no such file or directory, open '/Users/jane/Library/Application Support/Lucium/state.json'"), { path: '/Users/jane/Library/Application Support/Lucium/state.json' })
    log.add(['[state] cannot read:', error])
    log.add([`[site] the data of %s was not erased: %s`, 'shop.example', 'https://shop.example/compte?token=abc123&user=jane'])
    log.add(['[downloads] cannot move download d1 from', '/Users/jane/Downloads/.tmp/film.part', 'to ~/Movies/film.mkv'])
    const text = log.lines().join('\n')
    expect(text).not.toMatch(/jane|\/Users\/|Application Support|token=|abc123|compte|~\//)
    expect(text).toContain("open 'state.json'")
    expect(text).toContain('the data of shop.example was not erased: shop.example')
    expect(text).toContain('from film.part to film.mkv')
  })

  it('redacts before it cuts the line, so that a path cut in the middle does not leave the start of the account name', () => {
    const log = new ErrorLog()
    // The path starts before the cut: kept whole, the 300 characters would end in « /Users/janedoe/Dev »; redacted first, the line fits and ends with the file name.
    log.add(['x'.repeat(ERROR_LINE_MAX - 20), '/Users/janedoe/Dev/lucium/out/main/index.js:1:2'])
    const line = log.lines()[0]!
    expect(line).not.toContain('/Users')
    expect(line).not.toContain('jane')
    expect(line.endsWith(' index.js:1:2')).toBe(true)
  })

  it('writes the console in full: only the log is redacted', () => {
    const written: unknown[][] = []
    const target = { error: (...args: unknown[]) => void written.push(args) }
    const log = new ErrorLog()
    installErrorLog(log, target)
    target.error('[x] cannot read /Users/jane/a.json from https://example.com/p?q=1')
    expect(written).toEqual([['[x] cannot read /Users/jane/a.json from https://example.com/p?q=1']])
    expect(log.lines()[0]).toMatch(/\[x\] cannot read a\.json from example\.com$/)
  })
})

describe('the cost of an entry of the error log', () => {
  it('reduces no more than the first characters of a text, however long the page made it', () => {
    const read: number[] = []
    const log = new ErrorLog(() => 0, (line) => (read.push(line.length), line))
    log.add([`[userscript] failed: ${'(~/a'.repeat(500_000)}`])
    log.add(['short'])
    expect(read).toEqual([ERROR_TEXT_MAX, 5])
    expect(log.lines()[0]!.endsWith('…')).toBe(true)
    expect(log.lines()[1]).toBe('1970-01-01T00:00:00.000Z short')
  })

  it('still reduces what the cut leaves half read, and says the text was cut even when what is left is short', () => {
    const log = new ErrorLog(() => 0)
    // The cut falls inside the name of the account, then inside a folder of the home: neither the name nor the folder above is kept.
    const lead = 'cannot read '
    log.add([`${lead}/Users/${'j'.repeat(ERROR_TEXT_MAX)}/Documents/a.txt`])
    log.add([`${lead}/Users/jane/${'d'.repeat(ERROR_TEXT_MAX - lead.length - 20)}/secret/a.txt`])
    expect(log.lines()[0]).toBe('1970-01-01T00:00:00.000Z cannot read ~…')
    expect(log.lines()[1]).not.toMatch(/jane|Users/)
    expect(log.lines()[1]!.endsWith('…')).toBe(true)
  })
})
