// The questions that are on screen now, so that the same one is not put twice. Electron hands every request of a page to the handler: where
// Chromium folds the requests of a page for one permission into the question already shown, a page that asks in a loop would stack one sheet
// of the system after another on its window.

/**
 * One question per key at a time. A second request for a key that is being asked waits for the answer the first one gets; once it is answered
 * the key is free, and the next request is a new question (nothing is remembered here).
 */
export class OpenQuestions {
  private readonly open = new Map<string, Promise<boolean>>()

  ask(key: string, put: () => Promise<boolean>): Promise<boolean> {
    const asked = this.open.get(key)
    if (asked) return asked
    const answer = put().finally(() => {
      if (this.open.get(key) === answer) this.open.delete(key)
    })
    this.open.set(key, answer)
    return answer
  }

  /** How many questions wait for their answer. */
  get size(): number {
    return this.open.size
  }
}

/** What makes two requests the same question: the window that shows it, who asks, what for, and what the question names besides. */
export const questionKey = (windowId: number, origin: string, permission: string, detail?: string): string => JSON.stringify([windowId, origin, permission, detail ?? ''])
