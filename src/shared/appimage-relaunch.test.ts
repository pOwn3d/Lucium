// The command that starts the new AppImage, and the environment it gets: what the old AppImage set must not follow, what the person set must.
import { describe, expect, it } from 'vitest'
import { appImageRelaunch, cleanedEnvironment, RELAUNCH_GRACE_SECONDS, RELAUNCH_SCRIPT, RELAUNCH_WAIT_SECONDS } from './appimage-relaunch'

const OLD_ENV = {
  APPDIR: '/tmp/.mount_LuciumA1b2C3',
  APPIMAGE: '/home/ana/Apps/Lucium.AppImage',
  ARGV0: './Lucium.AppImage',
  OWD: '/home/ana',
  LD_LIBRARY_PATH: '/tmp/.mount_LuciumA1b2C3/usr/lib:/opt/mine/lib',
  PATH: '/tmp/.mount_LuciumA1b2C3/usr/bin:/usr/local/bin:/usr/bin',
  XDG_DATA_DIRS: '/tmp/.mount_LuciumA1b2C3/usr/share:/usr/share',
  HOME: '/home/ana',
  LANG: 'fr_FR.UTF-8',
  DISPLAY: ':0'
}

describe('the environment of the new AppImage', () => {
  it('drops the variables the old AppImage set, and keeps the person’s own', () => {
    const cleaned = cleanedEnvironment(OLD_ENV)
    for (const name of ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD']) expect(cleaned).not.toHaveProperty(name)
    expect(cleaned).toMatchObject({ HOME: '/home/ana', LANG: 'fr_FR.UTF-8', DISPLAY: ':0' })
  })

  it('takes the entries of the old mount out of the path lists, keeps the others in their order, and drops a list that ends up empty', () => {
    const cleaned = cleanedEnvironment({ ...OLD_ENV, GSETTINGS_SCHEMA_DIR: '/tmp/.mount_LuciumA1b2C3/usr/share/glib-2.0/schemas' })
    expect(cleaned.LD_LIBRARY_PATH).toBe('/opt/mine/lib')
    expect(cleaned.PATH).toBe('/usr/local/bin:/usr/bin')
    expect(cleaned.XDG_DATA_DIRS).toBe('/usr/share')
    expect(cleaned).not.toHaveProperty('GSETTINGS_SCHEMA_DIR')
  })

  it('reads an extracted copy (APPIMAGE_EXTRACT_AND_RUN) as an old mount too, and APPDIR wherever it is', () => {
    const cleaned = cleanedEnvironment({ APPDIR: '/home/ana/squashfs-root', LD_LIBRARY_PATH: '/home/ana/squashfs-root/usr/lib:/tmp/appimage_extracted_9f8e/usr/lib:/home/ana/squashfs-root-other/lib' })
    expect(cleaned.LD_LIBRARY_PATH).toBe('/home/ana/squashfs-root-other/lib')
  })

  it('leaves out the variables that are undefined', () => {
    expect(cleanedEnvironment({ HOME: '/home/ana', EMPTY: undefined })).toEqual({ HOME: '/home/ana' })
  })
})

describe('the command that starts the new AppImage', () => {
  const run = appImageRelaunch('/home/ana/Apps/Lucium.AppImage', 4242, OLD_ENV)

  it('is a shell that gets the pid to wait for, the file, and the waits as separate arguments, never as a part of the script', () => {
    expect(run.command).toBe('/bin/sh')
    expect(run.args).toEqual(['-c', RELAUNCH_SCRIPT, 'lucium-relaunch', '4242', '/home/ana/Apps/Lucium.AppImage', String(RELAUNCH_WAIT_SECONDS), String(RELAUNCH_GRACE_SECONDS)])
    expect(RELAUNCH_SCRIPT).not.toContain('/home/ana')
  })

  it('runs in the folder of the file, which the old mount does not own, with the cleaned environment', () => {
    expect(run.cwd).toBe('/home/ana/Apps')
    expect(run.env).toEqual(cleanedEnvironment(OLD_ENV))
  })

  it('keeps a file at the root in the root, and a path with a space or a quote as one argument', () => {
    expect(appImageRelaunch('/Lucium.AppImage', 1, {}).cwd).toBe('/')
    const odd = appImageRelaunch("/home/ana/My Apps/Lu'cium; rm.AppImage", 1, {})
    expect(odd.args[4]).toBe("/home/ana/My Apps/Lu'cium; rm.AppImage")
  })
})
