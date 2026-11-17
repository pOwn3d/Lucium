// What the Settings panel asks of the user-script manager, answered with the sentence the panel shows. Electron-free: the file dialog is
// handed in, so the rules (nothing is written from a private window, a file is bounded, a script is added switched off) are tested as such.

import { USER_SCRIPT_MAX_BYTES, type UserScriptReply, type UserScriptRequest } from '@shared/userscript'
import type { UserScripts } from '../userscripts'
import { t } from '@shared/i18n'

export interface UserScriptDeps {
  scripts: UserScripts
  /** A private window keeps nothing on disk: it can read the list, nothing else. */
  isPrivate: boolean
  /** Asks the user for a file and reads it (bounded); null when they cancel, a sentence when it cannot be read or is too big. */
  pickFile: () => Promise<{ fileName: string; text: string } | { error: string } | null>
}

// A function, not a constant: the language of the process is set after this module is loaded.
const notInPrivate = (): string => t('userscripts-service.les-scripts-ne-se-gerent-pas-depuis-une')

export async function handleUserScriptRequest(request: UserScriptRequest, deps: UserScriptDeps): Promise<UserScriptReply> {
  const { scripts, isPrivate } = deps
  const reply = (ok: boolean, message?: string, extra: Partial<UserScriptReply> = {}): UserScriptReply => ({ ok, ...(message ? { message } : {}), scripts: scripts.list(), ...extra })

  switch (request.kind) {
    case 'list':
      return reply(true)
    case 'source': {
      const text = scripts.sourceOf(request.id)
      return text === undefined ? reply(false, t('userscripts-service.ce-script-n-existe-plus')) : reply(true, undefined, { text })
    }
    case 'pick-file': {
      if (isPrivate) return reply(false, notInPrivate())
      const picked = await deps.pickFile()
      if (picked === null) return reply(false)
      if ('error' in picked) return reply(false, picked.error)
      return reply(true, undefined, { text: picked.text, fileName: picked.fileName })
    }
    case 'add': {
      if (isPrivate) return reply(false, notInPrivate())
      const outcome = scripts.add(request.text)
      if (!outcome.ok) return reply(false, outcome.error)
      return reply(true, outcome.replaced ? t('userscripts-service.script-remplace-desactive-lisez-le-avant-de') : t('userscripts-service.script-ajoute-desactive-lisez-le-puis'), { id: outcome.id })
    }
    case 'set-enabled': {
      if (isPrivate) return reply(false, notInPrivate())
      const error = scripts.setEnabled(request.id, request.enabled)
      return error ? reply(false, error) : reply(true)
    }
    case 'set-private': {
      if (isPrivate) return reply(false, notInPrivate())
      const error = scripts.setAllowPrivate(request.id, request.allow)
      return error ? reply(false, error) : reply(true)
    }
    case 'remove': {
      if (isPrivate) return reply(false, notInPrivate())
      const error = scripts.remove(request.id)
      return error ? reply(false, error) : reply(true, t('userscripts-service.script-retire'))
    }
  }
}

/** The message for a file that is too big to be a script (a function: read in the language of the moment). */
export const scriptFileTooBig = (): string => t('userscripts-service.ce-fichier-depasse-size-ko-ce-n-est-pas-un', { size: Math.round(USER_SCRIPT_MAX_BYTES / 1000) })
