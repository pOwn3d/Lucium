// Focus mode, on its subpage « Mode concentration » (whose row follows the line of the feature while it is on): the sites to keep closed, the
// timer with its Start and Stop buttons, and the weekly slot. The block page itself is drawn by the main process (shared/error-pages.ts).

import type { UiSnapshot } from '@shared/ipc'
import type { Settings } from '@shared/model'
import { FOCUS_MINUTES_MAX, FOCUS_MINUTES_MIN, focusState, formatClock, parseClock, startFocusPatch, stopFocusPatch } from '@shared/focus-mode'
import { t, tp } from '@shared/i18n'
import { Check, Group, Row, Subpage } from './settings-parts'
import { SiteList } from './KeyExtSettings'

interface Props {
  snapshot: UiSnapshot
  update: (patch: Partial<Settings>) => void
}

/** The lengths the menu offers, in minutes; a length set by hand in the file is shown as it is. */
const TIMER_CHOICES = [15, 25, 45, 60, 90, 120] as const
/** Monday first, as a week is read in French and in most of Europe; the values are those of `Date.getDay`. */
const WEEK = [1, 2, 3, 4, 5, 6, 0] as const
const DAY_KEYS = { 0: 'focus.day-0', 1: 'focus.day-1', 2: 'focus.day-2', 3: 'focus.day-3', 4: 'focus.day-4', 5: 'focus.day-5', 6: 'focus.day-6' } as const

export function FocusSettings({ snapshot, update }: Props) {
  const { settings } = snapshot.state
  if (!settings.focusMode) return null
  const state = focusState(settings, Date.now())
  const lengths = TIMER_CHOICES.includes(settings.focusMinutes as (typeof TIMER_CHOICES)[number]) ? TIMER_CHOICES : [...TIMER_CHOICES, settings.focusMinutes].sort((a, b) => a - b)
  const running = state.active && state.by === 'timer'
  const toggleDay = (day: number) => update({ focusDays: settings.focusDays.includes(day) ? settings.focusDays.filter((d) => d !== day) : [...settings.focusDays, day].sort((a, b) => a - b) })
  const setClock = (key: 'focusFrom' | 'focusTo', text: string) => {
    const minutes = parseClock(text)
    if (minutes !== null) update({ [key]: minutes })
  }
  return (
    <Subpage id="focus">
      <SiteList settingKey="focusSites" title={t('focus.sites-title')} footnote={t('focus.sites-footnote')} hosts={settings.focusSites} label={t('focus.site-label')} onChange={(focusSites) => update({ focusSites })} />
      <Group keys={['focusMinutes']} title={t('focus.timer-title')} footnote={t('focus.timer-footnote')}>
        <Row settingKey="focusMinutes" label={t('focus.timer-length')}>
          <select className="field pop" aria-label={t('focus.timer-length')} value={settings.focusMinutes} onChange={(e) => update({ focusMinutes: Math.min(FOCUS_MINUTES_MAX, Math.max(FOCUS_MINUTES_MIN, Number(e.target.value))) })}>
            {lengths.map((minutes) => (
              <option key={minutes} value={minutes}>
                {tp('focus.minutes', minutes)}
              </option>
            ))}
          </select>
        </Row>
        <div className="pref-row pref-form">
          {running ? (
            <button className="button" onClick={() => update(stopFocusPatch())}>
              {t('focus.stop')}
            </button>
          ) : (
            <button className="button" disabled={settings.focusSites.length === 0} onClick={() => update(startFocusPatch(settings.focusMinutes, Date.now()))}>
              {t('focus.start')}
            </button>
          )}
        </div>
        {running && state.until !== null && (
          <div className="pref-row pref-message" role="status">
            {t('focus.running-until', { time: new Date(state.until).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) })}
          </div>
        )}
        {settings.focusSites.length === 0 && (
          <div className="pref-row pref-message" role="status">
            {t('focus.no-site')}
          </div>
        )}
      </Group>
      <Group keys={['focusScheduleOn', 'focusDays', 'focusFrom', 'focusTo']} title={t('focus.slot-title')} footnote={t('focus.slot-footnote')}>
        <Check settingKey="focusScheduleOn" label={t('focus.slot-on')} checked={settings.focusScheduleOn} onChange={(focusScheduleOn) => update({ focusScheduleOn })} />
        <Row settingKey="focusDays" label={t('focus.slot-days')}>
          <div className="preset-buttons" role="group" aria-label={t('focus.slot-days')}>
            {WEEK.map((day) => (
              <button key={day} type="button" aria-pressed={settings.focusDays.includes(day)} disabled={!settings.focusScheduleOn} onClick={() => toggleDay(day)}>
                {t(DAY_KEYS[day])}
              </button>
            ))}
          </div>
        </Row>
        <Row settingKey="focusFrom" label={t('focus.slot-from')}>
          <input className="field" type="time" aria-label={t('focus.slot-from')} disabled={!settings.focusScheduleOn} value={formatClock(settings.focusFrom)} onChange={(e) => setClock('focusFrom', e.target.value)} />
        </Row>
        <Row settingKey="focusTo" label={t('focus.slot-to')}>
          <input className="field" type="time" aria-label={t('focus.slot-to')} disabled={!settings.focusScheduleOn} value={formatClock(settings.focusTo)} onChange={(e) => setClock('focusTo', e.target.value)} />
        </Row>
      </Group>
    </Subpage>
  )
}
