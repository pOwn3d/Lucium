// The check every reader of untrusted data starts with (a state file, an IPC message, an extension's answer, an imported file): is the value a plain
// record whose fields can be read? One definition for the whole application.

/** A plain record: an object that is neither null nor an array. A Date, a Map or a class instance passes too (no prototype check). */
export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
