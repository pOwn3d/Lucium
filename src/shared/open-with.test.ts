import { describe, expect, it } from 'vitest'
import { applicationName, cleanOpenWithApps, fileTypeOf, isApplicationPath, isExecutableDownload, isRememberableType, mayOnlyForget, openPlan, rememberApplication, OPEN_WITH_MAX } from './open-with'

describe('fileTypeOf', () => {
  it('is the extension, in lower case', () => {
    expect(fileTypeOf('Report.PDF')).toBe('pdf')
    expect(fileTypeOf('archive.tar.gz')).toBe('gz')
  })

  it('is nothing for a name without a usable extension', () => {
    for (const name of ['README', '.bashrc', 'name.', 'a.b c', 'a.é', `a.${'x'.repeat(13)}`, '', undefined, 3]) expect(fileTypeOf(name)).toBeNull()
  })
})

describe('isExecutableDownload', () => {
  it('refuses the types that can run, whatever the case', () => {
    for (const name of ['setup.pkg', 'run.COMMAND', 'x.sh', 'App.app', 'disk.dmg', 'tool.jar', 'macro.docm', 'a.scpt', 'link.webloc', 'p.py']) expect(isExecutableDownload(name)).toBe(true)
    // Disk images other than .dmg, a launcher, shortcuts, and what installs a trust or a profile.
    for (const name of ['a.shortcut', 'b.sparseimage', 'c.sparsebundle', 'd.cdr', 'e.jnlp', 'f.cer', 'g.P12', 'h.pfx', 'i.mobileprovision']) expect(isExecutableDownload(name), name).toBe(true)
  })

  it('refuses what macOS mounts, installs or runs with the rights of a site when it is opened', () => {
    for (const name of ['serveur.afploc', 'partage.smbloc', 'ecran.vncloc', 'Reglage.prefPane', 'veille.saver', 'apercu.qlgenerator', 'page.webarchive', 'Xcode.xip', 'disque.img', 'lib.dylib', 'extension.safariextz', 'script.jxa']) expect(isExecutableDownload(name), name).toBe(true)
    expect(isRememberableType('webarchive')).toBe(false)
  })

  it('refuses a name with no type: nothing says what opens it', () => {
    expect(isExecutableDownload('configure')).toBe(true)
  })

  it('refuses a server that says the file is a program, even under a harmless name', () => {
    expect(isExecutableDownload('photo.jpg', 'application/x-sh')).toBe(true)
    expect(isExecutableDownload('photo.jpg', 'application/x-msdownload')).toBe(true)
    expect(isExecutableDownload('photo.jpg', 'application/java-archive; charset=x')).toBe(true)
  })

  it('lets documents through', () => {
    expect(isExecutableDownload('doc.pdf', 'application/pdf')).toBe(false)
    expect(isExecutableDownload('photo.JPG', 'image/jpeg')).toBe(false)
    expect(isExecutableDownload('sheet.xlsx')).toBe(false)
  })
})

describe('isApplicationPath', () => {
  it('accepts a bundle path', () => {
    expect(isApplicationPath('/Applications/Preview.app')).toBe(true)
    expect(isApplicationPath('/Users/me/Applications/My App.APP')).toBe(true)
  })

  it('refuses anything else', () => {
    for (const path of ['', 'Preview.app', '/Applications/Preview', '/Applications/Preview.app/Contents/MacOS/Preview', '/Applications/../bin/sh.app', '/a\nb.app', '/Applications/.app', `/${'a'.repeat(1100)}.app`, null, 4, '/./x.app']) expect(isApplicationPath(path)).toBe(false)
  })
})

describe('cleanOpenWithApps', () => {
  it('keeps the valid entries and drops the others one by one', () => {
    expect(cleanOpenWithApps({ pdf: '/Applications/Preview.app', sh: '/Applications/Terminal.app', png: 'Preview.app', 'bad type': '/Applications/X.app', txt: 5 })).toEqual({ pdf: '/Applications/Preview.app' })
  })

  it('takes nothing from what is not a record', () => {
    for (const raw of [null, undefined, [], 'x', 3, ['/Applications/X.app']]) expect(cleanOpenWithApps(raw)).toEqual({})
  })

  it('is bounded', () => {
    const many = Object.fromEntries(Array.from({ length: OPEN_WITH_MAX + 50 }, (_, i) => [`t${i}`, `/Applications/A${i}.app`]))
    expect(Object.keys(cleanOpenWithApps(many))).toHaveLength(OPEN_WITH_MAX)
  })

  it('does not let __proto__ become a type', () => {
    const hostile = JSON.parse('{"__proto__":"/Applications/X.app","pdf":"/Applications/P.app"}')
    const out = cleanOpenWithApps(hostile)
    expect(Object.keys(out)).toEqual(['pdf'])
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
  })
})

describe('rememberApplication', () => {
  it('adds or replaces the application of a type', () => {
    expect(rememberApplication({}, 'pdf', '/Applications/Preview.app')).toEqual({ pdf: '/Applications/Preview.app' })
    expect(rememberApplication({ pdf: '/Applications/Preview.app' }, 'pdf', '/Applications/Skim.app')).toEqual({ pdf: '/Applications/Skim.app' })
  })

  it('never remembers an executable type nor a path that is not an application', () => {
    expect(rememberApplication({}, 'sh', '/Applications/Terminal.app')).toEqual({})
    expect(rememberApplication({}, null, '/Applications/Preview.app')).toEqual({})
    expect(rememberApplication({}, 'pdf', '/usr/bin/open')).toEqual({})
  })

  it('does not grow past the limit', () => {
    const full = Object.fromEntries(Array.from({ length: OPEN_WITH_MAX }, (_, i) => [`t${i}`, '/Applications/A.app']))
    expect(Object.keys(rememberApplication(full, 'zzz', '/Applications/B.app'))).toHaveLength(OPEN_WITH_MAX)
    expect(rememberApplication(full, 't1', '/Applications/B.app')['t1']).toBe('/Applications/B.app')
  })
})

describe('mayOnlyForget', () => {
  const current = { pdf: '/Applications/Preview.app', txt: '/Applications/TextEdit.app' }
  it('lets the list shrink, down to nothing', () => {
    expect(mayOnlyForget(current, { pdf: '/Applications/Preview.app' })).toBe(true)
    expect(mayOnlyForget(current, {})).toBe(true)
    expect(mayOnlyForget(current, current)).toBe(true)
  })

  it('refuses a new type, a new application for a type, and what is not a record', () => {
    expect(mayOnlyForget(current, { ...current, png: '/Applications/Preview.app' })).toBe(false)
    expect(mayOnlyForget(current, { pdf: '/Applications/Evil.app' })).toBe(false)
    for (const next of [null, undefined, [], 'x', 3]) expect(mayOnlyForget(current, next)).toBe(false)
    expect(mayOnlyForget(current, JSON.parse('{"__proto__":{}}'))).toBe(false)
  })
})

describe('openPlan', () => {
  const settings = { openWithMemory: true, openWithApps: { pdf: '/Applications/Skim.app', sh: '/Applications/Terminal.app' } }
  it('uses the remembered application for its type', () => {
    expect(openPlan(settings, 'a.PDF')).toEqual({ kind: 'application', app: '/Applications/Skim.app' })
  })

  it('does nothing of the kind when the setting is off', () => {
    expect(openPlan({ ...settings, openWithMemory: false }, 'a.pdf')).toEqual({ kind: 'system' })
  })

  it('keeps an executable type away from a remembered application, even one found in a file that was edited', () => {
    expect(openPlan(settings, 'run.sh')).toEqual({ kind: 'system' })
    expect(openPlan(settings, 'a.pdf', 'application/x-sh')).toEqual({ kind: 'system' })
  })

  it('falls back to the system for an unknown type, and for an entry that is no application', () => {
    expect(openPlan(settings, 'a.png')).toEqual({ kind: 'system' })
    expect(openPlan({ openWithMemory: true, openWithApps: { pdf: '/bin/sh' } }, 'a.pdf')).toEqual({ kind: 'system' })
    expect(openPlan({ openWithMemory: true, openWithApps: {} }, 'toString.pdf')).toEqual({ kind: 'system' })
  })
})

describe('applicationName and isRememberableType', () => {
  it('names an application without its suffix', () => {
    expect(applicationName('/Applications/Preview.app')).toBe('Preview')
    expect(applicationName('/Users/me/My App.app/')).toBe('My App')
  })

  it('knows a type worth remembering', () => {
    expect(isRememberableType('pdf')).toBe(true)
    expect(isRememberableType('sh')).toBe(false)
    expect(isRememberableType('PDF')).toBe(false)
    expect(isRememberableType('')).toBe(false)
  })
})
