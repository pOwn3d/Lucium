import { expect, test } from '@playwright/test'
import { launchLucium, TEST_DOMAIN, type Running } from './launch'

let running: Running

test.beforeEach(async () => {
  running = await launchLucium()
})

test.afterEach(async () => {
  await running.close()
})

test('the application opens its sidebar with a page', async () => {
  await expect(running.page.locator('.sidebar')).toBeVisible()
})

// The tests reach nothing outside this machine (launch.ts `HOST_RULES`): the application under test resolves the names of the tests and this
// machine, and no other. Asked of Chromium's own resolver, the one every request of the application goes through. With the rule in force the
// outside name is refused without a question to the DNS; `example.com` is a name kept for documentation, so a rule that failed would ask for
// nothing else.
test('the application under test resolves the names of the tests, and no name of the Internet', async () => {
  const resolve = (host: string) =>
    running.app.evaluate(
      ({ session }, name) =>
        session.defaultSession.resolveHost(name).then(
          (found) => found.endpoints.map((endpoint) => endpoint.address).join(','),
          (error: unknown) => `refused: ${(error as Error).message}`
        ),
      host
    )
  expect(await resolve(`site.${TEST_DOMAIN}`)).toContain('127.0.0.1')
  expect(await resolve('127.0.0.1')).toContain('127.0.0.1')
  expect(await resolve('example.com')).toMatch(/^refused: .*ERR_NAME_NOT_RESOLVED/)
})

// The blocker downloads no list under the tests (LUCIUM_E2E=1, src/main/blocking/index.ts): the variable the launcher sets reaches the application.
test('the application under test knows it runs under the end-to-end tests', async () => {
  expect(await running.app.evaluate(() => process.env['LUCIUM_E2E'])).toBe('1')
})

// The sandbox of Chromium is on under the tests, as for a user. Playwright adds `--no-sandbox` to a launch of Electron on Linux unless `chromiumSandbox` is set
// (launch.ts); without the sandbox no renderer runs a preload script in a service worker, so no extension worker has the shims and the tests of extensions
// fail there. Read from the command line of the application itself.
test('the application under test runs with the sandbox of Chromium', async () => {
  expect(await running.app.evaluate(({ app }) => app.commandLine.hasSwitch('no-sandbox'))).toBe(false)
})
