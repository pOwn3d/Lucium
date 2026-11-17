// Places offered to the user, and answered by them, for a file that comes from a page (the name is cleaned by shared/file-names.ts).

import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

/** Whether `child` is `root` itself or something inside it, by the path as written: no `..` step and no other drive may lead out. */
export function isInside(root: string, child: string): boolean {
  if (!isAbsolute(root) || !isAbsolute(child)) return false
  const path = relative(resolve(root), resolve(child))
  // Inside means the way from the root to the child never starts with a step up (a folder named "..data" is a folder like another).
  return path === '' || (!isAbsolute(path) && path.split(sep)[0] !== '..')
}

/**
 * The place a user's answer designates: an absolute path with a file name (not a folder, not empty) and no control character. The
 * system dialog already guarantees most of it; an interface that is replaced by a test or a bug must not be able to hand over more.
 */
export function chosenFilePath(answer: unknown): string | null {
  if (typeof answer !== 'string' || answer === '' || answer.length > 4096 || !isAbsolute(answer) || /\p{Cc}/u.test(answer)) return null
  if (answer.endsWith('/') || basename(answer) === '' || basename(answer) === '..' || basename(answer) === '.') return null
  if (answer.split('/').includes('..')) return null
  return resolve(answer)
}

/** The folder a chosen file sits in (to create when the user typed a new one). */
export const folderOf = (path: string): string => dirname(path)
