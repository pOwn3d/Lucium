import { t } from '@shared/i18n'

/**
 * The name of a button a list repeats on each of its rows (« Modifier », « Oublier », « Désinstaller »): what it does, then the row it does it
 * to. The list of the buttons of a screen reader shows these names alone, without the row beside them. The visible word comes first, so
 * that a voice command which says it still finds the button; the ellipsis it may end with is left out, which would be read in the middle of the name.
 */
export const actionName = (action: string, name: string): string => t('settings.action-name', { action: action.replace(/…$/, ''), name })
