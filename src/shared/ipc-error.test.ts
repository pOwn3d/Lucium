import { describe, expect, it } from 'vitest'
import { setLanguage } from './i18n'
import { eraseFailureText } from './history-scope'
import { ipcErrorText } from './ipc-error'

describe('the text of an error that crossed IPC', () => {
  it('loses the prefix of the IPC layer, with or without the name of the error', () => {
    expect(ipcErrorText(new Error("Error invoking remote method 'lucium:passwords': Error: Le coffre est verrouillé."))).toBe('Le coffre est verrouillé.')
    expect(ipcErrorText(new Error("Error invoking remote method 'lucium:cookies': Le site est inconnu."))).toBe('Le site est inconnu.')
    expect(ipcErrorText(new Error("Error invoking remote method '': Error: x"))).toBe('x')
  })

  it('keeps a message that has no such prefix, and one that only quotes it further on', () => {
    expect(ipcErrorText(new Error('Le coffre est verrouillé.'))).toBe('Le coffre est verrouillé.')
    expect(ipcErrorText(new Error("Refusé : Error invoking remote method 'a': b"))).toBe("Refusé : Error invoking remote method 'a': b")
    expect(ipcErrorText(new Error("Error invoking remote method 'a': Error: Error invoking remote method 'b': c"))).toBe("Error invoking remote method 'b': c")
  })

  it('writes what is not an Error as text', () => {
    expect(ipcErrorText('refusé')).toBe('refusé')
    expect(ipcErrorText(undefined)).toBe('undefined')
    expect(ipcErrorText("Error invoking remote method 'a': Error: b")).toBe('b')
  })

  it('is what the Profiles pane reads, trimmed, bounded, and replaced by a sentence when nothing is left', () => {
    setLanguage('fr')
    expect(eraseFailureText(new Error("Error invoking remote method 'lucium:profiles': Error:  Profil ouvert. "))).toBe('Profil ouvert.')
    expect(eraseFailureText(new Error("Error invoking remote method 'lucium:profiles': Error: "))).toBe('L’effacement a échoué.')
    expect(eraseFailureText(new Error(`Error invoking remote method 'x': ${'a'.repeat(400)}`))).toBe(`${'a'.repeat(299)}…`)
  })
})
