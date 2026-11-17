import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RESUME_FILE } from '@shared/download-resume'
import { PARALLEL_DOWNLOADS, applySingleStream, singleStreamActive, type CommandLineSwitches } from './single-stream'

const switches = (initial: Record<string, string> = {}): CommandLineSwitches & { values: Record<string, string>; appended: number } => {
  const state = { values: { ...initial }, appended: 0 }
  return {
    ...state,
    get values() {
      return state.values
    },
    get appended() {
      return state.appended
    },
    getSwitchValue: (name) => state.values[name] ?? '',
    appendSwitch: (name, value = '') => {
      state.values[name] = value
      state.appended++
    }
  }
}

describe('applySingleStream', () => {
  it('leaves Chromium alone when the file of records does not exist: one look, nothing else', () => {
    const looked: string[] = []
    const commandLine = switches()
    expect(applySingleStream({ userDataDir: '/data', exists: (path) => (looked.push(path), false), commandLine })).toBe(false)
    expect(looked).toEqual([join('/data', RESUME_FILE)])
    expect(commandLine.appended).toBe(0)
    expect(singleStreamActive()).toBe(false)
  })

  it('disables parallel downloads for the launch when the file exists', () => {
    const commandLine = switches()
    expect(applySingleStream({ userDataDir: '/data', exists: () => true, commandLine })).toBe(true)
    expect(commandLine.values['disable-features']).toBe(PARALLEL_DOWNLOADS)
    expect(singleStreamActive()).toBe(true)
  })

  it('keeps the features that were already disabled, and does not add the same one twice', () => {
    const commandLine = switches({ 'disable-features': 'SomethingElse' })
    applySingleStream({ userDataDir: '/data', exists: () => true, commandLine })
    expect(commandLine.values['disable-features']).toBe(`SomethingElse,${PARALLEL_DOWNLOADS}`)
    const already = switches({ 'disable-features': `${PARALLEL_DOWNLOADS},Other` })
    applySingleStream({ userDataDir: '/data', exists: () => true, commandLine: already })
    expect(already.appended).toBe(0)
  })

  it('is forced for the engine test, without the file', () => {
    const commandLine = switches()
    expect(applySingleStream({ userDataDir: '/data', exists: () => false, commandLine, force: true })).toBe(true)
    expect(commandLine.values['disable-features']).toBe(PARALLEL_DOWNLOADS)
  })

  it('forgets an earlier answer: the answer is the one of the last call', () => {
    applySingleStream({ userDataDir: '/data', exists: () => true, commandLine: switches() })
    expect(singleStreamActive()).toBe(true)
    applySingleStream({ userDataDir: '/data', exists: () => false, commandLine: switches() })
    expect(singleStreamActive()).toBe(false)
  })
})
