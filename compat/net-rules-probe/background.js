// A driver for the engine test (`smokeProbesExt`): a local page hands the worker the declarativeNetRequest rules to install, has it make a request of
// its own, and reads back what its chrome.webRequest listeners heard. Every rule and every listener is about the paths under /lucium-np/ of the test's own server.
const EVENTS = ['onBeforeRequest', 'onBeforeSendHeaders', 'onSendHeaders', 'onHeadersReceived', 'onAuthRequired', 'onBeforeRedirect', 'onResponseStarted', 'onCompleted', 'onErrorOccurred']
const heard = []

for (const event of EVENTS) {
  try {
    chrome.webRequest[event].addListener(
      (details) => {
        if (String(details.url).includes('/lucium-np/')) heard.push({ event, url: details.url })
      },
      { urls: ['<all_urls>'] }
    )
  } catch (error) {
    // A listener the engine refuses is an answer too: the test reads it with the events.
    heard.push({ event, failed: String(error?.message ?? error) })
  }
}

const said = (promise) =>
  promise.then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error: String(error?.message ?? error) })
  )

async function install(session, dynamic) {
  const dnr = chrome.declarativeNetRequest
  const oldSession = await said(dnr.getSessionRules())
  const oldDynamic = await said(dnr.getDynamicRules())
  const setSession = await said(dnr.updateSessionRules({ removeRuleIds: (oldSession.value ?? []).map((rule) => rule.id), addRules: session }))
  const setDynamic = await said(dnr.updateDynamicRules({ removeRuleIds: (oldDynamic.value ?? []).map((rule) => rule.id), addRules: dynamic }))
  const nowSession = await said(dnr.getSessionRules())
  const nowDynamic = await said(dnr.getDynamicRules())
  const rulesets = await said(dnr.getEnabledRulesets())
  return {
    setSession: setSession.ok ? 'ok' : setSession.error,
    setDynamic: setDynamic.ok ? 'ok' : setDynamic.error,
    session: nowSession.ok ? nowSession.value.length : nowSession.error,
    dynamic: nowDynamic.ok ? nowDynamic.value.length : nowDynamic.error,
    rulesets: rulesets.ok ? rulesets.value : rulesets.error
  }
}

chrome.runtime.onMessageExternal.addListener((message, _sender, reply) => {
  if (message?.type === 'ping') {
    reply({ ok: true })
    return
  }
  if (message?.type === 'heard') {
    reply(heard.splice(0))
    return
  }
  if (message?.type === 'fetch') {
    // A request of the worker itself: the rules of an extension cover its own requests too.
    fetch(message.url, { cache: 'no-store' }).then(
      async (response) => reply({ ok: true, body: await response.text() }),
      (error) => reply({ ok: false, error: String(error?.message ?? error) })
    )
    return true
  }
  if (message?.type === 'install') {
    install(message.session ?? [], message.dynamic ?? []).then(reply, (error) => reply({ fatal: String(error?.message ?? error) }))
    return true
  }
})
