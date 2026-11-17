// The capture the annotation sheet is open for. One at a time per window: a new capture replaces it, and it goes when the sheet does. It
// lives in memory only; nothing is written before the user chooses (shell/capture.ts). The browser owns one and answers for it to the IPC.

import { randomUUID } from 'node:crypto'
import { annotationSheetFor, type PictureSize } from '@shared/annotate'
import type { OverlayRequest } from '@shared/ipc'

/** A capture waiting for the sheet: its id, its picture and size, and the suffix its file name would have had (`-zone`, `-page-entiere`…). */
export interface HeldCapture extends PictureSize {
  id: string
  png: Buffer
  suffix: string
}

export class CaptureShelf {
  private held: HeldCapture | null = null

  /** `enabled` is the setting "Annoter les captures", read at each capture; `panel` is the panel on screen. */
  constructor(
    private readonly enabled: () => boolean,
    private readonly panel: () => OverlayRequest | null
  ) {}

  /** Keeps a fresh capture and says how big it is; null when the sheet is not for it (the setting is off, or the picture is not one the sheet can take): it goes the way it always went. */
  hold(png: Buffer, suffix: string): ({ id: string } & PictureSize) | null {
    const size = annotationSheetFor(png, this.enabled())
    if (!size) return null
    this.held = { id: randomUUID(), png, suffix, ...size }
    return { id: this.held.id, ...size }
  }

  /** The held capture, only while the sheet opened for it is the panel on screen and `id` is its id: nothing else can read it. */
  get(id: unknown): HeldCapture | null {
    const open = this.panel()
    return typeof id === 'string' && this.held?.id === id && open?.panel === 'annotate' && open.id === id ? this.held : null
  }

  /** Lets go of the capture (whichever it is when `id` is not given); an id that is not the held one's leaves it alone. */
  drop(id?: string): void {
    if (id === undefined || this.held?.id === id) this.held = null
  }

  holding(): boolean {
    return this.held !== null
  }
}
