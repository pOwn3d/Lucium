// The offscreen document of the tab capture probe: asks getUserMedia for the sound of a tab with an identifier the worker got from
// chrome.tabCapture.getMediaStreamId, and says what it received. The stream is read through an analyser and never played. It also says what happens to
// the requests for media that are not the sound of a tab ('native'): Electron 45 stops on one made from an offscreen document, so Lucium refuses each of them.
let stream = null
let context = null
let analyser = null
let ended = false

const level = () => {
  const data = new Float32Array(analyser.fftSize)
  analyser.getFloatTimeDomainData(data)
  return data.reduce((peak, value) => Math.max(peak, Math.abs(value)), 0)
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const say = (error) => String((error && error.name) + ': ' + (error && error.message))

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (!message || message.target !== 'offscreen') return false
  ;(async () => {
    if (message.type === 'listen') {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: message.id } } })
        ended = false
        for (const track of stream.getAudioTracks()) track.addEventListener('ended', () => void (ended = true))
        context = new AudioContext()
        analyser = context.createAnalyser()
        context.createMediaStreamSource(stream).connect(analyser)
        reply({ ok: true, audio: stream.getAudioTracks().length, video: stream.getVideoTracks().length, states: stream.getAudioTracks().map((track) => ({ readyState: track.readyState, muted: track.muted })) })
      } catch (error) {
        reply({ ok: false, error: say(error) })
      }
    } else if (message.type === 'native') {
      const calls = {
        'getUserMedia audio': () => navigator.mediaDevices.getUserMedia({ audio: true }),
        'getUserMedia video': () => navigator.mediaDevices.getUserMedia({ video: true }),
        'getUserMedia desktop': () => navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'desktop' } } }),
        getDisplayMedia: () => navigator.mediaDevices.getDisplayMedia({ video: true })
      }
      const results = []
      for (const [call, run] of Object.entries(calls)) {
        try {
          const got = await run()
          for (const track of got.getTracks()) track.stop()
          results.push({ call, ok: true })
        } catch (error) {
          results.push({ call, ok: false, name: error && error.name, message: error && error.message })
        }
      }
      reply({ ok: true, results })
    } else if (message.type === 'peak') {
      let peak = 0
      for (const until = Date.now() + (message.ms || 1500); Date.now() < until; await wait(50)) if (analyser) peak = Math.max(peak, level())
      reply({ ok: true, peak, ended })
    } else if (message.type === 'state') {
      reply({ ok: true, ended, tracks: stream ? stream.getTracks().map((track) => track.kind + ':' + track.readyState) : [], states: stream ? stream.getAudioTracks().map((track) => ({ readyState: track.readyState, muted: track.muted })) : [] })
    } else if (message.type === 'release') {
      if (stream) for (const track of stream.getTracks()) track.stop()
      if (context) await context.close()
      stream = null
      context = null
      analyser = null
      reply({ ok: true })
    } else {
      reply({ ok: false, error: 'unknown message ' + message.type })
    }
  })()
  return true
})
