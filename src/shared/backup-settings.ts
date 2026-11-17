// The settings of the automatic copies of the session (Settings › Téléchargements et fichiers › Copies automatiques). Pure rules, shared by the loader (a saved
// file may hold anything), the reducer (`settings/update`) and the settings window (the lists it offers).

import { defaultSettings, type Settings } from './model'
import { tp } from './i18n'

/** How many copies can be kept: the choices of the settings window. A file's value is brought to the nearest of them. */
export const BACKUP_KEEP_CHOICES = [2, 3, 5, 10, 20] as const
/** Minutes between two copies: the choices of the settings window. */
export const BACKUP_MINUTES_CHOICES = [5, 15, 30, 60, 120, 360] as const

/** The one of `choices` closest to `value` (the smaller one when two are as close); `fallback` when `value` is not a number. */
function nearest(value: unknown, choices: readonly number[], fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return choices.reduce((best, choice) => (Math.abs(choice - value) < Math.abs(best - value) ? choice : best), choices[0]!)
}

export type BackupSettings = Pick<Settings, 'autoBackup' | 'autoBackupKeep' | 'autoBackupMinutes'>

/**
 * The copy settings of a saved file: anything but a flag gives the default (on), and a number is brought to one of the choices the
 * window offers, so that a damaged or hand-edited file can neither keep thousands of copies nor write one every second.
 */
export function cleanBackupSettings(settings: Partial<Record<keyof BackupSettings, unknown>>): BackupSettings {
  const defaults = defaultSettings()
  return {
    autoBackup: typeof settings.autoBackup === 'boolean' ? settings.autoBackup : defaults.autoBackup,
    autoBackupKeep: nearest(settings.autoBackupKeep, BACKUP_KEEP_CHOICES, defaults.autoBackupKeep),
    autoBackupMinutes: nearest(settings.autoBackupMinutes, BACKUP_MINUTES_CHOICES, defaults.autoBackupMinutes)
  }
}

/** The copies' schedule as the settings give it: off, or a number to keep and the milliseconds between two copies. */
export function backupPlan(settings: Partial<Record<keyof BackupSettings, unknown>>): { enabled: boolean; keep: number; everyMs: number } {
  const clean = cleanBackupSettings(settings)
  return { enabled: clean.autoBackup, keep: clean.autoBackupKeep, everyMs: clean.autoBackupMinutes * 60_000 }
}

/** "15 minutes", "1 heure", "6 heures": a delay between two copies, as the list of the settings names it. */
export function minutesLabel(minutes: number): string {
  return minutes < 60 ? tp('backup-settings.minutes', minutes) : tp('backup-settings.heures', minutes / 60)
}
