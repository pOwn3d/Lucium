// `pnpm film:site`: the presentation film of the site, in French and in English, from the real captures of the application.
//
// The scenes are data (scripts/site-film/scenes.ts: durations, shots, texts in both languages). For each language and format, this script
// makes the plan of every scene (layout.ts: the capture of `out-captures/<lang>/<theme>/<shot>-no-shadow.png` when it exists, a screen
// recording of `videos/` when there is one, a neutral drawing otherwise), opens the montage page (montage/) in Chrome without a window, and
// renders it image by image: for each frame, the page is given its state (timeline.ts, frameState) and a picture is taken. The time is the
// frame's own, never the clock. Several pages share the frames; each one writes a lossless piece through ffmpeg; the pieces are joined, then
// encoded: MP4 H.264 (yuv420p, faststart) and WebM VP9 in 1920 × 1080, an MP4 in 1080 × 1080, the posters, the transcript and the WebVTT track.
// With --music the sound is mixed with a fade at both ends; without it the film is silent.
//
// Nothing here opens a window: Chrome runs headless, the application is never started. ffmpeg must be installed (Homebrew).
// The rules (timings, layouts, arguments of ffmpeg) are in scripts/site-film/*.ts, loaded with Node's type stripping and tested by vitest.
//
// Exit code: 0 done, 1 the render failed, 2 nothing could be done (the command line, a missing tool).

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync, readdirSync, rmSync, statSync, watch, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { chromium } from '@playwright/test'
import * as demo from '../site-captures/demo.ts'
import * as shots from '../site-captures/shots.ts'
import * as encode from './encode.ts'
import * as layout from './layout.ts'
import * as data from './scenes.ts'
import * as timing from './timeline.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const ICON_STILL = join(root, 'resources/app-icons/boreal.png')
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const VIDEO_EXTENSIONS = ['mov', 'mp4', 'webm', 'm4v']

const USAGE = `Usage : pnpm film:site [options]

Fabrique le film de présentation du site à partir des captures de l’application (pnpm captures:site), image par image, dans Chrome sans fenêtre.
Sorties dans out-film/ : lucium-<langue>.mp4 et .webm (1920 × 1080, 30 i/s), lucium-<langue>-carre.mp4 (1080 × 1080), les affiches (.jpg),
la transcription (.txt), la piste WebVTT (.vtt) et le journal du rendu (-journal.txt), qui liste les captures manquantes.

  --lang fr|en|all      langue du film (all par défaut : les deux)
  --from SCÈNE          commence à cette scène (numéro ou nom, voir --list) ou à ce moment (12.5s)
  --to SCÈNE            finit à la fin de cette scène, ou à ce moment
  --music FICHIER       mixe cette musique, avec un fondu au début et à la fin (sans elle, le film est muet)
  --captures DOSSIER    dossier des captures (out-captures par défaut, à la racine du dépôt)
  --out DOSSIER         dossier des sorties (out-film par défaut)
  --formats wide,square formats à rendre (les deux par défaut)
  --no-webm             ne fait pas la version WebM
  --placeholders        dessine toutes les prises en images d’attente, même celles qui existent
  --labels              écrit le nom de la prise sur les images d’attente
  --workers N           pages de rendu en parallèle (${defaultWorkers()} par défaut)
  --still SECONDES      rend une seule image à ce moment (PNG), pour vérifier un plan
  --page                écrit une page d’aperçu avec un curseur (out-film/apercu-<langue>/index.html), sans rien rendre
  --watch               refait le rendu quand les captures ou les scènes changent
  --keep                garde les morceaux sans perte (out-film/.cache)
  --list                affiche les scènes, les prises et les vidéos, et ce qui manque, sans rien rendre
  --help                cette aide`

function defaultWorkers() {
  return Math.max(1, Math.min(6, Math.floor(availableParallelism() / 2)))
}

class UsageError extends Error {}

function options(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      lang: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      music: { type: 'string' },
      captures: { type: 'string' },
      out: { type: 'string' },
      formats: { type: 'string' },
      'no-webm': { type: 'boolean' },
      placeholders: { type: 'boolean' },
      labels: { type: 'boolean' },
      workers: { type: 'string' },
      still: { type: 'string' },
      page: { type: 'boolean' },
      watch: { type: 'boolean' },
      keep: { type: 'boolean' },
      list: { type: 'boolean' },
      help: { type: 'boolean' }
    },
    strict: true
  })
  const workers = values.workers === undefined ? defaultWorkers() : Number(values.workers)
  if (!Number.isInteger(workers) || workers < 1 || workers > 16) throw new UsageError(`--workers : un entier de 1 à 16, pas « ${values.workers} »`)
  const still = values.still === undefined ? undefined : Number(values.still.replace(/s$/, ''))
  if (still !== undefined && !(still >= 0)) throw new UsageError(`--still : un nombre de secondes, pas « ${values.still} »`)
  if (values.music !== undefined && !existsSync(resolve(values.music))) throw new UsageError(`--music : fichier introuvable « ${values.music} »`)
  return {
    help: values.help === true,
    list: values.list === true,
    page: values.page === true,
    watch: values.watch === true,
    keep: values.keep === true,
    langs: timing.parseLangs(values.lang),
    from: values.from,
    to: values.to,
    music: values.music === undefined ? undefined : resolve(values.music),
    captures: resolve(values.captures ?? join(root, 'out-captures')),
    out: resolve(values.out ?? join(root, 'out-film')),
    formats: layout.parseFormats(values.formats),
    webm: values['no-webm'] !== true,
    placeholders: values.placeholders === true,
    labels: values.labels === true,
    workers,
    still
  }
}

// ---------- the images ----------

const SIZES = new Map([...shots.SHOTS.map((shot) => [shot.id, shot.size]), ...data.EXTRA_SHOTS.map((shot) => [shot.id, shot.size])])
const SPACE_COLOURS = Object.fromEntries(demo.SPACES.map((space) => [space.key, space.colors[0]]))
const SPACE_OF_SHOT = { 'space-switch': 'home', 'space-projects': 'projects' }
/** The colours of the demonstration that the neutral drawings use: the spaces, the favourites, the favicons of the tabs. */
const DEMO_COLOURS = {
  spaces: demo.SPACES.map((space) => space.colors[0]),
  favorites: demo.FAVORITES.map((key) => demo.pageDef(key).color),
  icons: [...new Set(demo.PAGES.map((page) => page.color))]
}

/** The width and height of a PNG, from its header. */
function pngSize(file) {
  const fd = openSync(file, 'r')
  try {
    const head = Buffer.alloc(24)
    readSync(fd, head, 0, 24, 0)
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) }
  } finally {
    closeSync(fd)
  }
}

function sourcesFor(opts, lang, notes) {
  const dir = (theme) => join(opts.captures, lang, theme)
  return {
    capture(shot, theme) {
      const flat = join(dir(theme), `${shot}-no-shadow.png`)
      if (existsSync(flat)) return flat
      // The image with the shadow of macOS has margins around the window: the places of the film would not fall where they should.
      if (existsSync(join(dir(theme), `${shot}.png`))) notes.add(`${lang}/${theme}/${shot} : seule l’image avec l’ombre existe (${shot}.png) ; il faut aussi ${shot}-no-shadow.png`)
      return undefined
    },
    clip(id, theme) {
      for (const ext of VIDEO_EXTENSIONS) {
        const file = join(dir(theme), 'videos', `${id}.${ext}`)
        if (existsSync(file)) return file
      }
      return undefined
    },
    size(shot) {
      return SIZES.get(shot) ?? shots.MAIN_SIZE
    },
    placeholder(shot) {
      return data.SHOT_PLACEHOLDERS[shot] ?? data.EXTRA_SHOTS.find((extra) => extra.id === shot)?.placeholder ?? 'main'
    },
    tint(shot) {
      return SPACE_COLOURS[SPACE_OF_SHOT[shot] ?? 'work']
    }
  }
}

/** A path for the messages: relative to the current folder when it is inside it, whole otherwise. */
function shown(path) {
  const rel = relative(process.cwd(), path)
  return rel === '' ? '.' : rel.startsWith('..') ? path : rel
}

function run(cmd, args, what) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.error) throw new Error(`${what} : ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${what} : ${cmd} a échoué (${result.status})\n${(result.stderr || '').trim().slice(-2000)}`)
  return result.stdout
}

/** The frames of a video for the page, in a folder of the cache, taken again only when the video changed. */
function videoFrames(video, cacheDir, size) {
  const stamp = join(cacheDir, 'source.txt')
  const { mtimeMs, size: bytes } = statSync(video)
  const mark = `${video}\n${mtimeMs}\n${bytes}\n${size}\n${timing.FPS}\n`
  if (!existsSync(stamp) || readFileSync(stamp, 'utf8') !== mark) {
    rmSync(cacheDir, { recursive: true, force: true })
    mkdirSync(cacheDir, { recursive: true })
    run('ffmpeg', encode.framesArgs(video, cacheDir, timing.FPS, size), `images de ${relative(root, video)}`)
    writeFileSync(stamp, mark)
  }
  const frames = readdirSync(cacheDir).filter((name) => name.endsWith('.jpg')).sort()
  if (frames.length === 0) throw new Error(`aucune image tirée de ${video}`)
  return frames.map((name) => pathToFileURL(join(cacheDir, name)).href)
}

/** The plan of the film for the page, in a language and a format, with what is missing and what to check. */
function filmPlan(opts, lang, formatName, report) {
  const format = layout.FORMATS[formatName]
  const notes = new Set()
  const sources = sourcesFor(opts, lang, notes)
  const cache = join(opts.out, '.cache')
  const plans = data.SCENES.map((spec) => layout.planScene(spec, lang, format, sources, data.HOTSPOTS, { placeholders: opts.placeholders }))
  for (const plan of plans) {
    for (const still of plan.stills) {
      const media = still.media
      if (media.kind === 'capture') {
        const pixels = pngSize(media.file)
        const density = pixels.width / media.width
        if (Math.abs(pixels.height / pixels.width - media.height / media.width) > 0.01) notes.add(`${media.shot} : l’image fait ${pixels.width} × ${pixels.height}, la prise est prévue en ${media.width} × ${media.height}`)
        if (plan.window && formatName === 'wide') {
          const scale = layout.largestScale(plan.window, plan.camera) / density
          if (scale > layout.MAX_SCALE + 1e-6) notes.add(`scène ${plan.number} : la caméra agrandit ${media.shot} ${scale.toFixed(2)} fois (au plus ${layout.MAX_SCALE})`)
        }
        media.url = pathToFileURL(media.file).href
      } else if (media.kind === 'clip') {
        media.frames = videoFrames(media.file, join(cache, 'clips', `${lang}-${media.theme}-${media.shot}`), Math.max(media.width, media.height))
      }
    }
    for (const tile of plan.tiles) if (tile.media.kind === 'capture') tile.media.url = pathToFileURL(tile.media.file).href
  }
  report.missing.push(...plans.flatMap((plan) => plan.missing))
  report.clips.push(...plans.flatMap((plan) => plan.clips.map((clip) => `scène ${plan.number} : vidéo ${clip}`)))
  for (const note of notes) report.notes.add(note)
  return {
    format,
    lang,
    fps: timing.FPS,
    labels: opts.labels,
    icon: { still: pathToFileURL(ICON_STILL).href },
    colors: DEMO_COLOURS,
    scenes: plans
  }
}

// ---------- the render ----------

async function launch() {
  const executablePath = existsSync(CHROME) ? CHROME : undefined
  // Headless: no window, no Dock icon. sRGB whatever the screen, so that the colours of the site come out as written.
  return chromium.launch({ executablePath, headless: true, args: ['--force-color-profile=srgb', '--hide-scrollbars', '--font-render-hinting=none'] })
}

async function openPage(browser, plan) {
  const page = await browser.newPage({ viewport: { width: plan.format.width, height: plan.format.height }, deviceScaleFactor: 1 })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(pathToFileURL(join(here, 'montage/index.html')).href)
  const loaded = await page.evaluate((p) => window.film.load(p), plan)
  if (errors.length) throw new Error(`la page de montage a une erreur : ${errors.join(' ; ')}`)
  if (loaded.failed.length) throw new Error(`images illisibles : ${loaded.failed.join(', ')}`)
  const cdp = await page.context().newCDPSession(page)
  return { page, cdp, errors }
}

async function shoot({ page, cdp }, state) {
  await page.evaluate((s) => window.film.frame(s), state)
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, captureBeyondViewport: false })
  return Buffer.from(shot.data, 'base64')
}

function writeTo(stream, buffer) {
  return new Promise((resolveWrite, reject) => {
    const ok = stream.write(buffer, (error) => (error ? reject(error) : undefined))
    if (ok) resolveWrite()
    else stream.once('drain', resolveWrite)
  })
}

/** One page renders a run of frames into a lossless piece. */
async function renderPiece(browser, plan, timeline, range, run, piece, progress) {
  const worker = await openPage(browser, plan)
  const ffmpeg = spawn('ffmpeg', encode.pieceArgs(piece, timing.FPS), { stdio: ['pipe', 'ignore', 'pipe'] })
  let stderr = ''
  ffmpeg.stderr.on('data', (chunk) => (stderr += chunk))
  const done = new Promise((resolveDone, reject) => {
    ffmpeg.on('error', reject)
    ffmpeg.on('close', (code) => (code === 0 ? resolveDone() : reject(new Error(`ffmpeg (morceau) : code ${code}\n${stderr.trim()}`))))
  })
  try {
    for (let frame = run.startFrame; frame < run.endFrame; frame++) {
      await writeTo(ffmpeg.stdin, await shoot(worker, timing.frameState(timeline, frame, range)))
      progress()
    }
  } finally {
    ffmpeg.stdin.end()
    await worker.page.close()
  }
  await done
  if (worker.errors.length) throw new Error(`la page de montage a une erreur : ${worker.errors.join(' ; ')}`)
}

async function renderFormat(browser, opts, plan, timeline, range, names, log) {
  const cache = join(opts.out, '.cache')
  mkdirSync(cache, { recursive: true })
  const runs = timing.splitFrames(range, opts.workers)
  const total = range.endFrame - range.startFrame
  const stem = `${names.base}-${plan.format.name}`
  const pieces = runs.map((_, i) => join(cache, `${stem}-${String(i).padStart(2, '0')}.mkv`))
  let doneFrames = 0
  let shown = -1
  const started = Date.now()
  const progress = () => {
    doneFrames++
    const percent = Math.floor((doneFrames / total) * 20) * 5
    if (percent !== shown) {
      shown = percent
      process.stdout.write(`\r  ${plan.lang} ${encode.formatLabel(plan.format.name)} : ${String(percent).padStart(3)} % (${doneFrames}/${total} images)`)
    }
  }
  await Promise.all(runs.map((r, i) => renderPiece(browser, plan, timeline, range, r, pieces[i], progress)))
  process.stdout.write(` en ${((Date.now() - started) / 1000).toFixed(0)} s\n`)
  const list = join(cache, `${stem}.txt`)
  writeFileSync(list, encode.concatList(pieces))
  const master = join(cache, `${stem}.mkv`)
  run('ffmpeg', encode.concatArgs(list, master), 'assemblage des morceaux')
  if (!opts.keep) for (const piece of [...pieces, list]) rmSync(piece, { force: true })
  log.push(`${plan.lang} ${encode.formatLabel(plan.format.name)} : ${total} images rendues en ${((Date.now() - started) / 1000).toFixed(0)} s`)
  return master
}

function encodeOutputs(opts, timeline, range, plan, master, names, log) {
  const start = timing.timeOf(range.startFrame)
  const duration = timing.timeOf(range.endFrame - range.startFrame)
  const music = opts.music ? { file: opts.music, offset: start, duration, fadeIn: 1.5, fadeOut: 2.5 } : undefined
  const outputs = []
  const out = (name) => join(opts.out, name)
  if (plan.format.name === 'wide') {
    run('ffmpeg', encode.mp4Args(master, out(names.mp4), timing.FPS, music), 'MP4')
    outputs.push(names.mp4)
    if (opts.webm) {
      run('ffmpeg', encode.webmArgs(master, out(names.webm), timing.FPS, music), 'WebM')
      outputs.push(names.webm)
    }
  } else {
    run('ffmpeg', encode.mp4Args(master, out(names.square), timing.FPS, music), 'MP4 carré')
    outputs.push(names.square)
  }
  const poster = timeline.scenes[data.POSTER.scene - 1]
  const posterTime = poster.start + data.POSTER.at
  const at = posterTime >= start && posterTime < start + duration ? posterTime - start : 0
  const posterName = plan.format.name === 'wide' ? names.poster : names.squarePoster
  run('ffmpeg', encode.posterArgs(master, at, out(posterName)), 'affiche')
  outputs.push(posterName)
  if (!opts.keep) rmSync(master, { force: true })
  log.push(`  ${outputs.join(', ')}`)
  return outputs
}

async function render(opts) {
  const timeline = timing.buildTimeline(data.SCENES)
  const range = timing.parseRange(timeline, opts.from, opts.to)
  const full = timing.isFull(timeline, range)
  mkdirSync(opts.out, { recursive: true })
  const browser = await launch()
  try {
    for (const lang of opts.langs) {
      const names = encode.outputNames(lang, full ? undefined : partOf(timeline, range))
      const report = { missing: [], clips: [], notes: new Set() }
      const log = [
        `Lucium — rendu du film (${lang}), ${new Date().toISOString()}`,
        `captures : ${opts.captures}`,
        `partie : ${full ? 'film entier' : `scènes ${range.first + 1} à ${range.last + 1}`}, ${timing.timeOf(range.startFrame).toFixed(2)} s à ${timing.timeOf(range.endFrame).toFixed(2)} s`,
        `musique : ${opts.music ?? 'aucune (film muet)'}`,
        ''
      ]
      console.log(`Film ${lang} : ${log[2].replace('partie : ', '')}`)
      const plans = opts.formats.map((format) => filmPlan(opts, lang, format, report))
      for (const plan of plans) {
        const master = await renderFormat(browser, opts, plan, timeline, range, names, log)
        encodeOutputs(opts, timeline, range, plan, master, names, log)
      }
      writeFileSync(join(opts.out, `lucium-${lang}.txt`), timing.transcript(timeline, lang))
      writeFileSync(join(opts.out, `lucium-${lang}.vtt`), timing.webvtt(timeline, lang))
      log.push(`  lucium-${lang}.txt, lucium-${lang}.vtt`, '')
      const missing = layout.missingReport(dedupe(report.missing.filter((item) => item.scene >= range.first + 1 && item.scene <= range.last + 1)), lang)
      log.push(missing.length ? `${missing.length} capture(s) manquante(s) :` : 'aucune capture manquante', ...missing.map((line) => `  ${line}`))
      if (report.clips.length) log.push('', 'vidéos utilisées :', ...[...new Set(report.clips)].map((line) => `  ${line}`))
      if (report.notes.size) log.push('', 'à vérifier :', ...[...report.notes].map((line) => `  ${line}`))
      writeFileSync(join(opts.out, names.log), `${log.join('\n')}\n`)
      for (const line of missing) console.log(`  ${line}`)
      for (const line of report.notes) console.log(`  à vérifier : ${line}`)
      console.log(`  → ${shown(join(opts.out, names.base))}.* (journal : ${names.log})`)
    }
  } finally {
    await browser.close()
  }
}

const dedupe = (missing) => [...new Map(missing.map((item) => [`${item.scene}/${item.theme}/${item.shot}`, item])).values()]

function partOf(timeline, range) {
  const sceneStart = timing.framesOf(timeline.scenes[range.first].start)
  const sceneEnd = timing.framesOf(timeline.scenes[range.last].end)
  return range.startFrame === sceneStart && range.endFrame === sceneEnd ? { first: range.first + 1, last: range.last + 1 } : { startFrame: range.startFrame, endFrame: range.endFrame }
}

async function renderStill(opts) {
  const timeline = timing.buildTimeline(data.SCENES)
  const frame = timing.framesOf(opts.still)
  if (frame >= timing.framesOf(timeline.duration)) throw new UsageError(`--still : le film dure ${timeline.duration} s`)
  mkdirSync(opts.out, { recursive: true })
  const browser = await launch()
  try {
    for (const lang of opts.langs) {
      for (const format of opts.formats) {
        const report = { missing: [], clips: [], notes: new Set() }
        const worker = await openPage(browser, filmPlan(opts, lang, format, report))
        const file = join(opts.out, `image-${lang}-${format}-${opts.still.toFixed(2)}s.png`)
        writeFileSync(file, await shoot(worker, timing.frameState(timeline, frame)))
        await worker.page.close()
        console.log(shown(file))
      }
    }
  } finally {
    await browser.close()
  }
}

function writePreview(opts) {
  const timeline = timing.buildTimeline(data.SCENES)
  const range = timing.parseRange(timeline, opts.from, opts.to)
  for (const lang of opts.langs) {
    const report = { missing: [], clips: [], notes: new Set() }
    const plan = filmPlan(opts, lang, opts.formats[0], report)
    const dir = join(opts.out, `apercu-${lang}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'data.js'), `window.FILM_PREVIEW = ${JSON.stringify({ data: plan, frames: timing.frameStates(timeline, range) })}\n`)
    const asset = (name) => pathToFileURL(join(here, 'montage', name)).href
    writeFileSync(
      join(dir, 'index.html'),
      `<!doctype html>\n<html lang="${lang}"><head><meta charset="utf-8"><title>Lucium — aperçu du film (${lang})</title><link rel="stylesheet" href="${asset('montage.css')}"></head>\n` +
        `<body><div id="stage"></div><script src="data.js"></script><script src="${asset('placeholders.js')}"></script><script src="${asset('montage.js')}"></script></body></html>\n`
    )
    console.log(`${shown(join(dir, 'index.html'))} (à ouvrir dans un navigateur)`)
  }
}

function list(opts) {
  const timeline = timing.buildTimeline(data.SCENES)
  console.log(`Le film : ${data.SCENES.length} scènes, ${timeline.duration} s, ${timing.framesOf(timeline.duration)} images à ${timing.FPS} i/s.\n`)
  for (const scene of timeline.scenes) {
    const { spec } = scene
    console.log(`${String(spec.number).padStart(2)}. ${spec.id.padEnd(14)} ${timing.clock(scene.start)}–${timing.clock(scene.end)}  ${spec.description}`)
    console.log(`    FR « ${timing.sceneText(spec, 'fr')} »`)
    console.log(`    EN « ${timing.sceneText(spec, 'en')} »`)
  }
  for (const lang of opts.langs) {
    const notes = new Set()
    const sources = sourcesFor(opts, lang, notes)
    console.log(`\nPrises (${lang}, ${opts.captures}) :`)
    const needed = new Map()
    for (const spec of data.SCENES) {
      const theme = spec.theme ?? 'light'
      for (const still of spec.stills ?? []) needed.set(`${still.theme ?? theme}/${still.shot}`, [...(needed.get(`${still.theme ?? theme}/${still.shot}`) ?? []), spec.number])
      for (const tile of spec.tiles ?? []) needed.set(`${theme}/${tile.shot}`, [...(needed.get(`${theme}/${tile.shot}`) ?? []), spec.number])
    }
    for (const [key, scenes] of needed) {
      const [theme, shot] = key.split('/')
      const ok = sources.capture(shot, theme) !== undefined
      const extra = data.EXTRA_SHOTS.find((item) => item.id === shot)
      const todo = shots.SHOTS.find((item) => item.id === shot)?.todo
      const note = extra ? ` — à prendre hors de l’outil de captures : ${extra.description}` : todo ? ` — pas encore prise par l’outil (shots.ts) : ${todo}` : ''
      console.log(`  ${ok ? 'ok      ' : 'manque  '} ${key.padEnd(30)} scène ${[...new Set(scenes)].join(', ')}${note}`)
    }
    console.log(`\nVidéos d’écran (facultatives, dans ${join(opts.captures, lang, '<thème>', 'videos')}/<nom>.mov) :`)
    for (const clip of data.CLIPS) {
      const scene = data.SCENES.find((spec) => spec.clips?.some((c) => c.id === clip.id))
      const theme = scene?.clips?.find((c) => c.id === clip.id)?.theme ?? scene?.theme ?? 'light'
      const ok = sources.clip(clip.id, theme) !== undefined
      console.log(`  ${ok ? 'ok      ' : 'manque  '} ${`${theme}/${clip.id}`.padEnd(30)} ~${clip.seconds} s, scène ${scene?.number ?? '?'} — ${clip.description}`)
    }
    for (const note of notes) console.log(`  à vérifier : ${note}`)
  }
}

async function main() {
  let opts
  try {
    opts = options(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    console.error('pnpm film:site --help pour l’aide')
    process.exit(2)
  }
  if (opts.help) return console.log(USAGE)
  if (opts.list) return list(opts)
  if (spawnSync('ffmpeg', ['-version']).status !== 0) {
    console.error('ffmpeg est introuvable : brew install ffmpeg')
    process.exit(2)
  }
  const once = async () => {
    if (opts.page) return writePreview(opts)
    if (opts.still !== undefined) return renderStill(opts)
    return render(opts)
  }
  try {
    await once()
  } catch (error) {
    console.error(`\n${error instanceof UsageError ? '' : 'échec : '}${error.message}`)
    if (!opts.watch) process.exit(error instanceof UsageError ? 2 : 1)
  }
  if (!opts.watch) return
  // Again when a capture, a scene or the page changes; a burst of changes (a session of captures) makes one render.
  console.log(`\nJe surveille ${shown(opts.captures)} et scripts/site-film/ (ctrl-C pour arrêter).`)
  let timer
  let busy = false
  let again = false
  const trigger = () => {
    clearTimeout(timer)
    timer = setTimeout(async () => {
      if (busy) {
        again = true
        return
      }
      busy = true
      do {
        again = false
        try {
          await once()
        } catch (error) {
          console.error(`échec : ${error.message}`)
        }
      } while (again)
      busy = false
    }, 2000)
  }
  const watched = [here]
  if (existsSync(opts.captures)) watched.push(opts.captures)
  for (const dir of watched) watch(dir, { recursive: true }, (_, file) => (file && !String(file).includes('.cache') ? trigger() : undefined))
}

await main()
