// The last lines the main process wrote to its error log, kept in memory for Settings › Général › État de Lucium: the lines a person would otherwise find
// only by starting the application from a terminal. Nothing is written to disk and nothing leaves the machine; the pane shows them apart from the report.
// A line is redacted as it enters (shared/log-redaction.ts: a path keeps its file name, an address its host), so that the name of the account and the
// sites that failed are in no line the pane, the report or a copy can show; the console itself still writes the line in full.
// Wrapping `console.error` costs a push on an array of 50 lines, and only when the application writes an error.

import { format } from 'node:util'
import { redactLogLine } from '@shared/log-redaction'

/** The lines kept; the oldest goes when the 51st comes. */
export const ERROR_LOG_MAX = 50
/** A line is cut here: a stack trace or a page's text must not fill the pane. */
export const ERROR_LINE_MAX = 300
/**
 * What is read of an entry before it is reduced. A page can make an error as long as it likes (an address of 64 Ko, the message of a script), and
 * the reduction runs in the main process on every `console.error`: its cost is bounded here, whatever the text. Far above `ERROR_LINE_MAX`, because a
 * reduced line is shorter than what it came from (a long path becomes a file name) and the 300 characters kept are counted after.
 */
export const ERROR_TEXT_MAX = 4000

export class ErrorLog {
  private readonly kept: string[] = []

  constructor(
    private readonly now: () => number = Date.now,
    private readonly redact: (line: string) => string = redactLogLine
  ) {}

  /** Keeps one entry of the console: the time, then what was written on one line. */
  add(args: readonly unknown[]): void {
    let text: string
    try {
      text = format(...args)
    } catch {
      // An argument that cannot be written (a revoked proxy, a cycle `format` refuses): the line says so instead of being lost.
      text = '(an error that could not be written)'
    }
    // Redacted before the line is cut to what is shown: a cut in the middle of a path would leave the start of the account's name. The first cut, at
    // `ERROR_TEXT_MAX`, is the one that bounds the work; what it leaves half read at its end (a path, an address) is reduced like a whole one, and a
    // text that was cut always ends with the mark that says so.
    const long = text.length > ERROR_TEXT_MAX
    const line = this.redact(long ? text.slice(0, ERROR_TEXT_MAX) : text).replace(/\s*\n\s*/g, ' ⏎ ').trim()
    this.kept.push(`${new Date(this.now()).toISOString()} ${line.length > ERROR_LINE_MAX ? `${line.slice(0, ERROR_LINE_MAX)}…` : long ? `${line}…` : line}`)
    if (this.kept.length > ERROR_LOG_MAX) this.kept.splice(0, this.kept.length - ERROR_LOG_MAX)
  }

  /** The lines, oldest first. */
  lines(): string[] {
    return [...this.kept]
  }

  /** Empties the log (Settings › Général › État de Lucium › Effacer le journal). What comes after is kept as before. */
  clear(): void {
    this.kept.length = 0
  }
}

/** The log of this process. */
export const errorLog = new ErrorLog()

/** Makes `console.error` also feed the log; the console still writes as before. Returns the function that puts the console back (the tests use it). */
export function installErrorLog(log: ErrorLog = errorLog, target: Pick<Console, 'error'> = console): () => void {
  const original = target.error
  target.error = (...args: unknown[]) => {
    log.add(args)
    original.apply(target, args)
  }
  return () => {
    target.error = original
  }
}
