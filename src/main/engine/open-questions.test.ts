import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OpenQuestions, questionKey } from './open-questions'

/** A question whose answer the test gives. */
function sheet() {
  let answer!: (granted: boolean) => void
  let fail!: (error: Error) => void
  let shown = 0
  const put = (): Promise<boolean> => {
    shown++
    return new Promise<boolean>((resolve, reject) => {
      answer = resolve
      fail = reject
    })
  }
  return { put, answer: (granted: boolean) => answer(granted), fail: (error: Error) => fail(error), shown: () => shown }
}

describe('OpenQuestions', () => {
  it('shows one sheet for a page that asks the same thing in a loop, and gives every request its answer', async () => {
    const questions = new OpenQuestions()
    const one = sheet()
    const key = questionKey(7, 'https://meet.example', 'media')
    const requests = Array.from({ length: 50 }, () => questions.ask(key, one.put))
    expect(one.shown()).toBe(1)
    one.answer(true)
    expect(await Promise.all(requests)).toEqual(Array(50).fill(true))
  })

  it('asks again once the question was answered: nothing is remembered', async () => {
    const questions = new OpenQuestions()
    const one = sheet()
    const key = questionKey(7, 'https://meet.example', 'media')
    const first = questions.ask(key, one.put)
    one.answer(false)
    expect(await first).toBe(false)
    expect(questions.size).toBe(0)
    const second = questions.ask(key, one.put)
    expect(one.shown()).toBe(2)
    one.answer(true)
    expect(await second).toBe(true)
  })

  it('frees the key of a sheet that failed, and hands the failure to every request', async () => {
    const questions = new OpenQuestions()
    const one = sheet()
    const key = questionKey(7, 'https://meet.example', 'media')
    const requests = [questions.ask(key, one.put), questions.ask(key, one.put)]
    one.fail(new Error('no window'))
    for (const request of requests) await expect(request).rejects.toThrow('no window')
    expect(questions.size).toBe(0)
  })

  it('keeps apart another window, another site, another permission and another thing named', () => {
    const keys = [questionKey(7, 'https://a.example', 'media'), questionKey(8, 'https://a.example', 'media'), questionKey(7, 'https://b.example', 'media'), questionKey(7, 'https://a.example', 'geolocation'), questionKey(7, 'https://a.example', 'openExternal', 'zoommtg'), questionKey(7, 'https://a.example', 'openExternal', 'slack')]
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('is what the engine puts its sheets through', () => {
    const source = readFileSync(join(__dirname, 'electron-engine-permissions.ts'), 'utf8')
    expect(source).toMatch(/this\.sheets\.ask\(questionKey\(window\.id, origin, permission, detail\), \(\) => this\.showSheet\(/)
    // The box itself is opened in one place only.
    expect(source.match(/dialog\.showMessageBox\(/g)).toHaveLength(1)
  })
})
