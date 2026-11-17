// The answers a tab was given without « Se souvenir pour ce site » (tab-answers.ts): held for one tab and one site, gone with the page.

import { describe, expect, it } from 'vitest'
import { TabAnswers } from './tab-answers'

const SITE = 'https://site.example'
const OTHER = 'https://other.example'

describe('the answers given to a tab without « Se souvenir »', () => {
  it('holds an answer for the tab and the site that asked, and for the permission asked', () => {
    const answers = new TabAnswers<object>()
    const session = {}
    answers.note(1, session, SITE, 'notifications', 'allow')
    expect(answers.of(1, SITE, 'notifications')).toBe('allow')
    expect(answers.of(1, SITE, 'geolocation')).toBeUndefined()
    // Nothing for another site in the same tab, nor for the same site in another tab.
    expect(answers.of(1, OTHER, 'notifications')).toBeUndefined()
    expect(answers.of(2, SITE, 'notifications')).toBeUndefined()
  })

  it('keeps the last answer, a refusal as well as an agreement', () => {
    const answers = new TabAnswers<object>()
    const session = {}
    answers.note(1, session, SITE, 'notifications', 'deny')
    expect(answers.of(1, SITE, 'notifications')).toBe('deny')
    answers.note(1, session, SITE, 'notifications', 'allow')
    expect(answers.of(1, SITE, 'notifications')).toBe('allow')
  })

  it('says when a tab holds its first answer, so that the tab is watched once', () => {
    const answers = new TabAnswers<object>()
    const session = {}
    expect(answers.note(1, session, SITE, 'notifications', 'allow')).toBe(true)
    expect(answers.note(1, session, SITE, 'geolocation', 'deny')).toBe(false)
    expect(answers.note(2, session, SITE, 'notifications', 'allow')).toBe(true)
  })

  it('answers a check that names no tab from the tabs of the same session that were allowed, never from a refusal or from another session', () => {
    const answers = new TabAnswers<object>()
    const session = {}
    const privateSession = {}
    answers.note(1, session, SITE, 'notifications', 'allow')
    answers.note(2, session, OTHER, 'notifications', 'deny')
    expect(answers.allowedIn(session, SITE, 'notifications')).toBe(true)
    expect(answers.allowedIn(session, OTHER, 'notifications')).toBe(false)
    expect(answers.allowedIn(session, SITE, 'geolocation')).toBe(false)
    expect(answers.allowedIn(privateSession, SITE, 'notifications')).toBe(false)
  })

  it('forgets everything a tab was answered when its page goes', () => {
    const answers = new TabAnswers<object>()
    const session = {}
    answers.note(1, session, SITE, 'notifications', 'allow')
    answers.note(2, session, SITE, 'notifications', 'allow')
    answers.forget(1)
    expect(answers.of(1, SITE, 'notifications')).toBeUndefined()
    expect(answers.of(2, SITE, 'notifications')).toBe('allow')
    answers.forget(2)
    expect(answers.allowedIn(session, SITE, 'notifications')).toBe(false)
  })
})
