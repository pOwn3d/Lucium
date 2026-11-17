// « Régler en quelques questions » in the Settings window: its card on « Pour commencer », the flow it opens in the page (one question at a
// time, then « Ce qui va changer »), and the row a search finds for the complete configuration. The questions and what they write are in
// shared/settings-guide.ts; the flow is only mounted while it is open, so nothing of it runs or listens otherwise.

import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { SettingsPane } from '@shared/ipc'
import type { Settings } from '@shared/model'
import { t, tp } from '@shared/i18n'
import { settingsPaneLabel } from '@shared/settings-catalog'
import { GUIDE_QUESTIONS, answerOf, askedQuestions, checkedOf, guidePlan, guideQuestionsOf, profilesKeepingTheirOwn, stepForward, type GuideAnswers, type GuidePlan, type GuidePlanItem, type GuideRecord } from '@shared/settings-guide'
import './settings-guide.css'
import { settingsPath } from '@shared/settings-path'

export type GuideScope = SettingsPane | 'all'

/** "Le profil « Travail » garde son propre réglage", or nothing when no profile sets its own value. */
function ProfilesNote({ names, id }: { names: readonly string[]; id?: string }) {
  if (names.length === 0) return null
  const quoted = names.map((name) => t('guide.profil-nomme', { name })).join(', ')
  return (
    <p className="guide-note" id={id}>
      {t(names.length === 1 ? 'guide.un-profil-garde' : 'guide.des-profils-gardent', { names: quoted, settingsPath: settingsPath('profiles') })}
    </p>
  )
}

/**
 * The entry of the guide, on « Pour commencer » (its one entry: `pane` is `all`): how many questions it asks now; and the « Annuler » of the answers
 * applied last, while it still can be. For one category, it says on what too.
 */
export function GuideCard({ pane, settings, last, onStart, onUndo }: { pane: GuideScope; settings: Settings; last: GuideRecord | null; onStart: () => void; onUndo: () => void }) {
  const title = useId()
  const summary = useId()
  const questions = askedQuestions(guideQuestionsOf(pane), settings, {})
  if (questions.length === 0) return null
  const topics = questions.map((question) => t(question.topic)).join(', ')
  const said = pane === 'all' ? tp('guide.recherche-aide', questions.length) : t('guide.carte-resume', { questions: tp('guide.questions-count', questions.length), topics })
  return (
    <div className="guide-card" role="group" aria-labelledby={title}>
      <span className="guide-card-mark" aria-hidden="true" />
      <div className="guide-card-text">
        <b id={title}>{t('guide.titre')}</b>
        <span id={summary}>{said}</span>
        {last && (pane === 'all' || last.scope === pane || last.scope === 'all') && (
          <span className="guide-card-last">
            {tp('guide.derniere-fois', last.count)}{' '}
            <button type="button" className="link-button" title={t('guide.annuler-aide')} onClick={onUndo}>
              {t('settings.annuler')}
            </button>
          </span>
        )}
      </div>
      <button type="button" className="button primary guide-start" aria-describedby={summary} onClick={onStart}>
        {t('guide.commencer')}
      </button>
    </div>
  )
}

/**
 * The row a search of the Settings finds for « régler en quelques questions », « configuration rapide », « réglage guidé »: it starts the complete
 * configuration. Under the name of the page its one entry is on (« Pour commencer »), as any result is under its page.
 */
export function GuideSearchResult({ onStart }: { onStart: () => void }) {
  return (
    <div className="results-cat guide-result" data-category-label={settingsPaneLabel('home')}>
      <h3 className="results-cat-title">{settingsPaneLabel('home')}</h3>
      <div className="pref-group">
        <div className="pref-row two-lines" data-search="guidedSetup">
          <div className="pref-label">
            {t('guide.configuration-rapide')}
            <div className="pref-hint">{tp('guide.recherche-aide', GUIDE_QUESTIONS.length)}</div>
          </div>
          <div className="pref-control">
            <button type="button" className="button" onClick={onStart}>
              {t('guide.commencer')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** One question: its answers as radio buttons, the one the settings hold already checked, « conseillé » on one of them. */
function QuestionStep({ scope, settings, answers, at, onAnswer, onNext, onBack, onClose }: {
  scope: GuideScope
  settings: Settings
  answers: GuideAnswers
  at: number
  onAnswer: (questionId: string, answerId: string) => void
  onNext: () => void
  onBack: () => void
  onClose: () => void
}) {
  const asked = askedQuestions(guideQuestionsOf(scope), settings, answers)
  const question = asked[at]!
  const heading = useRef<HTMLHeadingElement>(null)
  const step = useId()
  const name = useId()
  const notes = useId()
  const held = answerOf(question, settings)
  const picked = checkedOf(question, settings, answers)
  const profiles = profilesKeepingTheirOwn(question, settings)
  // The lines under the question are read with it, as its description.
  const described = [question.hint ? `${notes}-hint` : '', held === null ? `${notes}-custom` : '', profiles.length > 0 ? `${notes}-profiles` : ''].filter(Boolean).join(' ')
  const last = at === asked.length - 1
  // Each question takes the focus: a screen reader reads it, and the arrows move between its answers.
  useEffect(() => heading.current?.focus(), [question.id])
  const submit = (e: FormEvent) => {
    e.preventDefault()
    onNext()
  }
  return (
    <form className="guide-step" onSubmit={submit}>
      <p className="guide-progress" id={step}>
        {scope === 'all' && <span className="guide-eyebrow">{settingsPaneLabel(question.pane)} · </span>}
        {t('guide.question-n-sur-total', { index: at + 1, total: asked.length })}
      </p>
      <div className="guide-bar" role="progressbar" aria-labelledby={step} aria-valuemin={1} aria-valuemax={asked.length} aria-valuenow={at + 1}>
        <span style={{ width: `${((at + 1) / asked.length) * 100}%` }} />
      </div>
      <fieldset className="guide-question" aria-describedby={described || undefined}>
        <legend>
          <h3 ref={heading} tabIndex={-1} className="guide-question-title">
            {t(question.title)}
          </h3>
        </legend>
        {question.hint && (
          <p className="guide-hint" id={`${notes}-hint`}>
            {t(question.hint)}
          </p>
        )}
        {held === null && (
          <p className="guide-note guide-custom" id={`${notes}-custom`}>
            {t('guide.personnalise')}
          </p>
        )}
        <ProfilesNote names={profiles} id={`${notes}-profiles`} />
        <div className="guide-answers">
          {question.answers.map((answer) => {
            const id = `${name}-${answer.id}`
            return (
              <label key={answer.id} className="guide-answer">
                <input type="radio" name={name} value={answer.id} checked={picked === answer.id} aria-labelledby={`${id}-label`} aria-describedby={`${id}-effect`} onChange={() => onAnswer(question.id, answer.id)} />
                <span className="guide-answer-text">
                  <span id={`${id}-label`} className="guide-answer-label">
                    {t(answer.label)}
                    {answer.recommended && <span className="guide-badge">{t('guide.conseille')}</span>}
                  </span>
                  <span id={`${id}-effect`} className="guide-answer-effect">
                    {t(answer.effect)}
                  </span>
                </span>
              </label>
            )
          })}
        </div>
      </fieldset>
      <div className="guide-nav">
        <button type="button" className="button" aria-label={t('guide.arreter-aide')} onClick={onClose}>
          {t('guide.arreter')}
        </button>
        <span className="guide-nav-end">
          <button type="button" className="button" disabled={at === 0} onClick={onBack}>
            {t('guide.precedent')}
          </button>
          <button type="submit" className="button primary">
            {last ? t('guide.voir-les-changements') : t('guide.suivant')}
          </button>
        </span>
      </div>
    </form>
  )
}

/** One answer that changes something: the question, then each setting, before → after, read by a screen reader as one sentence. */
function PlanItem({ item }: { item: GuidePlanItem }) {
  return (
    <li className="guide-item">
      <span className="guide-item-question">{t(item.question.title)}</span>
      <ul className="guide-changes">
        {item.changes.map((change) => (
          <li key={change.row} className="guide-change" data-row={change.row}>
            <span className="sr-only">{t('guide.changement-lu', { label: change.label, before: change.before, after: change.after })}</span>
            <span className="guide-change-label" aria-hidden="true">
              {change.label}
            </span>
            <span className="guide-old" aria-hidden="true">
              {change.before}
            </span>
            <span className="guide-arrow" aria-hidden="true">
              →
            </span>
            <span className="guide-new" aria-hidden="true">
              {change.after}
            </span>
          </li>
        ))}
      </ul>
      <ProfilesNote names={item.profiles} />
    </li>
  )
}

/** « Ce qui va changer »: the exact list, by category in the complete configuration, then « Appliquer ». */
function PlanStep({ scope, plan, onBack, onApply, onClose }: { scope: GuideScope; plan: GuidePlan; onBack: () => void; onApply: () => void; onClose: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => heading.current?.focus(), [])
  const panes = scope === 'all' ? [...new Set(plan.items.map((item) => item.question.pane))] : []
  return (
    <div className="guide-step guide-plan">
      <h3 ref={heading} tabIndex={-1} className="guide-question-title">
        {plan.count > 0 ? tp('guide.reglages-vont-changer', plan.count) : t('guide.ce-qui-va-changer')}
      </h3>
      {plan.count === 0 && <p className="guide-hint">{t('guide.rien-ne-change')}</p>}
      {scope === 'all'
        ? panes.map((pane) => (
            <section key={pane} className="guide-plan-pane" aria-label={settingsPaneLabel(pane)}>
              <h4>{settingsPaneLabel(pane)}</h4>
              <ul className="guide-items">
                {plan.items.filter((item) => item.question.pane === pane).map((item) => <PlanItem key={item.question.id} item={item} />)}
              </ul>
            </section>
          ))
        : plan.count > 0 && (
            <ul className="guide-items">
              {plan.items.map((item) => (
                <PlanItem key={item.question.id} item={item} />
              ))}
            </ul>
          )}
      {plan.count > 0 && <p className="guide-hint">{t('guide.autres-reglages-intacts')}</p>}
      <div className="guide-nav">
        <button type="button" className="button" onClick={onBack}>
          {t('guide.revoir-les-reponses')}
        </button>
        {plan.count > 0 ? (
          <button type="button" className="button primary" onClick={onApply}>
            {t('guide.appliquer')}
          </button>
        ) : (
          <button type="button" className="button primary" onClick={onClose}>
            {t('guide.fermer')}
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * The flow, in the pane: the questions of a category, or of every category for the complete configuration, then the list of what changes. Nothing
 * is written before « Appliquer »; Escape or « Arrêter » leaves it as it was.
 */
export function GuideFlow({ scope, settings, onApply, onClose, initialAt = 0, initialAnswers = {}, initialReview = false }: {
  scope: GuideScope
  settings: Settings
  onApply: (plan: GuidePlan) => void
  onClose: () => void
  /** Where the flow starts (a test draws a later step without clicking). */
  initialAt?: number
  initialAnswers?: GuideAnswers
  initialReview?: boolean
}) {
  const [answers, setAnswers] = useState<GuideAnswers>(initialAnswers)
  const [at, setAt] = useState(initialAt)
  const [review, setReview] = useState(initialReview)
  const questions = useMemo(() => guideQuestionsOf(scope), [scope])
  const asked = askedQuestions(questions, settings, answers)
  const current = asked[Math.min(at, asked.length - 1)]

  const next = () => {
    if (!current) return setReview(true)
    const step = stepForward(questions, settings, answers, current.id)
    setAnswers(step.answers)
    if (step.next === null) setReview(true)
    else setAt(step.next)
  }
  const back = () => {
    if (review) {
      setReview(false)
      setAt(asked.length - 1)
    } else setAt(Math.max(0, at - 1))
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return
    e.preventDefault()
    onClose()
  }

  return (
    <div className="guide-flow" onKeyDown={onKeyDown}>
      {scope === 'all' ? (
        <div className="guide-head">
          <h2 className="settings-pane-title" id="pane-heading">
            {t('guide.configuration-rapide')}
          </h2>
          <p className="settings-blurb">{t('guide.configuration-rapide-aide')}</p>
        </div>
      ) : (
        <p className="guide-flow-title">{t('guide.titre')}</p>
      )}
      {review || !current ? (
        <PlanStep scope={scope} plan={guidePlan(questions, settings, answers)} onBack={back} onApply={() => onApply(guidePlan(questions, settings, answers))} onClose={onClose} />
      ) : (
        <QuestionStep
          scope={scope}
          settings={settings}
          answers={answers}
          at={asked.indexOf(current)}
          onAnswer={(questionId, answerId) => setAnswers((previous) => ({ ...previous, [questionId]: answerId }))}
          onNext={next}
          onBack={back}
          onClose={onClose}
        />
      )}
    </div>
  )
}
