import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { baselineName, compareReports, compareVersions, latestBaseline, normalizeCheckName, readExplanations, readReport, type CompatReport } from './compat-report'

const engine = { name: 'electron', version: '45.2.1', chromium: '156.0.8078.120' }
const probe = { present: 92, missing: ['bookmarks', 'history'], calls: { 'tabs.query({})': 'ok', 'cookies.getAll': 'ok' } }

const report = (suites: CompatReport['suites'], more: Partial<CompatReport> = {}): CompatReport => ({ engine, suites, apiProbe: probe, declarativeNetRequestEnforced: true, extensionNetworkRules: null, ...more })
const pass = (name: string) => ({ name, ok: true })
const fail = (name: string) => ({ name, ok: false })
const skip = (name: string) => ({ name, ok: true, skipped: true as const })

const reference = report({
  main: { code: 0, checks: [pass('page loads'), pass('find in page counts the matches'), fail('known to fail')] },
  sec2: { code: 0, checks: [pass('sec2: a debugger is refused')] }
})

describe('reading a report', () => {
  it('reads the report of a run and leaves the details of the checks out', () => {
    const raw = {
      engine,
      suites: { main: { code: 1, checks: [{ name: 'page loads', ok: true, detail: 'http://127.0.0.1:54038/one' }, { name: 'voice', ok: true, skipped: true, detail: 'skipped: no voice' }, { name: 'rule', ok: false, detail: 'hits=1' }] } },
      apiProbe: [probe, { present: 1, missing: [], calls: {} }],
      declarativeNetRequestEnforced: false
    }
    expect(readReport(raw, 'run')).toEqual({ engine, suites: { main: { code: 1, checks: [pass('page loads'), skip('voice'), fail('rule')] } }, apiProbe: probe, declarativeNetRequestEnforced: false, extensionNetworkRules: null })
  })

  it('reads the first reference of the repository, written before the suites had their own entries: its checks are those of the principal suite', () => {
    const first = readReport(JSON.parse(readFileSync(fileURLToPath(new URL('../../compat/baseline-electron-45.0.0.json', import.meta.url)), 'utf8')), 'baseline')
    expect(first.engine).toEqual({ name: 'electron', version: '45.0.0', chromium: '156.0.8078.48' })
    expect(Object.keys(first.suites)).toEqual(['main'])
    expect(first.suites['main']?.checks).toHaveLength(60)
    expect(first.suites['main']?.checks[0]).toEqual({ name: 'engine reports a Chromium version', ok: true })
    expect(first.apiProbe?.present).toBe(92)
    expect(first.apiProbe?.missing).toContain('bookmarks')
    expect(first.declarativeNetRequestEnforced).toBe(true)
  })

  it('reads again what it wrote: a reference is a report', () => {
    expect(readReport(JSON.parse(JSON.stringify(reference)), 'again')).toEqual(reference)
  })

  it('refuses what is not a report, with the file and the reason', () => {
    expect(() => readReport([], 'out.json')).toThrow('out.json: not a report (an object is expected)')
    expect(() => readReport({ suites: {} }, 'out.json')).toThrow('out.json: no engine version')
    expect(() => readReport({ engine }, 'out.json')).toThrow('out.json: neither "suites" nor "checks"')
    expect(() => readReport({ engine, suites: { main: { code: 0, checks: [{ name: 'x' }] } } }, 'out.json')).toThrow('out.json, suite "main": check 0 has no name or no result')
    expect(() => readReport({ engine, suites: { main: { code: 0 } } }, 'out.json')).toThrow('out.json, suite "main": "checks" is not a list')
  })
})

describe('setting a run against the reference', () => {
  it('finds nothing lost in the same run', () => {
    expect(compareReports(reference, reference)).toEqual({ regressions: [], news: [], explained: [], unusedExplanations: [] })
  })

  it('a check that passed and now fails, is skipped or is no longer made is lost', () => {
    const run = report({
      main: { code: 1, checks: [fail('page loads'), skip('find in page counts the matches'), fail('known to fail')] },
      sec2: { code: 0, checks: [] }
    })
    expect(compareReports(reference, run).regressions).toEqual([
      'main: failed (passed in the reference): page loads',
      'main: skipped (passed in the reference): find in page counts the matches',
      'sec2: no longer made: sec2: a debugger is refused'
    ])
  })

  it('a suite of the reference that did not run is lost', () => {
    const run = report({ main: reference.suites['main']! })
    expect(compareReports(reference, run).regressions).toEqual(['suite "sec2": did not run (1 checks in the reference)'])
  })

  it('a check that failed in the reference and still fails is known, not lost; one that passes now is said', () => {
    const still = compareReports(reference, reference)
    expect(still.regressions).toEqual([])
    const fixed = report({ main: { code: 0, checks: [pass('page loads'), pass('find in page counts the matches'), pass('known to fail')] }, sec2: reference.suites['sec2']! })
    expect(compareReports(reference, fixed)).toEqual({ regressions: [], news: ['main: passes now (failed in the reference): known to fail'], explained: [], unusedExplanations: [] })
  })

  it('a new check that passes is news; a new check that fails is not hidden among the news', () => {
    const run = report({
      main: { code: 1, checks: [...reference.suites['main']!.checks, pass('a new check'), fail('a new check that fails'), skip('a new check not made')] },
      sec2: reference.suites['sec2']!,
      extwindows: { code: 1, checks: [pass('one'), fail('two')] }
    })
    expect(compareReports(reference, run)).toEqual({
      regressions: ['main: new check, failed: a new check that fails'],
      news: ['main: new check (passed): a new check', 'main: new check (skipped): a new check not made', 'suite "extwindows": new (2 checks, 1 failed)'],
      explained: [],
      unusedExplanations: []
    })
  })

  it('a chrome.* API that was there and is missing, and a call that no longer answers, are lost', () => {
    const run = report(reference.suites, { apiProbe: { present: 90, missing: ['bookmarks', 'tabs.discard', 'offscreen'], calls: { 'tabs.query({})': 'ok', 'cookies.getAll': 'Error: no such method' } } })
    expect(compareReports(reference, run)).toEqual({
      regressions: [
        'chrome.* APIs: tabs.discard is missing (present in the reference)',
        'chrome.* APIs: offscreen is missing (present in the reference)',
        'chrome.* APIs: 90 present, 92 in the reference',
        'chrome.* calls: cookies.getAll answered "Error: no such method" (ok in the reference)'
      ],
      news: ['chrome.* APIs: history is present now'],
      explained: [],
      unusedExplanations: []
    })
  })

  it('a probe that no longer answers is lost', () => {
    expect(compareReports(reference, report(reference.suites, { apiProbe: null })).regressions).toEqual(['chrome.* APIs: the probe gave no answer (it did in the reference)'])
  })

  it('a request rule of an extension that was applied and is not, or was not measured, is lost', () => {
    expect(compareReports(reference, report(reference.suites, { declarativeNetRequestEnforced: false })).regressions).toEqual(['declarativeNetRequest: the rule of an extension is not applied (applied in the reference)'])
    expect(compareReports(reference, report(reference.suites, { declarativeNetRequestEnforced: null })).regressions).toEqual(['declarativeNetRequest: the rule of an extension is not measured (applied in the reference)'])
    // A reference that already recorded it as not applied does not complain again.
    const known = report(reference.suites, { declarativeNetRequestEnforced: false })
    expect(compareReports(known, known).regressions).toEqual([])
  })

  it('reads the state of each request rule and each webRequest event the suite of the extension questions measured', () => {
    const raw = { engine, suites: {}, extensionNetworkRules: { 'dnr.session.block': 'applied', 'webRequest.onCompleted': 'not-applied' } }
    expect(readReport(raw, 'run').extensionNetworkRules).toEqual({ 'dnr.session.block': 'applied', 'webRequest.onCompleted': 'not-applied' })
    expect(readReport({ engine, suites: {} }, 'run').extensionNetworkRules).toBeNull()
    expect(readReport({ engine, suites: {}, extensionNetworkRules: ['applied'] }, 'run').extensionNetworkRules).toBeNull()
  })

  it('a rule or an event that was applied and is not, or was not measured, is lost; one that is applied at last is news', () => {
    const before = report(reference.suites, { extensionNetworkRules: { 'dnr.session.block': 'applied', 'dnr.session.redirect': 'not-applied', 'webRequest.onCompleted': 'applied' } })
    const after = report(reference.suites, { extensionNetworkRules: { 'dnr.session.block': 'not-applied', 'dnr.session.redirect': 'applied' } })
    expect(compareReports(before, after)).toEqual({
      regressions: ['extension network rules: dnr.session.block is not-applied (applied in the reference)', 'extension network rules: webRequest.onCompleted is not measured (applied in the reference)'],
      news: ['extension network rules: dnr.session.redirect is applied now (not-applied in the reference)'],
      explained: [],
      unusedExplanations: []
    })
    // A run where the suite did not report at all loses everything the reference had applied.
    expect(compareReports(before, report(reference.suites)).regressions).toEqual(['extension network rules: dnr.session.block is not measured (applied in the reference)', 'extension network rules: webRequest.onCompleted is not measured (applied in the reference)'])
    // What the reference records as not applied, or as without ground, is known: the same state again is no loss.
    const known = report(reference.suites, { extensionNetworkRules: { 'dnr.session.block': 'not-applied', 'dnr.session.allow': 'no-ground' } })
    expect(compareReports(known, known)).toEqual({ regressions: [], news: [], explained: [], unusedExplanations: [] })
    // A reference written before the suite existed has nothing to lose, and what a first run finds applied is news.
    expect(compareReports(reference, report(reference.suites, { extensionNetworkRules: { 'dnr.session.block': 'applied', 'dnr.session.allow': 'not-applied' } }))).toEqual({ regressions: [], news: ['extension network rules: dnr.session.block is applied now (not measured in the reference)'], explained: [], unusedExplanations: [] })
  })
})

describe('the name of a check', () => {
  it('loses the port of a local server, which the system picks anew for each run', () => {
    expect(normalizeCheckName('127.0.0.1:64949 finished filling its storage')).toBe('127.0.0.1:<port> finished filling its storage')
    expect(normalizeCheckName('q.p.localhost:52516 was filled again')).toBe('q.p.localhost:<port> was filled again')
    expect(normalizeCheckName('localhost:9 holds data, as does http://[::1]:61234/page')).toBe('localhost:<port> holds data, as does http://[::1]:<port>/page')
    expect(normalizeCheckName(normalizeCheckName('p.localhost:54044 holds data'))).toBe('p.localhost:<port> holds data')
  })

  it('keeps every other figure: they are the same from run to run, and two checks would otherwise take one name', () => {
    for (const name of [
      'calc: "2026-10-24" gives no answer row',
      'find: past the limit the count stops and says so ("1/2000+")',
      'at 1200 x 700 the sidebar keeps the width of its setting',
      '...nor push it off the screen (moveTo(-5000, -5000))',
      'a page with theme-color #c8102e: a red bar',
      'a reminder set for 12:30 rings',
      'notlocalhost:80 is not a host of the machine'
    ]) expect(normalizeCheckName(name)).toBe(name)
  })

  it('is read without its port from a report and from a reference: the same check of two runs is not lost', () => {
    const raw = (port: number) => ({ engine, suites: { sitedata: { code: 0, checks: [{ name: `127.0.0.1:${port} finished filling its storage`, ok: true }, { name: `p.localhost:${port} was filled again`, ok: true }] } } })
    const before = readReport(raw(64949), 'reference')
    const after = readReport(raw(52516), 'run')
    expect(after.suites['sitedata']?.checks.map((check) => check.name)).toEqual(['127.0.0.1:<port> finished filling its storage', 'p.localhost:<port> was filled again'])
    expect(compareReports(before, after)).toEqual({ regressions: [], news: [], explained: [], unusedExplanations: [] })
  })
})

describe('a check made several times', () => {
  const filled = (...states: Array<'pass' | 'fail' | 'skip'>) =>
    report({ cleardata2: { code: 0, checks: states.map((state) => (state === 'pass' ? pass : state === 'fail' ? fail : skip)('localhost:<port> was filled again')) } })

  it('is known by its count: a run that makes it fewer times loses the difference', () => {
    expect(compareReports(filled('pass', 'pass', 'pass'), filled('pass', 'pass')).regressions).toEqual(['cleardata2: no longer made: localhost:<port> was filled again (made 2 times, 3 in the reference)'])
    expect(compareReports(filled('pass', 'pass', 'pass'), filled('pass', 'pass', 'pass'))).toEqual({ regressions: [], news: [], explained: [], unusedExplanations: [] })
  })

  it('loses one that no longer passes, even when another time of the same name still does', () => {
    expect(compareReports(filled('pass', 'pass'), filled('pass', 'fail')).regressions).toEqual(['cleardata2: failed (passed in the reference): localhost:<port> was filled again'])
    expect(compareReports(filled('pass', 'pass'), filled('skip', 'pass')).regressions).toEqual(['cleardata2: skipped (passed in the reference): localhost:<port> was filled again'])
  })

  it('says a time that passes now, and a time beyond those of the reference; one beyond that fails is not hidden', () => {
    expect(compareReports(filled('pass', 'fail'), filled('pass', 'pass'))).toEqual({ regressions: [], news: ['cleardata2: passes now (failed in the reference): localhost:<port> was filled again'], explained: [], unusedExplanations: [] })
    expect(compareReports(filled('pass'), filled('pass', 'pass', 'skip'))).toEqual({
      regressions: [],
      news: ['cleardata2: made once more (passed): localhost:<port> was filled again', 'cleardata2: made once more (skipped): localhost:<port> was filled again'],
      explained: [],
      unusedExplanations: []
    })
    expect(compareReports(filled('pass'), filled('pass', 'fail')).regressions).toEqual(['cleardata2: made once more, failed: localhost:<port> was filled again'])
  })
})

describe('the explanations of the checks removed on purpose', () => {
  const removed = { 'and the Extensions menu keeps “Effacer les données du domaine”': 'the entry is removed from the Extensions menu' }

  it('list a check that is no longer made with its reason, and the comparison passes', () => {
    const before = report({ cleardata2: { code: 0, checks: [pass('a quick clear empties the site'), pass('and the Extensions menu keeps “Effacer les données du domaine”')] } })
    const after = report({ cleardata2: { code: 0, checks: [pass('a quick clear empties the site')] } })
    expect(compareReports(before, after, removed)).toEqual({
      regressions: [],
      news: [],
      explained: ['cleardata2: no longer made: and the Extensions menu keeps “Effacer les données du domaine”: the entry is removed from the Extensions menu'],
      unusedExplanations: []
    })
    // Without them, the same run lost the check.
    expect(compareReports(before, after).regressions).toEqual(['cleardata2: no longer made: and the Extensions menu keeps “Effacer les données du domaine”'])
  })

  it('never explain a check that is still made and fails or is skipped: it does not prove what it proved', () => {
    const before = report({ main: { code: 0, checks: [pass('and the Extensions menu keeps “Effacer les données du domaine”')] } })
    expect(compareReports(before, report({ main: { code: 1, checks: [fail('and the Extensions menu keeps “Effacer les données du domaine”')] } }), removed)).toEqual({
      regressions: ['main: failed (passed in the reference): and the Extensions menu keeps “Effacer les données du domaine”'],
      news: [],
      explained: [],
      unusedExplanations: ['and the Extensions menu keeps “Effacer les données du domaine”']
    })
  })

  it('say which of them matched nothing the run lost', () => {
    expect(compareReports(reference, reference, { 'page loads': 'renamed', 'a check that never was': 'renamed' }).unusedExplanations).toEqual(['page loads', 'a check that never was'])
  })

  it('are read from a file, with the names written as a report writes them', () => {
    expect(readExplanations({ '127.0.0.1:50697 was filled again': '  one fill fewer  ', 'Cast': 'removed' }, 'explained.json')).toEqual({ '127.0.0.1:<port> was filled again': 'one fill fewer', Cast: 'removed' })
  })

  it('are refused, with the file and the reason, when they are not a list of names with their reasons', () => {
    expect(() => readExplanations(['Cast'], 'explained.json')).toThrow('explained.json: not a list of explanations')
    expect(() => readExplanations(null, 'explained.json')).toThrow('explained.json: not a list of explanations')
    expect(() => readExplanations({ Cast: '' }, 'explained.json')).toThrow('explained.json: "Cast" has no reason')
    expect(() => readExplanations({ Cast: '   ' }, 'explained.json')).toThrow('explained.json: "Cast" has no reason')
    expect(() => readExplanations({ Cast: true }, 'explained.json')).toThrow('explained.json: "Cast" has no reason')
  })
})

describe('the reference a run is set against', () => {
  it('is the one of the highest version, read as numbers', () => {
    expect(latestBaseline(['baseline-electron-45.0.0.json', 'baseline-electron-45.10.0.json', 'baseline-electron-45.2.1.json', 'api-probe', 'README.md'])).toBe('baseline-electron-45.10.0.json')
    expect(latestBaseline(['baseline-electron-45.2.1+wvcus.json', 'baseline-electron-45.2.1.json', 'baseline-electron-46.0.0.json'])).toBe('baseline-electron-46.0.0.json')
    expect(latestBaseline(['api-probe', 'baseline-notes.json'])).toBeNull()
  })

  it('orders versions part by part', () => {
    expect(compareVersions('45.10.0', '45.2.1')).toBeGreaterThan(0)
    expect(compareVersions('45.2.1', '45.2.1')).toBe(0)
    expect(compareVersions('45.2', '45.2.1')).toBeLessThan(0)
  })

  it('is named after the version of Electron of the run', () => {
    expect(baselineName('45.2.1')).toBe('baseline-electron-45.2.1.json')
  })
})
