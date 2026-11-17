// Edit › Spelling and Grammar › Check Spelling While Typing: the choice is kept in the settings, so that it is still there at the next launch.
// Pure rules (what a saved value may hold, what is applied for it); the main process applies the result to the engine's sessions
// (shell/page-commands.ts, `followSpellChecking`) and the menu records the user's click (shell/menu.ts).

/**
 * `auto` is what the application did before the choice was kept: follow the system. macOS has a checker of its own, so spelling is checked there;
 * elsewhere Chromium would fetch its dictionaries from its CDN as soon as a field is used, so it stays off until the user asks. `on` and `off` are
 * the user's own choice, whatever the system would do.
 */
export const SPELL_CHECK_CHOICES = ['auto', 'on', 'off'] as const
export type SpellCheckChoice = (typeof SPELL_CHECK_CHOICES)[number]

/** A saved or imported value: one of the three words, else `auto` (a damaged file never switches on a checker that fetches dictionaries). */
export const cleanSpellCheck = (value: unknown): SpellCheckChoice => ((SPELL_CHECK_CHOICES as readonly unknown[]).includes(value) ? (value as SpellCheckChoice) : 'auto')

/** Whether the sessions of the engine check spelling: the user's choice, or the system's default (`systemDefault`) while there is none. */
export const spellCheckEnabled = (choice: SpellCheckChoice, systemDefault: boolean): boolean => (choice === 'auto' ? systemDefault : choice === 'on')

/** What a click on the menu entry records: the user's own choice, never `auto`. */
export const spellCheckChoiceOf = (enabled: boolean): SpellCheckChoice => (enabled ? 'on' : 'off')
