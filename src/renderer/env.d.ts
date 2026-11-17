/// <reference types="vite/client" />

import type { DetailedHTMLProps, HTMLAttributes } from 'react'

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      /** Defined at runtime by electron-chrome-extensions (see the preload). */
      'browser-action-list': DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & { partition?: string; alignment?: string }
    }
  }
}
