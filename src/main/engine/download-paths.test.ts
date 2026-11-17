import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ReservedPaths, uniquePath } from './download-paths'

const never = () => false
// The paths the code gives back are written by the path module of the system (`\dl\report.pdf` on Windows): so are the ones the tests expect.
const dl = (...names: string[]): string => join('/dl', ...names)

describe('uniquePath', () => {
  it('keeps a free name', () => {
    expect(uniquePath('/dl', 'report.pdf', new ReservedPaths(), never)).toBe(dl('report.pdf'))
  })

  it('numbers a name that is taken on disk', () => {
    const onDisk = new Set([dl('report.pdf'), dl('report (1).pdf')])
    expect(uniquePath('/dl', 'report.pdf', new ReservedPaths(), (p) => onDisk.has(p))).toBe(dl('report (2).pdf'))
  })

  it('does not give the same path to two downloads of the same name that are running together', () => {
    const reserved = new ReservedPaths()
    const first = uniquePath('/dl', 'report.pdf', reserved, never)
    reserved.reserve(first)
    const second = uniquePath('/dl', 'report.pdf', reserved, never)
    reserved.reserve(second)
    const third = uniquePath('/dl', 'report.pdf', reserved, never)
    expect(first).toBe(dl('report.pdf'))
    expect(second).toBe(dl('report (1).pdf'))
    expect(third).toBe(dl('report (2).pdf'))
  })

  it('takes a name back once its download is over', () => {
    const reserved = new ReservedPaths()
    reserved.reserve(dl('report.pdf'))
    expect(uniquePath('/dl', 'report.pdf', reserved, never)).toBe(dl('report (1).pdf'))
    reserved.release(dl('report.pdf'))
    expect(uniquePath('/dl', 'report.pdf', reserved, never)).toBe(dl('report.pdf'))
    expect(reserved.size).toBe(0)
  })

  it('counts a file system that ignores case: Report.PDF is report.pdf', () => {
    const reserved = new ReservedPaths()
    reserved.reserve(dl('Report.PDF'))
    expect(uniquePath('/dl', 'report.pdf', reserved, never)).toBe(dl('report (1).pdf'))
  })

  it('keeps the two extensions of a tarball together (backup (1).tar.gz, not backup.tar (1).gz), whatever the case', () => {
    const reserved = new ReservedPaths()
    for (const [name, next] of [['backup.tar.gz', 'backup (1).tar.gz'], ['Backup.TAR.GZ', 'Backup (1).TAR.GZ'], ['data.tar.xz', 'data (1).tar.xz'], ['plain.tar', 'plain (1).tar'], ['a.b.gz', 'a.b (1).gz'], ['.tar.gz', '.tar (1).gz']] as const) {
      reserved.reserve(dl(name))
      expect(uniquePath('/dl', name, reserved, never), name).toBe(dl(next))
    }
  })

  it('works for a name with no extension and for a folder inside the downloads folder', () => {
    const reserved = new ReservedPaths()
    reserved.reserve(dl('sub', 'README'))
    expect(uniquePath('/dl', 'sub/README', reserved, never)).toBe(dl('sub', 'README (1)'))
  })
})
