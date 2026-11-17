// The text of an error that crossed IPC. Electron prefixes what the main process threw with "Error invoking remote method '<channel>': " and
// the name of the error; the sentence the main process wrote is what the user needs. The one place the interface removes that prefix.

const IPC_PREFIX = /^Error invoking remote method '[^']*': (?:Error: )?/

/** The message of `error` without the prefix of the IPC layer; anything that is not an Error is written as text. */
export function ipcErrorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(IPC_PREFIX, '')
}
