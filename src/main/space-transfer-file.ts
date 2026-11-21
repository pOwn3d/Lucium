// A space as a file (shared/space-transfer.ts for what it holds): written plain or sealed with a passphrase (export-crypto.ts, the same cipher as « Exporter
// les données »), and read back through `openExportFile`, which already bounds the size, parses and asks for the phrase. No Electron here: the dialogs are
// the shell's (shell/space-transfer.ts), so that every rule is tested against real files.

import type { SidebarState } from '@shared/model'
import { parseSpaceTransfer, spaceTransferOf, spaceTransferRefusal } from '@shared/space-transfer'
import { encryptExport, type EncryptOptions } from './export-crypto'
import { openExportFile } from './export-file'
import { t } from '@shared/i18n'

/** The text of the file for the space: sealed with the passphrase when there is one, plain JSON otherwise; or the sentence that says why the space cannot leave. */
export async function spaceTransferText(
  state: SidebarState,
  spaceId: string,
  passphrase: string | null,
  lockedSpaces: readonly string[],
  options?: EncryptOptions
): Promise<{ ok: true; text: string; encrypted: boolean; name: string } | { ok: false; message: string }> {
  const refusal = spaceTransferRefusal(state, spaceId, lockedSpaces)
  if (refusal !== null) return { ok: false, message: refusal }
  const transfer = spaceTransferOf(state, spaceId)
  if (!transfer) return { ok: false, message: t('sessions.cet-espace-n-existe-plus') }
  const json = `${JSON.stringify(transfer, null, 2)}\n`
  const name = transfer.aside.space.name
  if (passphrase === null) return { ok: true, text: json, encrypted: false, name }
  return { ok: true, text: await encryptExport(json, passphrase, options), encrypted: true, name }
}

/** Reads a file chosen to be imported: the space it holds, or why it cannot be one (a full export, a state file and any other JSON are told apart by `format`). */
export async function readSpaceTransfer(path: string, ask: (previous: string | null) => Promise<string | null>): Promise<ReturnType<typeof parseSpaceTransfer> | { ok: false; message: string; cancelled?: true }> {
  const opened = await openExportFile(path, ask)
  if (!opened.ok) return { ok: false, message: opened.message, ...(opened.cancelled ? { cancelled: true } : {}) }
  return parseSpaceTransfer(opened.value)
}
