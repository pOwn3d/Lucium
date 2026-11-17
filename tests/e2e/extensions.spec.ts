// An extension of the repository (compat/data-api-probe) loaded at launch: a page of 127.0.0.1 asks it to call an extension API
// (externally_connectable), and the answer says what the application lets it do.

import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchLucium, type Running } from './launch'
import { openTab, serveSite, setSettings, titledPage, type LocalSite } from './helpers'

let site: LocalSite
let running: Running

test.beforeAll(async () => {
  site = await serveSite({ '/a': titledPage('Page A') })
})

test.afterAll(async () => {
  await site.close()
})

test.beforeEach(async () => {
  running = await launchLucium([resolve(__dirname, '../../compat/data-api-probe')])
})

test.afterEach(async () => {
  await running.close()
})

test('extension-data-apis: an extension that asked for the history reads it while on; off, the call is refused', async () => {
  const id = await running.app.evaluate(({ session }) => {
    const profile = session.fromPartition('persist:profile-default') as unknown as { extensions?: { getAllExtensions(): Array<{ id: string; name: string }> }; getAllExtensions?: () => Array<{ id: string; name: string }> }
    const all = profile.extensions?.getAllExtensions() ?? profile.getAllExtensions?.() ?? []
    return all.find((extension) => extension.name === 'Lucium Data API Probe')?.id ?? ''
  })
  expect(id, 'the Data API Probe is loaded').not.toBe('')
  const reader = await openTab(running, `${site.origin}/a`, 'Page A')
  const call = () =>
    reader.page.evaluate(
      (extension) =>
        new Promise<{ ok: boolean; error?: string }>((done) => {
          const runtime = (globalThis as unknown as { chrome: { runtime: { sendMessage(id: string, message: unknown, reply: (answer: unknown) => void): void } } }).chrome.runtime
          runtime.sendMessage(extension, { type: 'call', path: 'history.search', args: [{ text: '' }] }, (answer) => done((answer ?? { ok: false, error: 'no answer' }) as { ok: boolean; error?: string }))
        }),
      id
    )
  await setSettings(running.page, { extensionDataApis: true })
  await expect.poll(async () => (await call()).ok).toBe(true)
  await setSettings(running.page, { extensionDataApis: false })
  const refused = await call()
  expect(refused.ok).toBe(false)
  expect(refused.error ?? '').toContain('switched off')
})
