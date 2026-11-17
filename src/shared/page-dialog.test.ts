import { describe, expect, it, vi } from 'vitest'
import {
  DIALOG_HURRY_MS,
  DIALOG_NATIVE,
  DialogGuard,
  PAGE_DIALOG,
  PROMPT_CANCELLED,
  PROMPT_MESSAGE_MAX,
  PROMPT_STOPPED,
  PROMPT_VALUE_MAX,
  PROMPT_WIRE_MAX,
  answerReplyOf,
  bridgedDialogsOf,
  dialogPayloadOf,
  isDialogNative,
  isPromptStopped,
  judgeDialog,
  pageResultOf,
  parseDialogPayload,
  parsePromptAnswer,
  parsePromptPayload,
  promptHostOf,
  promptMessageOf,
  promptPayloadOf,
  promptTitle,
  refusalReplyOf,
  replyOnce,
  withoutBoxReplyOf,
  type PageDialogKind
} from './page-dialog'
import { frenchSpaces } from './french-typography'
import { setLanguage } from './i18n'

const judgePrompt = (raw: unknown, frameUrl: string, guard: DialogGuard, now: number) => judgeDialog('prompt', raw, frameUrl, guard, now)

describe('promptPayloadOf', () => {
  it('keeps what a page gave, and bounds it so that no message is of any size', () => {
    expect(promptPayloadOf(frenchSpaces('Nom ?'), 'Alice')).toEqual({ message: frenchSpaces('Nom ?'), defaultValue: 'Alice' })
    const huge = promptPayloadOf('m'.repeat(PROMPT_WIRE_MAX + 50), 'd'.repeat(PROMPT_WIRE_MAX + 50))
    expect(huge.message).toHaveLength(PROMPT_WIRE_MAX)
    expect(huge.defaultValue).toHaveLength(PROMPT_WIRE_MAX)
  })

  it('never cuts a pair of surrogates in two', () => {
    const cut = promptPayloadOf('a'.repeat(PROMPT_WIRE_MAX - 1) + '😀', '').message
    expect(cut).toBe('a'.repeat(PROMPT_WIRE_MAX - 1))
  })
})

describe('parsePromptPayload', () => {
  it('accepts exactly the two strings of the bridge', () => {
    expect(parsePromptPayload({ message: frenchSpaces('Mot de passe ?'), defaultValue: '' })).toEqual({ message: frenchSpaces('Mot de passe ?'), defaultValue: '' })
  })

  it('refuses anything that is not that shape', () => {
    for (const bad of [null, undefined, 'x', 3, [], ['message', 'defaultValue'], {}, { message: 'x' }, { defaultValue: 'x' }, { message: 1, defaultValue: '' }, { message: '', defaultValue: null }]) {
      expect(parsePromptPayload(bad)).toBeNull()
    }
  })

  it('refuses a field the bridge does not send (a page cannot add a host, a flag or a title of its own)', () => {
    expect(parsePromptPayload({ message: 'x', defaultValue: '', host: 'bank.example' })).toBeNull()
    expect(parsePromptPayload({ message: 'x', defaultValue: '', offerSuppress: false })).toBeNull()
    expect(parsePromptPayload({ message: 'x', other: '' })).toBeNull()
  })

  it('refuses a string longer than the bridge ever sends', () => {
    expect(parsePromptPayload({ message: 'm'.repeat(PROMPT_WIRE_MAX), defaultValue: '' })).not.toBeNull()
    expect(parsePromptPayload({ message: 'm'.repeat(PROMPT_WIRE_MAX + 1), defaultValue: '' })).toBeNull()
    expect(parsePromptPayload({ message: '', defaultValue: 'd'.repeat(PROMPT_WIRE_MAX + 1) })).toBeNull()
  })
})

describe('promptMessageOf', () => {
  it('shows plain text: markup is not read, line breaks are kept', () => {
    expect(promptMessageOf('<img src=x onerror=alert(1)> <b>gras</b>\nligne 2')).toBe('<img src=x onerror=alert(1)> <b>gras</b>\nligne 2')
    expect(promptMessageOf('a\r\nb\rc\u2028d\u2029e')).toBe('a\nb\nc\nd\ne')
  })

  it('cuts a long message at the limit and says so', () => {
    expect(promptMessageOf('a'.repeat(PROMPT_MESSAGE_MAX))).toBe('a'.repeat(PROMPT_MESSAGE_MAX))
    const cut = promptMessageOf('a'.repeat(PROMPT_MESSAGE_MAX + 1))
    expect(cut).toBe(`${'a'.repeat(PROMPT_MESSAGE_MAX)}…`)
    expect(cut.length).toBeLessThanOrEqual(PROMPT_MESSAGE_MAX + 1)
  })

  it('does not cut a pair of surrogates in two', () => {
    const cut = promptMessageOf('a'.repeat(PROMPT_MESSAGE_MAX - 1) + '😀😀')
    expect(cut).toBe(`${'a'.repeat(PROMPT_MESSAGE_MAX - 1)}…`)
  })

  it('drops the controls and the characters that reverse the text, but keeps the tab and the accents', () => {
    expect(promptMessageOf('a\u0000b\u0007c\u001bd\u007fe\u0085f')).toBe('abcdef')
    expect(promptMessageOf('pay \u202eevil.com\u202c\u2066x\u2069 \u200f\u061c!')).toBe('pay evil.comx !')
    expect(promptMessageOf('Entrez l’identifiant :\tétoile')).toBe('Entrez l’identifiant :\tétoile')
  })

  it('cuts what is shown, not what was sent: invisible characters do not use up the limit', () => {
    expect(promptMessageOf('\u202e'.repeat(5000) + 'fin')).toBe('fin')
  })
})

describe('promptHostOf', () => {
  it('is the host of the page, with the port when it is not the usual one', () => {
    expect(promptHostOf('https://site.example/sync')).toBe('site.example')
    expect(promptHostOf('https://site.example:443/')).toBe('site.example')
    expect(promptHostOf('http://127.0.0.1:8080/a?b#c')).toBe('127.0.0.1:8080')
    expect(promptHostOf('http://[::1]:3000/')).toBe('[::1]:3000')
  })

  it('is the host the browser reads, not what a link seems to say', () => {
    expect(promptHostOf('https://bank.example@evil.example/')).toBe('evil.example')
    expect(promptHostOf('https://user:secret@evil.example/')).toBe('evil.example')
    expect(promptHostOf('https://bücher.example/')).toBe('xn--bcher-kva.example')
  })

  it('names a local file as what it is', () => {
    expect(promptHostOf('file:///Users/x/page.html')).toBe('Ce fichier local')
  })

  it('refuses the pages that are not a page of the web: interface, extension, blank, data, script, nonsense', () => {
    for (const url of ['chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html', 'about:blank', 'data:text/html,hi', 'javascript:alert(1)', 'blob:https://a.example/uuid', 'lucium://settings', 'chrome-error://chromewebdata/', '', 'not a url', 'https://']) {
      expect(promptHostOf(url), url).toBeNull()
    }
  })
})

describe('promptTitle', () => {
  it('puts the host first, in full', () => {
    expect(promptTitle('site.example')).toBe(frenchSpaces('site.example demande :'))
  })

  it('says that the site tells, not asks, for alert() and confirm()', () => {
    expect(promptTitle('site.example', 'prompt')).toBe(frenchSpaces('site.example demande :'))
    expect(promptTitle('site.example', 'alert')).toBe(frenchSpaces('site.example indique :'))
    expect(promptTitle('site.example', 'confirm')).toBe(frenchSpaces('site.example indique :'))
    setLanguage('en')
    try {
      expect(promptTitle('site.example', 'confirm')).toBe('site.example says:')
      expect(promptTitle('site.example')).toBe('site.example asks:')
    } finally {
      setLanguage('fr')
    }
  })
})

describe('DialogGuard', () => {
  it('shows the first boxes without the box to stop the page', () => {
    const guard = new DialogGuard()
    expect(guard.admit(1000)).toEqual({ show: true, offerSuppress: false })
    guard.closed(1500)
    expect(guard.admit(2000)).toEqual({ show: true, offerSuppress: false })
  })

  it('offers to stop a page from the third box of a series opened right after each other', () => {
    const guard = new DialogGuard()
    let now = 1000
    const offers: boolean[] = []
    for (let i = 0; i < 5; i++) {
      const admission = guard.admit(now)
      offers.push(admission.show && admission.offerSuppress)
      guard.closed(now + 800)
      now += 800 + 1000
    }
    expect(offers).toEqual([false, false, true, true, true])
  })

  it('counts from the closing of a box, so a user who takes a minute to read is not hurried', () => {
    const guard = new DialogGuard()
    for (let i = 0; i < 6; i++) {
      const start = 1000 + i * 70_000
      expect(guard.admit(start)).toEqual({ show: true, offerSuppress: false })
      guard.closed(start + 60_000)
    }
  })

  it('starts the series again when the page waits longer than the hurry delay', () => {
    const guard = new DialogGuard()
    guard.admit(0)
    guard.closed(100)
    guard.admit(200)
    guard.closed(300)
    expect(guard.admit(400)).toEqual({ show: true, offerSuppress: true })
    guard.closed(500)
    expect(guard.admit(500 + DIALOG_HURRY_MS)).toEqual({ show: true, offerSuppress: true })
    guard.closed(500 + DIALOG_HURRY_MS)
    expect(guard.admit(500 + DIALOG_HURRY_MS * 2 + 1)).toEqual({ show: true, offerSuppress: false })
  })

  it('refuses every box of the document once the user stopped the page', () => {
    const guard = new DialogGuard()
    guard.suppress()
    expect(guard.isSuppressed()).toBe(true)
    expect(guard.admit(10)).toEqual({ show: false })
    expect(guard.admit(10_000_000)).toEqual({ show: false })
  })

  it('forgets everything for a new document', () => {
    const guard = new DialogGuard()
    guard.admit(0)
    guard.closed(10)
    guard.admit(20)
    guard.closed(30)
    guard.suppress()
    guard.reset()
    expect(guard.isSuppressed()).toBe(false)
    expect(guard.admit(40)).toEqual({ show: true, offerSuppress: false })
  })

  it('does not count a clock that went backwards as a hurry', () => {
    const guard = new DialogGuard()
    guard.admit(5000)
    guard.closed(5000)
    guard.admit(1000)
    guard.closed(1000)
    expect(guard.admit(900)).toEqual({ show: true, offerSuppress: false })
  })
})

describe('judgeDialog, for prompt()', () => {
  const page = 'https://site.example/app'
  const call = { message: frenchSpaces('Mot de passe maître ?'), defaultValue: 'x' }

  it('asks the user, with the host of the page and the text of the call', () => {
    expect(judgePrompt(call, page, new DialogGuard(), 0)).toEqual({ kind: 'ask', request: { kind: 'prompt', host: 'site.example', message: frenchSpaces('Mot de passe maître ?'), defaultValue: 'x', offerSuppress: false } })
  })

  it('shows bounded text: the message is cut, the default value too', () => {
    const verdict = judgePrompt({ message: 'm'.repeat(5000), defaultValue: 'd'.repeat(PROMPT_VALUE_MAX + 100) }, page, new DialogGuard(), 0)
    expect(verdict.kind).toBe('ask')
    if (verdict.kind !== 'ask') return
    expect(verdict.request.message).toBe(`${'m'.repeat(PROMPT_MESSAGE_MAX)}…`)
    expect(verdict.request.defaultValue).toHaveLength(PROMPT_VALUE_MAX)
  })

  it('refuses a call that is not from the bridge, without using up the guard', () => {
    const guard = new DialogGuard()
    for (let i = 0; i < 4; i++) expect(judgePrompt({ message: 1 }, page, guard, i)).toEqual({ kind: 'refuse', why: 'payload' })
    expect(judgePrompt(call, page, guard, 10)).toMatchObject({ kind: 'ask', request: { offerSuppress: false } })
  })

  it('refuses a page that is not a page of the web, and says why', () => {
    expect(judgePrompt(call, 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/p.html', new DialogGuard(), 0)).toEqual({ kind: 'refuse', why: 'origin' })
    expect(judgePrompt(call, '', new DialogGuard(), 0)).toEqual({ kind: 'refuse', why: 'origin' })
  })

  it('looks at the shape of the call before the page, and at both before the guard', () => {
    const guard = new DialogGuard()
    guard.suppress()
    expect(judgePrompt({ nope: true }, 'about:blank', guard, 0)).toEqual({ kind: 'refuse', why: 'payload' })
    expect(judgePrompt(call, 'about:blank', guard, 0)).toEqual({ kind: 'refuse', why: 'origin' })
    expect(judgePrompt(call, page, guard, 0)).toEqual({ kind: 'refuse', why: 'suppressed' })
  })

  it('offers the box to stop the page to a page that keeps asking, and says nothing once it is ticked', () => {
    const guard = new DialogGuard()
    const offers: boolean[] = []
    for (let i = 0; i < 3; i++) {
      const verdict = judgePrompt(call, page, guard, i * 1000)
      offers.push(verdict.kind === 'ask' && verdict.request.offerSuppress)
      guard.closed(i * 1000 + 200)
    }
    expect(offers).toEqual([false, false, true])
    guard.suppress()
    expect(judgePrompt(call, page, guard, 4000)).toEqual({ kind: 'refuse', why: 'suppressed' })
  })

  it('takes the host from the address of the frame, never from the call', () => {
    const verdict = judgePrompt({ message: 'bank.example demande :', defaultValue: '' }, 'https://evil.example/', new DialogGuard(), 0)
    expect(verdict).toMatchObject({ kind: 'ask', request: { host: 'evil.example' } })
  })
})

describe('parsePromptAnswer', () => {
  it('reads a value and the state of the box, or a cancel', () => {
    expect(parsePromptAnswer({ value: 'abc', suppress: false })).toEqual({ value: 'abc', suppress: false })
    expect(parsePromptAnswer({ value: '', suppress: true })).toEqual({ value: '', suppress: true })
    expect(parsePromptAnswer({ value: null, suppress: false })).toEqual({ value: null, suppress: false })
  })

  it('refuses everything else, so that the caller can read it as a cancel', () => {
    for (const bad of [null, undefined, 'abc', 4, [], {}, { value: 'a' }, { suppress: false }, { value: 3, suppress: false }, { value: 'a', suppress: 'yes' }, { value: undefined, suppress: false }, { value: 'v'.repeat(PROMPT_VALUE_MAX + 1), suppress: false }]) {
      expect(parsePromptAnswer(bad)).toBeNull()
    }
    expect(parsePromptAnswer({ value: 'v'.repeat(PROMPT_VALUE_MAX), suppress: false })).not.toBeNull()
  })

  it('has a cancel that nobody can change', () => {
    expect(PROMPT_CANCELLED).toEqual({ value: null, suppress: false })
    expect(Object.isFrozen(PROMPT_CANCELLED)).toBe(true)
  })
})

describe('replyOnce', () => {
  it('sends the first reply and ignores the next ones', () => {
    const send = vi.fn()
    const reply = replyOnce<string | null>(send, () => {})
    expect(reply('a')).toBe(true)
    expect(reply(null)).toBe(false)
    expect(reply('b')).toBe(false)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('a')
  })

  it('does not throw when the page is gone, and reports it', () => {
    const failure = new Error('the frame was destroyed')
    const onError = vi.fn()
    const reply = replyOnce<string | null>(() => {
      throw failure
    }, onError)
    expect(() => reply('a')).not.toThrow()
    expect(onError).toHaveBeenCalledWith(failure)
    // The page got no answer from that reply; a second one does not try again.
    expect(reply('b')).toBe(false)
    expect(onError).toHaveBeenCalledTimes(1)
  })
})

describe('the channels', () => {
  it('are one per function, none shared', () => {
    expect(new Set(Object.values(PAGE_DIALOG)).size).toBe(3)
    expect(Object.keys(PAGE_DIALOG).sort()).toEqual(['alert', 'confirm', 'prompt'])
  })
})

describe('dialogPayloadOf and parseDialogPayload, for alert() and confirm()', () => {
  it('send and read the message alone, bounded', () => {
    for (const kind of ['alert', 'confirm'] as const) {
      expect(dialogPayloadOf(kind, 'Supprimer ?', 'ignoré')).toEqual({ message: 'Supprimer ?' })
      expect(parseDialogPayload(kind, dialogPayloadOf(kind, 'Supprimer ?', ''))).toEqual({ message: 'Supprimer ?', defaultValue: '' })
      expect((dialogPayloadOf(kind, 'm'.repeat(PROMPT_WIRE_MAX * 2), '') as { message: string }).message).toHaveLength(PROMPT_WIRE_MAX)
    }
    expect(dialogPayloadOf('prompt', 'Nom ?', 'Alice')).toEqual({ message: 'Nom ?', defaultValue: 'Alice' })
  })

  it('refuse anything but exactly the message: the shape of prompt(), a field of the page, a string longer than the bridge sends', () => {
    for (const kind of ['alert', 'confirm'] as const) {
      for (const bad of [null, 'x', [], {}, { message: 1 }, { message: 'x', defaultValue: '' }, { message: 'x', host: 'bank.example' }, { text: 'x' }, { message: 'm'.repeat(PROMPT_WIRE_MAX + 1) }]) {
        expect(parseDialogPayload(kind, bad), JSON.stringify(bad)?.slice(0, 60)).toBeNull()
      }
      expect(parseDialogPayload(kind, { message: 'm'.repeat(PROMPT_WIRE_MAX) })).not.toBeNull()
    }
    // The channel of prompt() reads the two strings of prompt(), and nothing else.
    expect(parseDialogPayload('prompt', { message: 'x' })).toBeNull()
    expect(parseDialogPayload('prompt', { message: 'x', defaultValue: 'y' })).toEqual({ message: 'x', defaultValue: 'y' })
  })
})

describe('judgeDialog, for alert() and confirm()', () => {
  const page = 'https://boutique.example/panier'

  it('asks the user with the host of the page, the message of the call, and no field', () => {
    for (const kind of ['alert', 'confirm'] as const) {
      expect(judgeDialog(kind, { message: 'Vider le panier ?' }, page, new DialogGuard(), 0)).toEqual({
        kind: 'ask',
        request: { kind, host: 'boutique.example', message: 'Vider le panier ?', defaultValue: '', offerSuppress: false }
      })
    }
  })

  it('names a local file as what it is, and refuses what is not a page of the web', () => {
    expect(judgeDialog('alert', { message: 'x' }, 'file:///Users/x/essai.html', new DialogGuard(), 0)).toMatchObject({ kind: 'ask', request: { host: 'Ce fichier local' } })
    expect(judgeDialog('confirm', { message: 'x' }, 'about:blank', new DialogGuard(), 0)).toEqual({ kind: 'refuse', why: 'origin' })
    expect(judgeDialog('alert', { message: 'x', defaultValue: '' }, page, new DialogGuard(), 0)).toEqual({ kind: 'refuse', why: 'payload' })
  })

  it('cleans and cuts the message as for prompt(), and takes the host from the frame, never from the text', () => {
    const verdict = judgeDialog('confirm', { message: 'bank.example indique :\u202e' + 'x'.repeat(5000) }, 'https://evil.example/', new DialogGuard(), 0)
    expect(verdict).toMatchObject({ kind: 'ask', request: { host: 'evil.example' } })
    if (verdict.kind !== 'ask') return
    expect(verdict.request.message).not.toContain('\u202e')
    expect(verdict.request.message.endsWith('…')).toBe(true)
  })

  it('shares the guard of the document with prompt(): a page stopped from one function opens none of the three', () => {
    const guard = new DialogGuard()
    const offers: boolean[] = []
    const kinds: PageDialogKind[] = ['alert', 'confirm', 'prompt']
    kinds.forEach((kind, i) => {
      const verdict = judgeDialog(kind, kind === 'prompt' ? { message: '?', defaultValue: '' } : { message: '?' }, page, guard, i * 1000)
      offers.push(verdict.kind === 'ask' && verdict.request.offerSuppress)
      guard.closed(i * 1000 + 100)
    })
    // The third box in a row, whichever function opened the first two, offers to stop the page.
    expect(offers).toEqual([false, false, true])
    guard.suppress()
    expect(judgeDialog('alert', { message: '?' }, page, guard, 9000)).toEqual({ kind: 'refuse', why: 'suppressed' })
    expect(judgeDialog('confirm', { message: '?' }, page, guard, 9000)).toEqual({ kind: 'refuse', why: 'suppressed' })
  })
})

describe('what the page gets', () => {
  it('pageResultOf: nothing for alert(), true for confirm() only on OK, the text or null for prompt()', () => {
    for (const reply of [true, false, null, 'x', '', PROMPT_STOPPED, DIALOG_NATIVE]) expect(pageResultOf('alert', reply)).toBeUndefined()
    expect(pageResultOf('confirm', true)).toBe(true)
    for (const reply of [false, null, undefined, 'true', 1, {}, '', PROMPT_STOPPED, DIALOG_NATIVE]) expect(pageResultOf('confirm', reply), String(reply)).toBe(false)
    expect(pageResultOf('prompt', 'texte')).toBe('texte')
    expect(pageResultOf('prompt', '')).toBe('')
    for (const reply of [null, true, false, 3, PROMPT_STOPPED, DIALOG_NATIVE]) expect(pageResultOf('prompt', reply)).toBeNull()
  })

  it('answerReplyOf: OK is true and a cancel false for confirm(), and an empty answer is still OK', () => {
    expect(answerReplyOf('confirm', '')).toBe(true)
    expect(answerReplyOf('confirm', 'n’importe quoi')).toBe(true)
    expect(answerReplyOf('confirm', null)).toBe(false)
    expect(answerReplyOf('prompt', 'abc')).toBe('abc')
    expect(answerReplyOf('prompt', null)).toBeNull()
    expect(answerReplyOf('alert', '')).toBeNull()
    expect(answerReplyOf('alert', null)).toBeNull()
  })

  it('the page round trip: what the user answers is what the call returns', () => {
    expect(pageResultOf('confirm', answerReplyOf('confirm', ''))).toBe(true)
    expect(pageResultOf('confirm', answerReplyOf('confirm', null))).toBe(false)
    expect(pageResultOf('prompt', answerReplyOf('prompt', 'valeur'))).toBe('valeur')
    expect(pageResultOf('alert', answerReplyOf('alert', ''))).toBeUndefined()
  })

  it('a page without a box of ours keeps its own function: Electron’s sheet for alert() and confirm(), null for prompt()', () => {
    expect(withoutBoxReplyOf('alert')).toBe(DIALOG_NATIVE)
    expect(withoutBoxReplyOf('confirm')).toBe(DIALOG_NATIVE)
    expect(withoutBoxReplyOf('prompt')).toBeNull()
  })

  it('refusalReplyOf: a stopped page is told so whatever it calls, a page not of the web keeps its function, a forged message is a cancel', () => {
    for (const kind of ['alert', 'confirm', 'prompt'] as const) expect(refusalReplyOf(kind, 'suppressed')).toBe(PROMPT_STOPPED)
    expect(refusalReplyOf('alert', 'origin')).toBe(DIALOG_NATIVE)
    expect(refusalReplyOf('confirm', 'origin')).toBe(DIALOG_NATIVE)
    expect(refusalReplyOf('prompt', 'origin')).toBeNull()
    expect(refusalReplyOf('alert', 'payload')).toBeNull()
    expect(refusalReplyOf('confirm', 'payload')).toBe(false)
    expect(refusalReplyOf('prompt', 'payload')).toBeNull()
  })

  it('isDialogNative: only the object of the main process, never a text or a look-alike', () => {
    expect(isDialogNative(DIALOG_NATIVE)).toBe(true)
    expect(Object.isFrozen(DIALOG_NATIVE)).toBe(true)
    for (const reply of ['{"native":true}', 'native', { native: 'true' }, { native: 1 }, [true], null, true, PROMPT_STOPPED]) expect(isDialogNative(reply)).toBe(false)
    expect(isPromptStopped(DIALOG_NATIVE)).toBe(false)
  })
})

describe('bridgedDialogsOf', () => {
  it('replaces the three functions in a page of the web and in a local file', () => {
    expect(bridgedDialogsOf('https://site.example', 'https:')).toEqual(['alert', 'confirm', 'prompt'])
    expect(bridgedDialogsOf('http://127.0.0.1:8080', 'http:')).toEqual(['alert', 'confirm', 'prompt'])
    // Chromium gives a local file an opaque origin too: it is not sandboxed for that.
    expect(bridgedDialogsOf('null', 'file:')).toEqual(['alert', 'confirm', 'prompt'])
  })

  it('leaves alert() and confirm() to Chromium in a sandboxed page of the web (opaque origin), which decides on allow-modals itself', () => {
    expect(bridgedDialogsOf('null', 'https:')).toEqual(['prompt'])
    expect(bridgedDialogsOf('null', 'http:')).toEqual(['prompt'])
  })
})
