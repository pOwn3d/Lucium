// The lookalike warnings of the run (shared/typo-warnings.ts), shared by what says an address was typed (the shell), the request filter that holds its
// first load, and the error page of the engine that shows the warning and lets the host through. One memory for every window, popup and mini window.

import { TypoWarnings } from '@shared/typo-warnings'

export const typoGate = new TypoWarnings(() => Date.now())
