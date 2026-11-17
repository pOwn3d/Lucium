// The demonstration pages the captures show in their tabs: a notebook, a project board, the week's weather, seasonal recipes, the hours of a museum,
// a week planner, lists, new books at a library, a trip, articles (one long enough for the reader mode), a sowing calendar, a roadmap, a colour
// palette and a one-page PDF report, in French and in English, light and dark (they follow `prefers-color-scheme`, which the application's Apparence
// setting decides). Everything is in the page: the styles inline, the illustrations in CSS and SVG, the icons generated (demo.ts), the system's fonts.
// No script, no photograph, no brand, no person, no address; the headers forbid the page to load anything from anywhere (the PDF, which loads
// nothing, has none: the viewer of the engine lives in it). scripts/site-captures.mjs serves them on 127.0.0.1; `respond` is the whole server.
// Pure, and loaded by Node with type stripping: no runtime import, no enum, no parameter property.

import type { Lang } from './shots'
import type { PageDef } from './demo'

/** Nothing leaves the page: no script, styles inline, images only from `data:`, no form, no frame. */
export const PAGE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
}

/** What the renderer needs besides the page: its icon, and the address of another page by its key (the links between pages). */
export interface PageContext {
  lang: Lang
  icon: string
  urlOf: (key: string) => string
}

const esc = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

type L<T> = Readonly<Record<Lang, T>>

// ---------- the frame every page shares ----------

const BASE_CSS = `
:root { color-scheme: light dark; --bg: #f6f4f0; --card: #ffffff; --ink: #1d1d1f; --muted: #6b6b72; --line: #e6e2dc; --soft: #efece6; --shadow: 0 1px 2px rgb(0 0 0 / .05), 0 6px 18px rgb(0 0 0 / .04); }
@media (prefers-color-scheme: dark) { :root { --bg: #161618; --card: #212124; --ink: #f1f1f3; --muted: #a2a2aa; --line: #323237; --soft: #2a2a2e; --shadow: 0 1px 2px rgb(0 0 0 / .4); } }
* { box-sizing: border-box; }
html, body { margin: 0; }
body { background: var(--bg); color: var(--ink); font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Helvetica Neue", system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.top { display: flex; align-items: center; gap: 14px; padding: 14px clamp(18px, 4vw, 40px); background: var(--card); border-bottom: 1px solid var(--line); position: sticky; top: 0; }
.brand { display: flex; align-items: center; gap: 10px; font-weight: 650; letter-spacing: -.01em; white-space: nowrap; }
.brand img { width: 26px; height: 26px; border-radius: 7px; }
.top nav { display: flex; gap: 18px; margin-left: 12px; overflow: hidden; }
.top nav span { color: var(--muted); font-size: 14px; white-space: nowrap; }
.top nav span.on { color: var(--ink); font-weight: 600; }
.search { margin-left: auto; min-width: 0; width: 220px; height: 32px; border-radius: 9px; background: var(--soft); color: var(--muted); font-size: 13px; display: flex; align-items: center; padding: 0 12px; gap: 8px; }
.search svg { flex: none; }
main { max-width: 1080px; margin: 0 auto; padding: 30px clamp(18px, 4vw, 40px) 64px; }
h1 { font-size: 30px; line-height: 1.15; letter-spacing: -.025em; margin: 0 0 6px; }
h2 { font-size: 17px; letter-spacing: -.01em; margin: 26px 0 10px; }
.lead { color: var(--muted); margin: 0 0 24px; font-size: 16px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow); }
.chip { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px; border-radius: 99px; font-size: 12.5px; font-weight: 600; background: color-mix(in srgb, var(--c, var(--accent)) 14%, transparent); color: color-mix(in srgb, var(--c, var(--accent)) 82%, var(--ink)); white-space: nowrap; }
.muted { color: var(--muted); }
.row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.grid { display: grid; gap: 16px; }
@media (max-width: 620px) { .top nav, .search { display: none; } h1 { font-size: 25px; } }
`

const SEARCH_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m11 11 3.5 3.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'

interface Frame {
  brand: string
  nav: string[]
  search: string
  css: string
  body: string
}

function htmlPage(def: PageDef, ctx: PageContext, frame: Frame): string {
  const title = def.title[ctx.lang]
  const nav = frame.nav.map((item, i) => `<span${i === 0 ? ' class="on"' : ''}>${esc(item)}</span>`).join('')
  return `<!doctype html>
<html lang="${ctx.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(title)}</title>
<link rel="icon" href="${esc(ctx.icon)}">
<style>:root { --accent: ${def.color}; }${BASE_CSS}${frame.css}</style>
</head>
<body>
<header class="top"><span class="brand"><img src="${esc(ctx.icon)}" alt="">${esc(frame.brand)}</span><nav>${nav}</nav><span class="search">${SEARCH_ICON}${esc(frame.search)}</span></header>
${frame.body}
</body>
</html>`
}

const checkbox = (done: boolean) =>
  `<span class="box${done ? ' done' : ''}" aria-hidden="true">${done ? '<svg viewBox="0 0 16 16" width="12" height="12"><path d="m3.5 8.5 3 3 6-7" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>' : ''}</span>`
const CHECK_CSS = `.box { flex: none; width: 18px; height: 18px; border-radius: 6px; border: 1.6px solid color-mix(in srgb, var(--muted) 70%, transparent); display: inline-grid; place-items: center; }
.box.done { background: var(--accent); border-color: var(--accent); }
.done + .text { color: var(--muted); text-decoration: line-through; text-decoration-color: color-mix(in srgb, var(--muted) 60%, transparent); }`

// ---------- notebook ----------

interface Note {
  title: string
  snippet: string
  when: string
}

const NOTES: L<{ brand: string; nav: string[]; search: string; list: Note[]; all: string; edited: string }> = {
  fr: {
    brand: 'Carnet',
    nav: ['Notes', 'Étiquettes', 'Archives'],
    search: 'Rechercher dans le carnet',
    all: 'Toutes les notes',
    edited: 'Modifiée à 9 h 41',
    list: [
      { title: 'Idées de la semaine', snippet: 'Préparer l’atelier de jeudi, relire le guide…', when: 'Aujourd’hui' },
      { title: 'Réunion de lundi', snippet: 'Décisions et prochaines étapes', when: 'Lundi' },
      { title: 'Idées en vrac', snippet: 'Une couleur par espace, des icônes plus douces', when: 'Dimanche' },
      { title: 'Lectures', snippet: 'Trois articles sur la typographie', when: 'Samedi' },
      { title: 'Marché du samedi', snippet: 'Pommes, potimarron, noix, miel', when: 'Vendredi' },
      { title: 'Escapade', snippet: 'Réserver le train, prévoir un coupe-vent', when: 'Jeudi' }
    ]
  },
  en: {
    brand: 'Notebook',
    nav: ['Notes', 'Tags', 'Archive'],
    search: 'Search the notebook',
    all: 'All notes',
    edited: 'Edited at 9:41 AM',
    list: [
      { title: 'Ideas for the week', snippet: 'Prepare Thursday’s workshop, reread the guide…', when: 'Today' },
      { title: 'Monday meeting', snippet: 'Decisions and next steps', when: 'Monday' },
      { title: 'Loose ideas', snippet: 'One colour per space, softer icons', when: 'Sunday' },
      { title: 'Reading list', snippet: 'Three articles about typography', when: 'Saturday' },
      { title: 'Saturday market', snippet: 'Apples, squash, walnuts, honey', when: 'Friday' },
      { title: 'Getaway', snippet: 'Book the train, pack a windbreaker', when: 'Thursday' }
    ]
  }
}

function noteBody(key: string, ctx: PageContext): { selected: number; html: string } {
  const fr = ctx.lang === 'fr'
  const todo = (items: Array<[boolean, string]>) => `<ul class="todo">${items.map(([done, text]) => `<li>${checkbox(done)}<span class="text">${esc(text)}</span></li>`).join('')}</ul>`
  if (key === 'meeting') {
    return {
      selected: 1,
      html: `<h1>${fr ? 'Réunion de lundi' : 'Monday meeting'}</h1>
<div class="row meta"><span class="chip">${fr ? 'réunion' : 'meeting'}</span><span class="chip" style="--c:#4c7cf0">${fr ? 'Mosaïque' : 'Mosaic'}</span><span class="muted">${fr ? 'Modifiée lundi' : 'Edited on Monday'}</span></div>
<h2>${fr ? 'Décisions' : 'Decisions'}</h2>
<ul class="dots"><li>${fr ? 'La page d’accueil garde trois sections, pas plus.' : 'The home page keeps three sections, no more.'}</li><li>${fr ? 'Le thème sombre sort en même temps que le clair.' : 'The dark theme ships together with the light one.'}</li><li>${fr ? 'Une démonstration courte chaque vendredi.' : 'A short demo every Friday.'}</li></ul>
<h2>${fr ? 'Prochaines étapes' : 'Next steps'}</h2>
${todo(fr ? [[true, 'Partager le compte rendu'], [false, 'Mettre à jour le tableau'], [false, 'Préparer la démo de vendredi']] : [[true, 'Share the notes'], [false, 'Update the board'], [false, 'Prepare Friday’s demo']])}`
    }
  }
  if (key === 'ideas') {
    return {
      selected: 2,
      html: `<h1>${fr ? 'Idées en vrac' : 'Loose ideas'}</h1>
<div class="row meta"><span class="chip">${fr ? 'atelier' : 'studio'}</span><span class="muted">${fr ? 'Modifiée dimanche' : 'Edited on Sunday'}</span></div>
<ul class="dots"><li>${fr ? 'Une couleur par espace, pour savoir où l’on est d’un coup d’œil.' : 'One colour per space, to know where you are at a glance.'}</li><li>${fr ? 'Des icônes plus douces, aux coins arrondis.' : 'Softer icons with rounded corners.'}</li><li>${fr ? 'Un carnet par projet, rangé à côté de ses onglets.' : 'A notebook per project, kept next to its tabs.'}</li><li>${fr ? 'Moins de menus, plus de raccourcis.' : 'Fewer menus, more shortcuts.'}</li></ul>
<blockquote>${fr ? 'Garder ce qui sert, ranger le reste.' : 'Keep what helps, tidy away the rest.'}</blockquote>`
    }
  }
  return {
    selected: 0,
    html: `<h1>${fr ? 'Idées de la semaine' : 'Ideas for the week'}</h1>
<div class="row meta"><span class="chip">${fr ? 'atelier' : 'workshop'}</span><span class="chip" style="--c:#3fa66b">${fr ? 'lecture' : 'reading'}</span><span class="chip" style="--c:#e0683a">${fr ? 'maison' : 'home'}</span><span class="muted">${esc(NOTES[ctx.lang].edited)}</span></div>
<p>${fr ? 'Une semaine plus calme : l’occasion de ranger le tableau du projet et de préparer l’atelier de jeudi sans se presser.' : 'A quieter week: a good moment to tidy the project board and prepare Thursday’s workshop without rushing.'}</p>
<h2>${fr ? 'À faire' : 'To do'}</h2>
${todo(fr ? [[true, 'Relire le guide de style'], [true, 'Envoyer l’ordre du jour'], [false, 'Préparer les maquettes de l’accueil'], [false, 'Trier les photos de l’atelier']] : [[true, 'Reread the style guide'], [true, 'Send the agenda'], [false, 'Prepare the home page mock-ups'], [false, 'Sort the workshop photos']])}
<h2>${fr ? 'À garder en tête' : 'Keep in mind'}</h2>
<p>${fr ? `Jeudi s’annonce ensoleillé : jeter un œil aux <a id="peek-link" href="${esc(ctx.urlOf('weather'))}">prévisions de la semaine</a> avant de fixer la sortie de l’équipe.` : `Thursday looks sunny: check <a id="peek-link" href="${esc(ctx.urlOf('weather'))}">this week’s forecast</a> before setting the team outing.`}</p>
<blockquote>${fr ? 'Moins d’onglets ouverts, des idées plus claires.' : 'Fewer open tabs, clearer ideas.'}</blockquote>`
  }
}

function notesPage(def: PageDef, ctx: PageContext): string {
  const t = NOTES[ctx.lang]
  const { selected, html } = noteBody(def.key, ctx)
  const list = t.list.map((note, i) => `<li class="${i === selected ? 'on' : ''}"><b>${esc(note.title)}</b><span>${esc(note.snippet)}</span><small>${esc(note.when)}</small></li>`).join('')
  return htmlPage(def, ctx, {
    brand: t.brand,
    nav: t.nav,
    search: t.search,
    css: `${CHECK_CSS}
.notes { display: grid; grid-template-columns: minmax(200px, 270px) 1fr; gap: 20px; align-items: start; }
.list { padding: 10px; }
.list h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 6px 10px 8px; }
.list ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.list li { padding: 10px 12px; border-radius: 10px; display: grid; gap: 1px; }
.list li span { color: var(--muted); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.list li small { color: var(--muted); font-size: 11.5px; }
.list li.on { background: color-mix(in srgb, var(--accent) 16%, transparent); }
.note { padding: 26px 32px 30px; }
.note .meta { margin: 8px 0 18px; font-size: 13px; }
.note p { margin: 0 0 12px; max-width: 62ch; }
.todo, .dots { margin: 0 0 6px; padding: 0; list-style: none; display: grid; gap: 9px; }
.todo li { display: flex; gap: 10px; align-items: center; }
.dots li { padding-left: 18px; position: relative; }
.dots li::before { content: ""; position: absolute; left: 3px; top: .62em; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }
blockquote { margin: 22px 0 0; padding: 14px 18px; border-left: 3px solid var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); border-radius: 0 10px 10px 0; font-style: italic; }
@media (max-width: 760px) { .notes { grid-template-columns: 1fr; } .list { display: none; } .note { padding: 22px; } }`,
    body: `<main><div class="notes"><section class="card list"><h3>${esc(t.all)}</h3><ul>${list}</ul></section><article class="card note">${html}</article></div></main>`
  })
}

// ---------- project board ----------

interface BoardCard {
  title: string
  label: [string, string]
  due: string
  progress?: number
  comments?: number
}

const BOARD: L<{ nav: string[]; search: string; lead: string; columns: Array<{ title: string; cards: BoardCard[] }>; stats: string[] }> = {
  fr: {
    nav: ['Tableau', 'Feuille de route', 'Fichiers'],
    search: 'Rechercher une carte',
    lead: 'Refonte du site · objectif : la démonstration de vendredi',
    stats: ['10 cartes', '3 en cours', '30 % terminé'],
    columns: [
      { title: 'À faire', cards: [
        { title: 'Maquettes de l’accueil', label: ['Design', '#d2508a'], due: 'jeu.' },
        { title: 'Textes de la page d’aide', label: ['Rédaction', '#e8a33d'], due: 'ven.', comments: 2 },
        { title: 'Icônes du menu', label: ['Design', '#d2508a'], due: 'lun.' },
        { title: 'Essais sur petits écrans', label: ['Qualité', '#18a589'], due: 'mar.' }
      ] },
      { title: 'En cours', cards: [
        { title: 'Nouvelle barre de recherche', label: ['Dév', '#4c7cf0'], due: 'mer.', progress: 60, comments: 4 },
        { title: 'Palette sombre', label: ['Design', '#d2508a'], due: 'jeu.', progress: 35 },
        { title: 'Guide de démarrage', label: ['Rédaction', '#e8a33d'], due: 'ven.', progress: 80, comments: 1 }
      ] },
      { title: 'Terminé', cards: [
        { title: 'Choix des couleurs', label: ['Design', '#d2508a'], due: 'lun.' },
        { title: 'Plan du site', label: ['Produit', '#8a63d2'], due: 'mar.' },
        { title: 'Atelier de lancement', label: ['Équipe', '#3fa66b'], due: 'mer.' }
      ] }
    ]
  },
  en: {
    nav: ['Board', 'Roadmap', 'Files'],
    search: 'Search cards',
    lead: 'Website refresh · goal: Friday’s demo',
    stats: ['10 cards', '3 in progress', '30% done'],
    columns: [
      { title: 'To do', cards: [
        { title: 'Home page mock-ups', label: ['Design', '#d2508a'], due: 'Thu' },
        { title: 'Help page copy', label: ['Writing', '#e8a33d'], due: 'Fri', comments: 2 },
        { title: 'Menu icons', label: ['Design', '#d2508a'], due: 'Mon' },
        { title: 'Small screen checks', label: ['Quality', '#18a589'], due: 'Tue' }
      ] },
      { title: 'In progress', cards: [
        { title: 'New search bar', label: ['Dev', '#4c7cf0'], due: 'Wed', progress: 60, comments: 4 },
        { title: 'Dark palette', label: ['Design', '#d2508a'], due: 'Thu', progress: 35 },
        { title: 'Getting started guide', label: ['Writing', '#e8a33d'], due: 'Fri', progress: 80, comments: 1 }
      ] },
      { title: 'Done', cards: [
        { title: 'Colour choices', label: ['Design', '#d2508a'], due: 'Mon' },
        { title: 'Site map', label: ['Product', '#8a63d2'], due: 'Tue' },
        { title: 'Kick-off workshop', label: ['Team', '#3fa66b'], due: 'Wed' }
      ] }
    ]
  }
}

const DOT_COLORS = ['#4c7cf0', '#e0683a', '#3fa66b', '#8a63d2', '#e8a33d']

function boardPage(def: PageDef, ctx: PageContext): string {
  const t = BOARD[ctx.lang]
  const card = (c: BoardCard, i: number) => `<li class="card task"><span class="chip" style="--c:${c.label[1]}">${esc(c.label[0])}</span><b>${esc(c.title)}</b>${
    c.progress !== undefined ? `<span class="bar"><i style="width:${c.progress}%"></i></span>` : ''
  }<span class="foot"><span class="due"><svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M2 6.5h12" stroke="currentColor" stroke-width="1.5"/></svg>${esc(c.due)}</span>${
    c.comments ? `<span class="due"><svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3h10v7H7l-3 3v-3H3Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>${c.comments}</span>` : ''
  }<span class="dots">${[0, 1].map((n) => `<i style="background:${DOT_COLORS[(i + n * 2) % DOT_COLORS.length]}"></i>`).join('')}</span></span></li>`
  const columns = t.columns.map((col, ci) => `<section class="col"><h3>${esc(col.title)}<span>${col.cards.length}</span></h3><ul>${col.cards.map((c, i) => card(c, i + ci)).join('')}</ul></section>`).join('')
  const project = ctx.lang === 'fr' ? 'Mosaïque' : 'Mosaic'
  return htmlPage(def, ctx, {
    brand: project,
    nav: t.nav,
    search: t.search,
    css: `.head { display: flex; justify-content: space-between; align-items: end; gap: 16px; flex-wrap: wrap; margin-bottom: 22px; }
.head .lead { margin: 0; }
.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 16px; align-items: start; }
.col { background: color-mix(in srgb, var(--soft) 70%, transparent); border-radius: 16px; padding: 12px; }
.col h3 { margin: 2px 6px 12px; font-size: 14px; display: flex; justify-content: space-between; }
.col h3 span { color: var(--muted); font-weight: 500; }
.col ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.task { padding: 12px 14px; display: grid; gap: 8px; }
.task b { font-weight: 600; font-size: 14.5px; }
.chip { justify-self: start; }
.bar { height: 6px; border-radius: 99px; background: var(--soft); overflow: hidden; }
.bar i { display: block; height: 100%; border-radius: inherit; background: var(--accent); }
.foot { display: flex; align-items: center; gap: 12px; color: var(--muted); font-size: 12.5px; }
.due { display: inline-flex; gap: 5px; align-items: center; }
.dots { margin-left: auto; display: flex; }
.dots i { width: 20px; height: 20px; border-radius: 50%; border: 2px solid var(--card); margin-left: -6px; }`,
    body: `<main><div class="head"><div><h1>${project}</h1><p class="lead">${esc(t.lead)}</p></div><div class="row">${t.stats.map((s, i) => `<span class="chip"${i === 2 ? ' style="--c:#3fa66b"' : ''}>${esc(s)}</span>`).join('')}</div></div><div class="cols">${columns}</div></main>`
  })
}

// ---------- weather ----------

type Sky = 'sun' | 'partly' | 'cloud' | 'rain'

const SKY_SVG: Readonly<Record<Sky, string>> = {
  sun: '<circle cx="24" cy="24" r="9" fill="#f6b928"/><g stroke="#f6b928" stroke-width="3" stroke-linecap="round"><path d="M24 6v5M24 37v5M6 24h5M37 24h5M11.3 11.3l3.5 3.5M33.2 33.2l3.5 3.5M11.3 36.7l3.5-3.5M33.2 14.8l3.5-3.5"/></g>',
  partly: '<circle cx="19" cy="18" r="8" fill="#f6b928"/><path d="M17 38a8 8 0 0 1 1-16 10 10 0 0 1 19 3 6.5 6.5 0 0 1-1 13Z" fill="#cfd6e3"/>',
  cloud: '<path d="M13 37a9 9 0 0 1 1.5-17.9A11 11 0 0 1 35.5 22 7.5 7.5 0 0 1 34 37Z" fill="#b9c2d1"/>',
  rain: '<path d="M13 30a9 9 0 0 1 1.5-17.9A11 11 0 0 1 35.5 15 7.5 7.5 0 0 1 34 30Z" fill="#a7b2c4"/><g stroke="#4c8fe8" stroke-width="3" stroke-linecap="round"><path d="M16 35l-2 5M24 35l-2 5M32 35l-2 5"/></g>'
}
const sky = (kind: Sky, size: number) => `<svg width="${size}" height="${size}" viewBox="0 0 48 48" aria-hidden="true">${SKY_SVG[kind]}</svg>`

const WEATHER: L<{ nav: string[]; search: string; today: string; now: string; feel: string; stats: Array<[string, string]>; days: string[]; hours: string; week: string }> = {
  fr: {
    nav: ['Prévisions', 'Radar', 'Alertes'],
    search: 'Rechercher une ville',
    today: 'Aujourd’hui',
    now: 'Ensoleillé, brise légère',
    feel: 'Ressenti 18°',
    stats: [['Humidité', '54 %'], ['Vent', '12 km/h'], ['Indice UV', '4'], ['Pluie', '0 mm']],
    days: ['Lun.', 'Mar.', 'Mer.', 'Jeu.', 'Ven.', 'Sam.', 'Dim.'],
    hours: 'Heure par heure',
    week: 'Les sept prochains jours'
  },
  en: {
    nav: ['Forecast', 'Radar', 'Alerts'],
    search: 'Search for a city',
    today: 'Today',
    now: 'Sunny, light breeze',
    feel: 'Feels like 64°',
    stats: [['Humidity', '54%'], ['Wind', '7 mph'], ['UV index', '4'], ['Rain', '0 in']],
    days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    hours: 'Hour by hour',
    week: 'The next seven days'
  }
}

const WEEK: ReadonlyArray<[Sky, number, number]> = [['sun', 19, 9], ['partly', 17, 8], ['rain', 13, 7], ['sun', 20, 10], ['partly', 18, 9], ['cloud', 15, 8], ['sun', 21, 11]]
const HOURS: ReadonlyArray<[string, Sky, number]> = [['9', 'sun', 13], ['11', 'sun', 16], ['13', 'sun', 19], ['15', 'partly', 19], ['17', 'partly', 17], ['19', 'cloud', 15], ['21', 'cloud', 12]]

function weatherPage(def: PageDef, ctx: PageContext): string {
  const t = WEATHER[ctx.lang]
  const fahrenheit = ctx.lang === 'en'
  const deg = (c: number) => `${fahrenheit ? Math.round((c * 9) / 5 + 32) : c}°`
  const lowest = Math.min(...WEEK.map((d) => d[2]))
  const highest = Math.max(...WEEK.map((d) => d[1]))
  const span = highest - lowest
  const days = WEEK.map(([kind, max, min], i) => `<li><b>${esc(t.days[i]!)}</b>${sky(kind, 30)}<span class="lo">${deg(min)}</span><span class="range"><i style="left:${((min - lowest) / span) * 100}%;right:${100 - ((max - lowest) / span) * 100}%"></i></span><span class="hi">${deg(max)}</span></li>`).join('')
  const hours = HOURS.map(([hour, kind, c]) => `<li><span class="muted">${fahrenheit ? `${Number(hour) > 12 ? Number(hour) - 12 : hour} ${Number(hour) >= 12 ? 'PM' : 'AM'}` : `${hour} h`}</span>${sky(kind, 28)}<b>${deg(c)}</b></li>`).join('')
  return htmlPage(def, ctx, {
    brand: ctx.lang === 'fr' ? 'Météo' : 'Weather',
    nav: t.nav,
    search: t.search,
    css: `.hero { padding: 26px 30px; display: grid; grid-template-columns: auto 1fr; gap: 10px 28px; align-items: center; background: linear-gradient(135deg, color-mix(in srgb, #f6b928 22%, var(--card)), color-mix(in srgb, #4c8fe8 16%, var(--card))); }
.hero .temp { font-size: 76px; font-weight: 300; letter-spacing: -.04em; line-height: 1; }
.hero h2 { margin: 0 0 4px; font-size: 20px; }
.stats { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 10px; margin-top: 14px; }
.stats div { background: color-mix(in srgb, var(--card) 70%, transparent); border-radius: 12px; padding: 10px 14px; }
.stats span { display: block; color: var(--muted); font-size: 12.5px; }
.stats b { font-size: 17px; }
.hours { list-style: none; margin: 0; padding: 14px; display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; text-align: center; }
.hours li { display: grid; justify-items: center; gap: 4px; font-size: 13px; }
.week { list-style: none; margin: 0; padding: 8px 18px; }
.week li { display: grid; grid-template-columns: 48px 34px 44px 1fr 44px; align-items: center; gap: 12px; padding: 9px 0; border-bottom: 1px solid var(--line); }
.week li:last-child { border-bottom: 0; }
.week .lo { color: var(--muted); text-align: right; }
.range { position: relative; height: 6px; border-radius: 99px; background: var(--soft); }
.range i { position: absolute; top: 0; bottom: 0; border-radius: 99px; background: linear-gradient(90deg, #6fb3f2, #f6b928, #f08a3c); }
.two { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; margin-top: 16px; align-items: start; }
.two h2 { margin: 16px 18px 0; }`,
    body: `<main><section class="card hero">${sky('sun', 96)}<div><h2>${esc(t.today)}</h2><div class="temp">${deg(19)}</div><p class="muted" style="margin:6px 0 0">${esc(t.now)} · ${esc(t.feel)}</p></div><div class="stats">${t.stats.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div></section>
<div class="two"><section class="card"><h2>${esc(t.week)}</h2><ul class="week">${days}</ul></section><section class="card"><h2>${esc(t.hours)}</h2><ul class="hours">${hours}</ul></section></div></main>`
  })
}

// ---------- recipes ----------

interface Recipe {
  title: string
  time: string
  level: string
  colors: [string, string, string]
}

const RECIPES: L<{ nav: string[]; search: string; lead: string; featured: string; featuredMeta: string; ingredients: string; list: string[]; more: string; recipes: Recipe[] }> = {
  fr: {
    nav: ['Recettes', 'De saison', 'Carnet'],
    search: 'Une recette, un ingrédient',
    lead: 'Des plats simples avec ce que l’on trouve au marché en ce moment.',
    featured: 'Velouté de potimarron',
    featuredMeta: '35 min · Facile · 4 personnes',
    ingredients: 'Ingrédients',
    list: ['1 potimarron', '2 échalotes', '50 cl de bouillon', '10 cl de crème', 'Muscade, sel, poivre'],
    more: 'Cette semaine',
    recipes: [
      { title: 'Tarte fine aux pommes', time: '45 min', level: 'Facile', colors: ['#f4c26b', '#d98a3a', '#f7e4b8'] },
      { title: 'Salade de lentilles', time: '25 min', level: 'Facile', colors: ['#8aa65a', '#5b7a3a', '#e7d9a8'] },
      { title: 'Risotto aux champignons', time: '40 min', level: 'Moyen', colors: ['#e9dcc0', '#a4865c', '#6b8f4e'] },
      { title: 'Crumble poire-noisette', time: '50 min', level: 'Facile', colors: ['#e8c48c', '#b98552', '#f2e6c9'] },
      { title: 'Gratin de légumes d’hiver', time: '1 h', level: 'Moyen', colors: ['#f0a64a', '#c55f2e', '#f6d9a0'] },
      { title: 'Soupe de poireaux', time: '30 min', level: 'Facile', colors: ['#b9d27a', '#7fa046', '#f0f0d8'] }
    ]
  },
  en: {
    nav: ['Recipes', 'In season', 'Saved'],
    search: 'A recipe, an ingredient',
    lead: 'Simple dishes with what the market has right now.',
    featured: 'Velvety squash soup',
    featuredMeta: '35 min · Easy · Serves 4',
    ingredients: 'Ingredients',
    list: ['1 red kuri squash', '2 shallots', '2 cups stock', '½ cup cream', 'Nutmeg, salt, pepper'],
    more: 'This week',
    recipes: [
      { title: 'Thin apple tart', time: '45 min', level: 'Easy', colors: ['#f4c26b', '#d98a3a', '#f7e4b8'] },
      { title: 'Lentil salad', time: '25 min', level: 'Easy', colors: ['#8aa65a', '#5b7a3a', '#e7d9a8'] },
      { title: 'Mushroom risotto', time: '40 min', level: 'Medium', colors: ['#e9dcc0', '#a4865c', '#6b8f4e'] },
      { title: 'Pear and hazelnut crumble', time: '50 min', level: 'Easy', colors: ['#e8c48c', '#b98552', '#f2e6c9'] },
      { title: 'Winter vegetable gratin', time: '1 hr', level: 'Medium', colors: ['#f0a64a', '#c55f2e', '#f6d9a0'] },
      { title: 'Leek soup', time: '30 min', level: 'Easy', colors: ['#b9d27a', '#7fa046', '#f0f0d8'] }
    ]
  }
}

/** A dish seen from above: a plate, the food in three colours, a few herbs. */
const plate = (colors: [string, string, string], size: number) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="46" fill="#fbfaf7" stroke="#e7e2d8" stroke-width="2"/><circle cx="50" cy="50" r="34" fill="${colors[2]}"/><circle cx="50" cy="50" r="27" fill="${colors[0]}"/><path d="M30 52c8-14 32-14 40 0-8 10-32 10-40 0Z" fill="${colors[1]}" opacity=".75"/><g fill="#5f8f3e"><ellipse cx="40" cy="40" rx="4" ry="2" transform="rotate(-30 40 40)"/><ellipse cx="60" cy="38" rx="4" ry="2" transform="rotate(25 60 38)"/><ellipse cx="56" cy="62" rx="4" ry="2" transform="rotate(-15 56 62)"/></g></svg>`

function recipesPage(def: PageDef, ctx: PageContext): string {
  const t = RECIPES[ctx.lang]
  const cards = t.recipes.map((r) => `<li class="card recipe"><span class="art" style="background:linear-gradient(135deg, color-mix(in srgb, ${r.colors[0]} 30%, var(--card)), color-mix(in srgb, ${r.colors[1]} 22%, var(--card)))">${plate(r.colors, 112)}</span><b>${esc(r.title)}</b><span class="row"><span class="chip">${esc(r.time)}</span><span class="muted">${esc(r.level)}</span></span></li>`).join('')
  return htmlPage(def, ctx, {
    brand: ctx.lang === 'fr' ? 'Recettes' : 'Recipes',
    nav: t.nav,
    search: t.search,
    css: `.feature { display: grid; grid-template-columns: minmax(180px, 280px) 1fr; overflow: hidden; margin-bottom: 26px; }
.feature .art { display: grid; place-items: center; padding: 22px; background: linear-gradient(135deg, color-mix(in srgb, #f0a64a 34%, var(--card)), color-mix(in srgb, #e0683a 26%, var(--card))); }
.feature .text { padding: 24px 28px; }
.feature h2 { font-size: 24px; margin: 0 0 4px; letter-spacing: -.02em; }
.feature ul { margin: 14px 0 0; padding: 0; list-style: none; columns: 2; column-gap: 24px; }
.feature li { padding: 4px 0 4px 16px; position: relative; break-inside: avoid; }
.feature li::before { content: ""; position: absolute; left: 0; top: .78em; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }
.recipes { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 16px; }
.recipe { padding: 10px 10px 14px; display: grid; gap: 8px; }
.recipe .art { display: grid; place-items: center; height: 140px; border-radius: 10px; }
.recipe b { margin: 4px 6px 0; }
.recipe .row { margin: 0 6px; }
@media (max-width: 680px) { .feature { grid-template-columns: 1fr; } .feature ul { columns: 1; } }`,
    body: `<main><h1>${esc(def.title[ctx.lang])}</h1><p class="lead">${esc(t.lead)}</p>
<section class="card feature"><span class="art">${plate(['#f0a64a', '#c55f2e', '#f6d9a0'], 190)}</span><div class="text"><span class="chip">${ctx.lang === 'fr' ? 'Recette du jour' : 'Recipe of the day'}</span><h2 style="margin-top:12px">${esc(t.featured)}</h2><p class="muted" style="margin:0">${esc(t.featuredMeta)}</p><h3 style="margin:18px 0 0;font-size:14px">${esc(t.ingredients)}</h3><ul>${t.list.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></div></section>
<h2>${esc(t.more)}</h2><ul class="recipes">${cards}</ul></main>`
  })
}

// ---------- museum ----------

const MUSEUM: L<{ brand: string; nav: string[]; search: string; open: string; hoursTitle: string; hours: Array<[string, string]>; pricesTitle: string; prices: Array<[string, string]>; showsTitle: string; shows: Array<[string, string, [string, string]]>; access: string; accessText: string }> = {
  fr: {
    brand: 'Musée',
    nav: ['Visiter', 'Expositions', 'Collections'],
    search: 'Rechercher une œuvre',
    open: 'Ouvert aujourd’hui · jusqu’à 18 h',
    hoursTitle: 'Horaires',
    hours: [['Lundi', 'Fermé'], ['Mardi – vendredi', '10 h – 18 h'], ['Jeudi (nocturne)', '10 h – 21 h'], ['Samedi – dimanche', '10 h – 19 h']],
    pricesTitle: 'Tarifs',
    prices: [['Plein tarif', '12 €'], ['Tarif réduit', '8 €'], ['Moins de 18 ans', 'Gratuit']],
    showsTitle: 'En ce moment',
    shows: [['Cartes et boussoles', 'Jusqu’au printemps', ['#2f9fb3', '#e8a33d']], ['Le bleu des estampes', 'Galerie est', ['#3f63c7', '#9fc3ef']], ['Objets de tous les jours', 'Collection permanente', ['#b5643c', '#f0c98c']]],
    access: 'Accès',
    accessText: 'Tram, arrêt « Musée ». Vestiaire et parc à vélos à l’entrée, accès de plain-pied.'
  },
  en: {
    brand: 'Museum',
    nav: ['Visit', 'Exhibitions', 'Collections'],
    search: 'Search the collection',
    open: 'Open today · until 6 PM',
    hoursTitle: 'Opening hours',
    hours: [['Monday', 'Closed'], ['Tuesday – Friday', '10 AM – 6 PM'], ['Thursday (late)', '10 AM – 9 PM'], ['Saturday – Sunday', '10 AM – 7 PM']],
    pricesTitle: 'Admission',
    prices: [['Adults', '€12'], ['Reduced', '€8'], ['Under 18', 'Free']],
    showsTitle: 'Now showing',
    shows: [['Maps and compasses', 'Until spring', ['#2f9fb3', '#e8a33d']], ['The blue of prints', 'East gallery', ['#3f63c7', '#9fc3ef']], ['Everyday objects', 'Permanent collection', ['#b5643c', '#f0c98c']]],
    access: 'Getting here',
    accessText: 'Tram, “Museum” stop. Cloakroom and bike racks at the entrance, step-free access.'
  }
}

const ARCHES = `<svg viewBox="0 0 1000 170" preserveAspectRatio="xMidYMid slice" width="100%" height="100%" aria-hidden="true"><defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#cdb9ef"/><stop offset="1" stop-color="#f3e3cf"/></linearGradient></defs><rect width="1000" height="170" fill="url(#sky)"/><circle cx="830" cy="58" r="28" fill="#fbe7b2"/><path d="M0 170c120-26 220-22 330-8h340c110-14 210-18 330 8Z" fill="#e7d3bf"/><path d="M318 56 500 16l182 40Z" fill="#8f6fd0"/><rect x="310" y="56" width="380" height="14" rx="3" fill="#6a49ad"/><g fill="#7d5bbf"><path d="M330 162V108a32 32 0 0 1 64 0v54h-14v-52a18 18 0 0 0-36 0v52Z"/><path d="M418 162V108a32 32 0 0 1 64 0v54h-14v-52a18 18 0 0 0-36 0v52Z"/><path d="M518 162V108a32 32 0 0 1 64 0v54h-14v-52a18 18 0 0 0-36 0v52Z"/><path d="M606 162V108a32 32 0 0 1 64 0v54h-14v-52a18 18 0 0 0-36 0v52Z"/></g><rect x="300" y="160" width="400" height="10" rx="2" fill="#6a49ad"/></svg>`

function museumPage(def: PageDef, ctx: PageContext): string {
  const t = MUSEUM[ctx.lang]
  const table = (rows: Array<[string, string]>) => `<dl>${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`
  const shows = t.shows.map(([title, where, [a, b]]) => `<li class="card show"><span class="art" style="background:radial-gradient(circle at 30% 35%, ${b} 0 18%, transparent 20%), radial-gradient(circle at 70% 60%, ${a} 0 26%, transparent 28%), linear-gradient(135deg, color-mix(in srgb, ${a} 30%, var(--card)), color-mix(in srgb, ${b} 30%, var(--card)))"></span><b>${esc(title)}</b><span class="muted">${esc(where)}</span></li>`).join('')
  return htmlPage(def, ctx, {
    brand: t.brand,
    nav: t.nav,
    search: t.search,
    css: `.banner { height: 170px; border-radius: 16px; overflow: hidden; margin-bottom: 22px; }
.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; align-items: start; }
.cols .card { padding: 18px 20px; }
.cols h2 { margin: 0 0 10px; }
dl { margin: 0; display: grid; }
dl div { display: flex; justify-content: space-between; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--line); }
dl div:last-child { border-bottom: 0; }
dt { color: var(--muted); }
dd { margin: 0; font-weight: 600; }
.shows { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 16px; }
.show { padding: 10px 10px 14px; display: grid; gap: 4px; }
.show .art { height: 110px; border-radius: 10px; margin-bottom: 6px; }
.show b, .show span { margin: 0 6px; }
@media (prefers-color-scheme: dark) { .banner { filter: brightness(.8) saturate(.9); } }`,
    body: `<main><div class="banner">${ARCHES}</div><div class="row" style="justify-content:space-between"><h1>${esc(def.title[ctx.lang])}</h1><span class="chip" style="--c:#3fa66b">${esc(t.open)}</span></div>
<div class="cols" style="margin-top:18px"><section class="card"><h2>${esc(t.hoursTitle)}</h2>${table(t.hours)}</section><section class="card"><h2>${esc(t.pricesTitle)}</h2>${table(t.prices)}<h2 style="margin-top:18px">${esc(t.access)}</h2><p class="muted" style="margin:0">${esc(t.accessText)}</p></section></div>
<h2>${esc(t.showsTitle)}</h2><ul class="shows">${shows}</ul></main>`
  })
}

// ---------- week planner ----------

const AGENDA: L<{ nav: string[]; search: string; week: string; days: string[]; events: Array<[number, number, number, string, string]> }> = {
  fr: {
    nav: ['Semaine', 'Mois', 'Tâches'],
    search: 'Rechercher un rendez-vous',
    week: 'Cette semaine',
    days: ['Lun. 9', 'Mar. 10', 'Mer. 11', 'Jeu. 12', 'Ven. 13'],
    events: [[0, 9, 1, 'Point d’équipe', '#4c7cf0'], [0, 14, 2, 'Atelier écriture', '#e8a33d'], [1, 10, 1.5, 'Revue du tableau', '#8a63d2'], [2, 12.5, 1, 'Déjeuner', '#3fa66b'], [3, 9.5, 2.5, 'Atelier Mosaïque', '#d2508a'], [3, 17, 1, 'Sport', '#18a589'], [4, 11, 1, 'Démo de la semaine', '#4c7cf0'], [4, 15, 1.5, 'Rangement', '#e0683a']]
  },
  en: {
    nav: ['Week', 'Month', 'Tasks'],
    search: 'Search events',
    week: 'This week',
    days: ['Mon 9', 'Tue 10', 'Wed 11', 'Thu 12', 'Fri 13'],
    events: [[0, 9, 1, 'Team check-in', '#4c7cf0'], [0, 14, 2, 'Writing workshop', '#e8a33d'], [1, 10, 1.5, 'Board review', '#8a63d2'], [2, 12.5, 1, 'Lunch', '#3fa66b'], [3, 9.5, 2.5, 'Mosaic workshop', '#d2508a'], [3, 17, 1, 'Exercise', '#18a589'], [4, 11, 1, 'Weekly demo', '#4c7cf0'], [4, 15, 1.5, 'Tidy-up', '#e0683a']]
  }
}

function agendaPage(def: PageDef, ctx: PageContext): string {
  const t = AGENDA[ctx.lang]
  const first = 8
  const last = 19
  const rows = (last - first) * 2
  const hours = Array.from({ length: last - first }, (_, i) => `<span class="h" style="grid-row:${i * 2 + 2}">${ctx.lang === 'fr' ? `${first + i} h` : `${((first + i - 1) % 12) + 1} ${first + i < 12 ? 'AM' : 'PM'}`}</span>`).join('')
  const lines = Array.from({ length: last - first }, (_, i) => `<span class="line" style="grid-row:${i * 2 + 2}"></span>`).join('')
  const events = t.events.map(([day, start, length, title, color]) => `<span class="ev" style="--c:${color};grid-column:${day + 2};grid-row:${Math.round((start - first) * 2) + 2} / span ${Math.round(length * 2)}"><b>${esc(title)}</b><small>${ctx.lang === 'fr' ? `${Math.floor(start)} h${start % 1 ? ' 30' : ''}` : `${((Math.floor(start) - 1) % 12) + 1}:${start % 1 ? '30' : '00'}`}</small></span>`).join('')
  return htmlPage(def, ctx, {
    brand: ctx.lang === 'fr' ? 'Agenda' : 'Calendar',
    nav: t.nav,
    search: t.search,
    css: `.cal { padding: 14px 16px 18px; display: grid; grid-template-columns: 52px repeat(5, 1fr); grid-template-rows: 34px repeat(${rows}, 22px); column-gap: 8px; }
.day { grid-row: 1; font-weight: 600; font-size: 13.5px; text-align: center; align-self: center; }
.day.today { color: var(--accent); }
.h { grid-column: 1; font-size: 11.5px; color: var(--muted); transform: translateY(-8px); }
.line { grid-column: 2 / -1; border-top: 1px solid var(--line); }
.ev { margin: 2px 0; border-radius: 9px; padding: 6px 9px; background: color-mix(in srgb, var(--c) 18%, var(--card)); border-left: 3px solid var(--c); display: grid; align-content: start; overflow: hidden; z-index: 1; }
.ev b { font-size: 12.5px; line-height: 1.25; color: color-mix(in srgb, var(--c) 70%, var(--ink)); }
.ev small { font-size: 11px; color: var(--muted); }`,
    body: `<main><h1>${esc(t.week)}</h1><p class="lead">${esc(def.title[ctx.lang])}</p><section class="card cal">${t.days.map((d, i) => `<span class="day${i === 3 ? ' today' : ''}" style="grid-column:${i + 2}">${esc(d)}</span>`).join('')}${hours}${lines}${events}</section></main>`
  })
}

// ---------- lists ----------

const LISTS: Readonly<Record<string, L<{ brand: string; lead: string; groups: Array<{ title: string; items: Array<[boolean, string]> }> }>>> = {
  groceries: {
    fr: { brand: 'Courses', lead: 'Pour le marché de samedi et la semaine.', groups: [
      { title: 'Primeur', items: [[true, 'Pommes'], [true, 'Potimarron'], [false, 'Poireaux'], [false, 'Citrons']] },
      { title: 'Épicerie', items: [[false, 'Lentilles vertes'], [true, 'Farine'], [false, 'Noix']] },
      { title: 'Frais', items: [[false, 'Yaourts'], [false, 'Beurre'], [true, 'Œufs']] }
    ] },
    en: { brand: 'Groceries', lead: 'For Saturday’s market and the week ahead.', groups: [
      { title: 'Produce', items: [[true, 'Apples'], [true, 'Squash'], [false, 'Leeks'], [false, 'Lemons']] },
      { title: 'Pantry', items: [[false, 'Green lentils'], [true, 'Flour'], [false, 'Walnuts']] },
      { title: 'Dairy', items: [[false, 'Yoghurt'], [false, 'Butter'], [true, 'Eggs']] }
    ] }
  },
  'agenda-items': {
    fr: { brand: 'Carnet', lead: 'Atelier Mosaïque · une heure trente.', groups: [
      { title: 'Ouverture', items: [[true, 'Tour de table'], [true, 'Objectifs de la semaine']] },
      { title: 'Sujets', items: [[false, 'Maquettes de l’accueil'], [false, 'Palette sombre'], [false, 'Textes de la page d’aide']] },
      { title: 'Pour finir', items: [[false, 'Qui fait quoi'], [false, 'Date de la démo']] }
    ] },
    en: { brand: 'Notebook', lead: 'Mosaic workshop · ninety minutes.', groups: [
      { title: 'Opening', items: [[true, 'Round of introductions'], [true, 'Goals for the week']] },
      { title: 'Topics', items: [[false, 'Home page mock-ups'], [false, 'Dark palette'], [false, 'Help page copy']] },
      { title: 'Wrap-up', items: [[false, 'Who does what'], [false, 'Demo date']] }
    ] }
  },
  weekend: {
    fr: { brand: 'Carnet', lead: 'Rien d’obligatoire, tout est facultatif.', groups: [
      { title: 'Samedi', items: [[true, 'Marché du matin'], [false, 'Balade au bord de l’eau'], [false, 'Atelier pain']] },
      { title: 'Dimanche', items: [[false, 'Ranger le balcon'], [false, 'Lire au soleil'], [false, 'Appeler la famille']] }
    ] },
    en: { brand: 'Notebook', lead: 'Nothing required, everything optional.', groups: [
      { title: 'Saturday', items: [[true, 'Morning market'], [false, 'Walk by the water'], [false, 'Bread workshop']] },
      { title: 'Sunday', items: [[false, 'Tidy the balcony'], [false, 'Read in the sun'], [false, 'Call the family']] }
    ] }
  }
}

function checklistPage(def: PageDef, ctx: PageContext): string {
  const t = (LISTS[def.key] ?? LISTS['groceries']!)[ctx.lang]
  const groups = t.groups.map((g) => `<section class="card group"><h2>${esc(g.title)}<span>${g.items.filter(([done]) => done).length}/${g.items.length}</span></h2><ul>${g.items.map(([done, text]) => `<li>${checkbox(done)}<span class="text">${esc(text)}</span></li>`).join('')}</ul></section>`).join('')
  return htmlPage(def, ctx, {
    brand: t.brand,
    nav: ctx.lang === 'fr' ? ['Listes', 'Partagées', 'Archives'] : ['Lists', 'Shared', 'Archive'],
    search: ctx.lang === 'fr' ? 'Rechercher dans les listes' : 'Search lists',
    css: `${CHECK_CSS}
.groups { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; align-items: start; }
.group { padding: 16px 18px; }
.group h2 { margin: 0 0 10px; display: flex; justify-content: space-between; }
.group h2 span { color: var(--muted); font-weight: 500; font-size: 13px; }
.group ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.group li { display: flex; gap: 10px; align-items: center; }`,
    body: `<main><h1>${esc(def.title[ctx.lang])}</h1><p class="lead">${esc(t.lead)}</p><div class="groups">${groups}</div></main>`
  })
}

// ---------- library ----------

const BOOKS: L<{ brand: string; nav: string[]; search: string; lead: string; books: Array<[string, string, string, string]> }> = {
  fr: {
    brand: 'Bibliothèque',
    nav: ['Nouveautés', 'Catalogue', 'Mes prêts'],
    search: 'Titre, sujet, collection',
    lead: 'Arrivés ce mois-ci, à réserver en ligne ou à l’accueil.',
    books: [['Le jardin des heures', 'Roman', '#3f7d6b', '#f2d48f'], ['Sous la même lune', 'Roman', '#2c3e7a', '#e7c46b'], ['Atlas des vents', 'Essai', '#7a8fa8', '#f4f1ea'], ['La maison aux volets bleus', 'Jeunesse', '#4c8fe8', '#fef3d6'], ['Petit traité de la marche', 'Essai', '#b5643c', '#f5e3cc'], ['Les couleurs du matin', 'Poésie', '#e0683a', '#fde7c9'], ['Cuisiner les saisons', 'Pratique', '#5f8f3e', '#eef3d9'], ['Carnets de traversée', 'Voyage', '#2f9fb3', '#e3f4f6']]
  },
  en: {
    brand: 'Library',
    nav: ['New', 'Catalogue', 'My loans'],
    search: 'Title, subject, series',
    lead: 'Arrived this month: reserve online or at the front desk.',
    books: [['The Garden of Hours', 'Novel', '#3f7d6b', '#f2d48f'], ['Under the Same Moon', 'Novel', '#2c3e7a', '#e7c46b'], ['An Atlas of Winds', 'Essay', '#7a8fa8', '#f4f1ea'], ['The House with Blue Shutters', 'Children', '#4c8fe8', '#fef3d6'], ['A Short Treatise on Walking', 'Essay', '#b5643c', '#f5e3cc'], ['Colours of the Morning', 'Poetry', '#e0683a', '#fde7c9'], ['Cooking the Seasons', 'Practical', '#5f8f3e', '#eef3d9'], ['Crossing Notebooks', 'Travel', '#2f9fb3', '#e3f4f6']]
  }
}

function libraryPage(def: PageDef, ctx: PageContext): string {
  const t = BOOKS[ctx.lang]
  const books = t.books.map(([title, genre, a, b], i) => `<li><span class="cover" style="background:linear-gradient(160deg, ${a}, color-mix(in srgb, ${a} 70%, #000))"><span class="shape" style="background:${b};${i % 2 ? 'border-radius:50%' : 'border-radius:4px 40px 4px 40px'}"></span><b style="color:${b}">${esc(title)}</b></span><span class="t">${esc(title)}</span><span class="muted">${esc(genre)}</span></li>`).join('')
  return htmlPage(def, ctx, {
    brand: t.brand,
    nav: t.nav,
    search: t.search,
    css: `.books { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 22px 18px; }
.books li { display: grid; gap: 3px; font-size: 13.5px; }
.cover { aspect-ratio: 2 / 3; border-radius: 6px 10px 10px 6px; box-shadow: var(--shadow), inset 6px 0 0 rgb(0 0 0 / .15); padding: 14px; display: grid; align-content: space-between; margin-bottom: 8px; }
.cover .shape { width: 46px; height: 46px; opacity: .9; }
.cover b { font-size: 15px; line-height: 1.2; font-family: Georgia, "Times New Roman", serif; }
.t { font-weight: 600; }`,
    body: `<main><h1>${esc(def.title[ctx.lang])}</h1><p class="lead">${esc(t.lead)}</p><ul class="books">${books}</ul></main>`
  })
}

// ---------- trip ----------

const TRIP: L<{ brand: string; lead: string; days: Array<[string, string, string]> }> = {
  fr: {
    brand: 'Escapades',
    lead: 'À pied et à vélo, au rythme des marées.',
    days: [['Jour 1', 'Le port et les remparts', 'Arrivée en fin de matinée, tour du port, dîner face à la mer.'], ['Jour 2', 'Le sentier de la pointe', 'Douze kilomètres sur la falaise, pique-nique au phare.'], ['Jour 3', 'Les dunes et la plage', 'Vélo jusqu’aux dunes, baignade si le temps le permet.']]
  },
  en: {
    brand: 'Getaways',
    lead: 'On foot and by bike, at the pace of the tides.',
    days: [['Day 1', 'The harbour and the old walls', 'Arrive late morning, walk around the harbour, dinner by the sea.'], ['Day 2', 'The headland trail', 'Seven miles along the cliffs, picnic by the lighthouse.'], ['Day 3', 'The dunes and the beach', 'Cycle to the dunes, a swim if the weather allows.']]
  }
}

const MAP = `<svg viewBox="0 0 640 300" width="100%" height="100%" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><rect width="640" height="300" fill="#bfe3ea"/><path d="M0 300V120c60-10 90 30 150 20s80-60 150-50 90 60 160 40 90-70 180-60v230Z" fill="#efe6cf"/><path d="M0 300V170c70-5 110 25 170 15s90-45 160-35 100 50 170 30 80-40 140-30v150Z" fill="#cfe2b0"/><path d="M90 205C170 150 230 190 300 140S440 110 520 80" fill="none" stroke="#e0683a" stroke-width="4" stroke-dasharray="2 10" stroke-linecap="round"/><g font-family="-apple-system, sans-serif" font-size="13" font-weight="700" fill="#fff"><circle cx="90" cy="205" r="15" fill="#2f9fb3"/><text x="90" y="210" text-anchor="middle">1</text><circle cx="300" cy="140" r="15" fill="#2f9fb3"/><text x="300" y="145" text-anchor="middle">2</text><circle cx="520" cy="80" r="15" fill="#2f9fb3"/><text x="520" y="85" text-anchor="middle">3</text></g><path d="M560 210l8-22 8 22Z" fill="#fff"/><rect x="565" y="210" width="6" height="18" fill="#fff"/></svg>`

function tripPage(def: PageDef, ctx: PageContext): string {
  const t = TRIP[ctx.lang]
  return htmlPage(def, ctx, {
    brand: t.brand,
    nav: ctx.lang === 'fr' ? ['Itinéraires', 'Hébergements', 'Carnet'] : ['Itineraries', 'Stays', 'Journal'],
    search: ctx.lang === 'fr' ? 'Rechercher une escapade' : 'Search getaways',
    css: `.map { height: 260px; border-radius: 16px; overflow: hidden; margin: 6px 0 20px; }
.days { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
.days li { padding: 16px 18px; display: grid; gap: 4px; }
.days b { font-size: 16px; }
@media (prefers-color-scheme: dark) { .map { filter: brightness(.78) saturate(.9); } }`,
    body: `<main><h1>${esc(def.title[ctx.lang])}</h1><p class="lead">${esc(t.lead)}</p><div class="map">${MAP}</div><ul class="days">${t.days.map(([day, title, text]) => `<li class="card"><span class="chip">${esc(day)}</span><b>${esc(title)}</b><span class="muted">${esc(text)}</span></li>`).join('')}</ul></main>`
  })
}

// ---------- articles ----------

const ARTICLES: Readonly<Record<string, L<{ brand: string; kicker: string; lead: string; sections: Array<[string, string]>; note: string }>>> = {
  'style-guide': {
    fr: { brand: 'Docs Mosaïque', kicker: 'Rédaction', lead: 'Quelques règles pour que toutes les pages parlent de la même voix.', sections: [['Des phrases courtes', 'Une idée par phrase. Le verbe au début, les détails ensuite. On écrit pour quelqu’un qui lit vite.'], ['Les mots de tous les jours', 'On préfère « enregistrer » à « persister », « page » à « vue ». Un terme technique est expliqué la première fois.'], ['Les titres', 'Un titre dit ce que l’on trouve dans la section, sans jeu de mots. Pas de point final.']], note: 'Dans le doute, lire la phrase à voix haute.' },
    en: { brand: 'Mosaic Docs', kicker: 'Writing', lead: 'A few rules so that every page speaks with the same voice.', sections: [['Short sentences', 'One idea per sentence. The verb first, the details after. We write for someone reading fast.'], ['Everyday words', 'We prefer “save” to “persist”, “page” to “view”. A technical term is explained the first time.'], ['Headings', 'A heading says what the section holds, without puns. No full stop.']], note: 'When in doubt, read the sentence out loud.' }
  },
  glossary: {
    fr: { brand: 'Docs Mosaïque', kicker: 'Référence', lead: 'Les mots du projet, et ce qu’ils veulent dire ici.', sections: [['Espace', 'Un ensemble d’onglets pour un sujet : le travail, la maison, un projet.'], ['Onglet épinglé', 'Une page que l’on garde d’un jour à l’autre, en haut de la barre latérale.'], ['Onglet du jour', 'Une page ouverte pour le moment, rangée automatiquement plus tard.']], note: 'Un mot manque ? Ajoutez-le en bas de la page.' },
    en: { brand: 'Mosaic Docs', kicker: 'Reference', lead: 'The words of the project, and what they mean here.', sections: [['Space', 'A set of tabs for one subject: work, home, a project.'], ['Pinned tab', 'A page you keep from one day to the next, at the top of the sidebar.'], ['Today tab', 'A page open for now, tidied away automatically later.']], note: 'A word is missing? Add it at the bottom of the page.' }
  },
  naming: {
    fr: { brand: 'Lectures', kicker: 'Organisation', lead: 'Des noms clairs aujourd’hui, des fichiers retrouvés demain.', sections: [['Commencer par la date', 'Une date au format année-mois-jour trie les fichiers dans l’ordre, quel que soit le système.'], ['Dire ce que c’est', '« devis-cuisine » se comprend dans six mois ; « document-final-2 » ne se comprend jamais.'], ['Éviter les espaces', 'Un tiret entre les mots : le nom passe partout, dans une adresse comme dans un courriel.']], note: 'Exemple : 2026-03-14-devis-cuisine.pdf' },
    en: { brand: 'Reading', kicker: 'Organising', lead: 'Clear names today, files you can find tomorrow.', sections: [['Start with the date', 'A year-month-day date sorts files in order, whatever the system.'], ['Say what it is', '“kitchen-quote” still makes sense in six months; “final-document-2” never does.'], ['Avoid spaces', 'A hyphen between words: the name works everywhere, in an address as in an email.']], note: 'Example: 2026-03-14-kitchen-quote.pdf' }
  },
  shelf: {
    fr: { brand: 'Atelier bois', kicker: 'Bricolage', lead: 'Une planche, deux équerres et une après-midi.', sections: [['Le matériel', 'Une planche de chêne de 80 cm, deux équerres, des chevilles adaptées au mur, un niveau.'], ['Tracer', 'Repérer la hauteur, tracer une ligne au niveau, marquer les trous des équerres.'], ['Fixer', 'Percer, cheviller, visser les équerres, puis poser la planche et la fixer par-dessous.']], note: 'Compter deux heures, finitions comprises.' },
    en: { brand: 'Woodshop', kicker: 'DIY', lead: 'One board, two brackets and an afternoon.', sections: [['What you need', 'An oak board of 30 inches, two brackets, wall plugs suited to the wall, a spirit level.'], ['Mark out', 'Find the height, draw a level line, mark the holes of the brackets.'], ['Fix', 'Drill, plug, screw the brackets, then lay the board and fix it from below.']], note: 'Allow two hours, finishing included.' }
  },
  // The article the reader mode shows (shot `reader-mode`): long enough for the extraction of the reader, several sections of a few sentences.
  maps: {
    fr: {
      brand: 'Lectures',
      kicker: 'Histoire',
      lead: 'Bien avant les itinéraires calculés, les cartes racontaient le monde tel qu’on l’imaginait.',
      sections: [
        ['Dessiner ce que l’on ignore', 'Les premiers cartographes remplissaient les blancs avec ce qu’on leur avait raconté : des côtes devinées, des fleuves qui changeaient de cours d’une édition à l’autre, des montagnes placées au jugé. Une carte disait autant ce que l’on savait que ce que l’on espérait trouver.'],
        ['Le temps des relevés', 'Avec les instruments de visée et les longues campagnes de triangulation, la carte devient une mesure. On compte les pas, on note les angles, on recommence quand le temps couvre l’horizon. Une seule feuille demande parfois des années de marche.'],
        ['Lire une carte ancienne', 'Une carte ancienne se lit lentement. Les marges portent les noms de ceux qui l’ont faite, les légendes expliquent les signes, et les erreurs elles-mêmes renseignent sur les routes que l’on empruntait et sur celles que l’on évitait.'],
        ['Ce qu’il en reste', 'Nos cartes d’aujourd’hui se mettent à jour toutes seules, mais elles héritent de ces choix : ce que l’on montre, ce que l’on tait, et l’échelle à laquelle on regarde un lieu. Ouvrir un vieil atlas, c’est retrouver ces choix à l’œil nu.']
      ],
      note: 'À voir : l’exposition des atlas de la bibliothèque, jusqu’à la fin du mois.'
    },
    en: {
      brand: 'Reading',
      kicker: 'History',
      lead: 'Long before routes were computed, maps told the world as people imagined it.',
      sections: [
        ['Drawing what you do not know', 'The first mapmakers filled the blanks with what they had been told: guessed coastlines, rivers that changed course from one edition to the next, mountains placed by eye. A map said as much about what was known as about what people hoped to find.'],
        ['The age of surveys', 'With sighting instruments and long campaigns of triangulation, the map became a measurement. Steps were counted, angles noted, and the work started again when the weather hid the horizon. A single sheet could take years of walking.'],
        ['Reading an old map', 'An old map is read slowly. Its margins carry the names of those who made it, its legends explain the signs, and its very mistakes tell of the roads people took and of the ones they avoided.'],
        ['What remains', 'Our maps now update themselves, yet they inherit those choices: what is shown, what is left out, and the scale at which a place is seen. Opening an old atlas is finding those choices with the naked eye.']
      ],
      note: 'Worth a visit: the atlas exhibition at the library, until the end of the month.'
    }
  }
}

function articlePage(def: PageDef, ctx: PageContext): string {
  const t = (ARTICLES[def.key] ?? ARTICLES['style-guide']!)[ctx.lang]
  return htmlPage(def, ctx, {
    brand: t.brand,
    nav: ctx.lang === 'fr' ? ['Articles', 'Guides', 'À propos'] : ['Articles', 'Guides', 'About'],
    search: ctx.lang === 'fr' ? 'Rechercher un article' : 'Search articles',
    css: `article { max-width: 720px; margin: 0 auto; }
.kicker { text-transform: uppercase; letter-spacing: .08em; font-size: 12px; font-weight: 700; color: var(--accent); }
article h1 { font-size: 36px; margin-top: 6px; }
article h2 { font-size: 20px; margin-top: 30px; }
article p { font-size: 16.5px; line-height: 1.7; margin: 0 0 12px; }
.figure { height: 150px; border-radius: 16px; margin: 22px 0 6px; background: radial-gradient(circle at 18% 40%, color-mix(in srgb, var(--accent) 60%, transparent) 0 14%, transparent 16%), radial-gradient(circle at 60% 70%, color-mix(in srgb, var(--accent) 35%, transparent) 0 22%, transparent 24%), linear-gradient(120deg, color-mix(in srgb, var(--accent) 22%, var(--card)), var(--soft)); }
.note { margin-top: 26px; padding: 14px 18px; border-radius: 12px; background: color-mix(in srgb, var(--accent) 10%, transparent); border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent); }`,
    body: `<main><article><span class="kicker">${esc(t.kicker)}</span><h1>${esc(def.title[ctx.lang])}</h1><p class="lead">${esc(t.lead)}</p><div class="figure"></div>${t.sections.map(([h, p]) => `<h2>${esc(h)}</h2><p>${esc(p)}</p>`).join('')}<p class="note">${esc(t.note)}</p></article></main>`
  })
}

// ---------- sowing calendar ----------

const SOWING: L<{ lead: string; months: string[]; legend: [string, string]; rows: Array<[string, [number, number], [number, number]]> }> = {
  fr: {
    lead: 'Quand semer, quand récolter, mois par mois.',
    months: ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'],
    legend: ['Semis', 'Récolte'],
    rows: [['Tomates', [2, 4], [6, 9]], ['Radis', [2, 8], [3, 9]], ['Carottes', [2, 6], [5, 10]], ['Laitues', [1, 8], [3, 10]], ['Courgettes', [3, 5], [5, 9]], ['Haricots', [4, 6], [6, 9]], ['Poireaux', [1, 4], [8, 11]]]
  },
  en: {
    lead: 'When to sow, when to harvest, month by month.',
    months: ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'],
    legend: ['Sowing', 'Harvest'],
    rows: [['Tomatoes', [2, 4], [6, 9]], ['Radishes', [2, 8], [3, 9]], ['Carrots', [2, 6], [5, 10]], ['Lettuce', [1, 8], [3, 10]], ['Courgettes', [3, 5], [5, 9]], ['Beans', [4, 6], [6, 9]], ['Leeks', [1, 4], [8, 11]]]
  }
}

function sowingPage(def: PageDef, ctx: PageContext): string {
  const t = SOWING[ctx.lang]
  const bar = ([from, to]: [number, number], kind: string) => `<i class="${kind}" style="grid-column:${from + 2} / ${to + 3}"></i>`
  const rows = t.rows.map(([name, sow, crop], i) => `<span class="name" style="grid-row:${i + 2}">${esc(name)}</span><span class="track" style="grid-row:${i + 2}">${bar(sow, 'sow')}${bar(crop, 'crop')}</span>`).join('')
  return htmlPage(def, ctx, {
    brand: ctx.lang === 'fr' ? 'Potager' : 'Kitchen garden',
    nav: ctx.lang === 'fr' ? ['Calendrier', 'Fiches', 'Carnet'] : ['Calendar', 'Plants', 'Journal'],
    search: ctx.lang === 'fr' ? 'Rechercher une plante' : 'Search plants',
    css: `.table { padding: 16px 18px; display: grid; grid-template-columns: 110px repeat(12, 1fr); row-gap: 8px; column-gap: 4px; }
.m { grid-row: 1; text-align: center; font-size: 12px; color: var(--muted); font-weight: 600; }
.name { grid-column: 1; font-weight: 600; font-size: 14px; align-self: center; }
.track { grid-column: 2 / -1; display: grid; grid-template-columns: repeat(12, 1fr); grid-template-rows: 12px 12px; gap: 3px 4px; padding: 4px 0; border-radius: 8px; background: var(--soft); }
.track i { border-radius: 99px; }
.sow { grid-row: 1; background: #6fb3f2; }
.crop { grid-row: 2; background: #47a85a; }
.legend { display: flex; gap: 18px; margin-top: 14px; color: var(--muted); font-size: 13px; }
.legend span::before { content: ""; display: inline-block; width: 22px; height: 8px; border-radius: 99px; margin-right: 8px; vertical-align: middle; background: var(--c); }`,
    body: `<main><h1>${esc(def.title[ctx.lang])}</h1><p class="lead">${esc(t.lead)}</p><section class="card table">${t.months.map((m, i) => `<span class="m" style="grid-column:${i + 2}">${esc(m)}</span>`).join('')}${rows}</section><div class="legend"><span style="--c:#6fb3f2">${esc(t.legend[0])}</span><span style="--c:#47a85a">${esc(t.legend[1])}</span></div></main>`
  })
}

// ---------- roadmap ----------

const ROADMAP: L<{ lead: string; quarters: string[]; rows: Array<[string, number, number, string]> }> = {
  fr: {
    lead: 'Les grandes étapes de l’année, trimestre par trimestre.',
    quarters: ['Hiver', 'Printemps', 'Été', 'Automne'],
    rows: [['Recherche', 0, 1.2, '#8a63d2'], ['Maquettes', 0.8, 2, '#d2508a'], ['Développement', 1.5, 3.3, '#4c7cf0'], ['Essais', 2.6, 3.6, '#18a589'], ['Lancement', 3.4, 4, '#e8a33d']]
  },
  en: {
    lead: 'The milestones of the year, season by season.',
    quarters: ['Winter', 'Spring', 'Summer', 'Autumn'],
    rows: [['Research', 0, 1.2, '#8a63d2'], ['Mock-ups', 0.8, 2, '#d2508a'], ['Development', 1.5, 3.3, '#4c7cf0'], ['Testing', 2.6, 3.6, '#18a589'], ['Launch', 3.4, 4, '#e8a33d']]
  }
}

function roadmapPage(def: PageDef, ctx: PageContext): string {
  const t = ROADMAP[ctx.lang]
  const rows = t.rows.map(([name, from, to, color]) => `<div class="r"><span>${esc(name)}</span><span class="lane"><i style="--c:${color};left:${(from / 4) * 100}%;width:${((to - from) / 4) * 100}%">${esc(name)}</i></span></div>`).join('')
  return htmlPage(def, ctx, {
    brand: ctx.lang === 'fr' ? 'Mosaïque' : 'Mosaic',
    nav: ctx.lang === 'fr' ? ['Feuille de route', 'Tableau', 'Fichiers'] : ['Roadmap', 'Board', 'Files'],
    search: ctx.lang === 'fr' ? 'Rechercher une étape' : 'Search milestones',
    css: `.road { padding: 18px 20px; }
.qs, .r { display: grid; grid-template-columns: 140px 1fr; gap: 12px; align-items: center; }
.qs > div { display: grid; grid-template-columns: repeat(4, 1fr); }
.qs > div span { font-size: 12.5px; font-weight: 600; color: var(--muted); padding-left: 8px; border-left: 1px solid var(--line); }
.r { margin-top: 12px; }
.r > span:first-child { font-weight: 600; font-size: 14px; }
.lane { position: relative; height: 34px; border-radius: 10px; background: repeating-linear-gradient(90deg, var(--soft) 0 calc(25% - 1px), var(--line) calc(25% - 1px) 25%); }
.lane i { position: absolute; top: 4px; bottom: 4px; border-radius: 8px; background: color-mix(in srgb, var(--c) 85%, transparent); color: #fff; font-style: normal; font-size: 12.5px; font-weight: 600; display: flex; align-items: center; padding: 0 10px; white-space: nowrap; overflow: hidden; }`,
    body: `<main><h1>${esc(def.title[ctx.lang])}</h1><p class="lead">${esc(t.lead)}</p><section class="card road"><div class="qs"><span></span><div>${t.quarters.map((q) => `<span>${esc(q)}</span>`).join('')}</div></div>${rows}</section></main>`
  })
}

// ---------- palette ----------

const PALETTE: L<{ lead: string; swatches: Array<[string, string]> }> = {
  fr: { lead: 'Les couleurs de Mosaïque, de la plus claire à la plus profonde.', swatches: [['Sable', '#f3e3cf'], ['Abricot', '#f0a64a'], ['Corail', '#e0683a'], ['Framboise', '#d2508a'], ['Lavande', '#8a63d2'], ['Océan', '#4c7cf0'], ['Lagon', '#2f9fb3'], ['Sauge', '#47a85a'], ['Encre', '#2c3e7a']] },
  en: { lead: 'The colours of Mosaic, from the lightest to the deepest.', swatches: [['Sand', '#f3e3cf'], ['Apricot', '#f0a64a'], ['Coral', '#e0683a'], ['Raspberry', '#d2508a'], ['Lavender', '#8a63d2'], ['Ocean', '#4c7cf0'], ['Lagoon', '#2f9fb3'], ['Sage', '#47a85a'], ['Ink', '#2c3e7a']] }
}

function palettePage(def: PageDef, ctx: PageContext): string {
  const t = PALETTE[ctx.lang]
  return htmlPage(def, ctx, {
    brand: ctx.lang === 'fr' ? 'Atelier' : 'Studio',
    nav: ctx.lang === 'fr' ? ['Couleurs', 'Typographie', 'Icônes'] : ['Colours', 'Type', 'Icons'],
    search: ctx.lang === 'fr' ? 'Rechercher une couleur' : 'Search colours',
    css: `.sw { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 16px; }
.sw li { padding: 8px 8px 12px; display: grid; gap: 2px; }
.sw .c { height: 96px; border-radius: 10px; margin-bottom: 8px; }
.sw code { font: 12.5px ui-monospace, Menlo, monospace; color: var(--muted); }`,
    body: `<main><h1>${esc(def.title[ctx.lang])}</h1><p class="lead">${esc(t.lead)}</p><ul class="sw">${t.swatches.map(([name, hex]) => `<li class="card"><span class="c" style="background:${hex}"></span><b>${esc(name)}</b><code>${hex}</code></li>`).join('')}</ul></main>`
  })
}

// ---------- a PDF report (shot `pdf-viewer`: the PDF viewer of the engine shows it in its tab) ----------

/** Characters of the text of the report outside ASCII, as Helvetica's WinAnsi encoding numbers them (the Latin-1 ones keep their number). */
const WIN_ANSI: Readonly<Record<string, number>> = { '’': 0x92, '‘': 0x91, '“': 0x93, '”': 0x94, '—': 0x97, '–': 0x96, '…': 0x85, '€': 0x80, ' ': 0xa0 }

/**
 * A string of a content stream, in WinAnsi: the parentheses and the backslash escaped, every byte above 126 written in octal, so that the whole
 * file is ASCII (the server sends it as text). A character WinAnsi does not have throws: the report would show a hole.
 */
export function pdfString(text: string): string {
  let out = '('
  for (const ch of text) {
    const code = WIN_ANSI[ch] ?? ch.codePointAt(0)!
    if (code > 0xff || (code > 0x7e && code < 0xa0 && WIN_ANSI[ch] === undefined)) throw new Error(`pdfString : « ${ch} » n’est pas dans l’encodage WinAnsi`)
    if (ch === '(' || ch === ')' || ch === '\\') out += `\\${ch}`
    else if (code < 0x20 || code > 0x7e) out += `\\${code.toString(8).padStart(3, '0')}`
    else out += ch
  }
  return `${out})`
}

/** A text string of the document's information (its title): UTF-16, big-endian, with its byte order mark, in hexadecimal. */
const pdfTextString = (text: string): string =>
  `<FEFF${[...text].flatMap((ch) => { const code = ch.codePointAt(0)!; return code > 0xffff ? [0xd800 + ((code - 0x10000) >> 10), 0xdc00 + ((code - 0x10000) & 0x3ff)] : [code] }).map((unit) => unit.toString(16).padStart(4, '0').toUpperCase()).join('')}>`

/** `#18a589` as the three fractions of a PDF colour, mixed with `white` parts of white (0: the colour itself). */
const pdfColor = (hex: string, white = 0): string => [1, 3, 5].map((at) => (white + (1 - white) * (parseInt(hex.slice(at, at + 2), 16) / 255)).toFixed(3)).join(' ')

const REPORT: L<{ subtitle: string; figures: Array<[string, string]>; chart: string; months: Array<[string, number]>; sections: Array<[string, string[]]>; foot: string }> = {
  fr: {
    subtitle: 'Bilan pour l’équipe · octobre 2026',
    figures: [['128', 'tâches livrées'], ['+18 %', 'de personnes actives'], ['4,6 / 5', 'de satisfaction']],
    chart: 'Tâches livrées par mois',
    months: [['juil.', 34], ['août', 27], ['sept.', 41], ['oct.', 26]],
    sections: [
      ['Points forts', ['La nouvelle page d’accueil est en ligne depuis septembre.', 'Le thème sombre sort en même temps que le clair.', 'Une démonstration courte chaque vendredi.']],
      ['À suivre', ['Préparer les maquettes du tableau de bord.', 'Relire le guide de style avant la fin du mois.']]
    ],
    foot: 'Mosaïque · document de démonstration'
  },
  en: {
    subtitle: 'Review for the team · October 2026',
    figures: [['128', 'tasks shipped'], ['+18%', 'more active people'], ['4.6 / 5', 'satisfaction']],
    chart: 'Tasks shipped per month',
    months: [['Jul', 34], ['Aug', 27], ['Sep', 41], ['Oct', 26]],
    sections: [
      ['Highlights', ['The new home page has been online since September.', 'The dark theme ships together with the light one.', 'A short demo every Friday.']],
      ['Next', ['Prepare the mock-ups of the dashboard.', 'Reread the style guide before the end of the month.']]
    ],
    foot: 'Mosaic · demonstration document'
  }
}

/**
 * A one-page PDF in landscape (842 × 595 points, the whole page in view): a band of the page's colour with its title, three figures, a bar chart
 * and two short lists, in the two fonts every PDF reader has (Helvetica). A valid cross-reference table, and the title in the document's
 * information, which the viewer gives the tab. ASCII only.
 */
function pdfPage(def: PageDef, ctx: PageContext): string {
  const t = REPORT[ctx.lang]
  const accent = pdfColor(def.color)
  const ink = '0.110 0.110 0.122'
  const muted = '0.420 0.420 0.447'
  const ops: string[] = []
  const text = (font: 'F1' | 'F2', size: number, x: number, y: number, value: string, color = ink) => ops.push(`BT ${color} rg /${font} ${size} Tf 1 0 0 1 ${x} ${y} Tm ${pdfString(value)} Tj ET`)
  const box = (x: number, y: number, w: number, h: number, color: string) => ops.push(`${color} rg ${x} ${y} ${w} ${h} re f`)
  // The band of the title.
  box(0, 515, 842, 80, accent)
  text('F2', 26, 48, 552, def.title[ctx.lang], '1 1 1')
  text('F1', 13, 48, 528, t.subtitle, '1 1 1')
  // Three figures.
  t.figures.forEach(([figure, label], i) => {
    const x = 48 + i * 172
    box(x, 400, 156, 88, '0.957 0.953 0.941')
    box(x, 400, 4, 88, accent)
    text('F2', 24, x + 18, 450, figure)
    text('F1', 11.5, x + 18, 426, label, muted)
  })
  // The bar chart, on the right.
  text('F2', 14, 600, 470, t.chart)
  const top = Math.max(...t.months.map(([, n]) => n))
  t.months.forEach(([month, n], i) => {
    const x = 600 + i * 52
    const height = Math.round((n / top) * 150)
    // The best month in the colour of the page, the others lighter.
    box(x, 290, 34, height, i === 2 ? accent : pdfColor(def.color, 0.55))
    text('F2', 11, x + 8, 296 + height, String(n))
    text('F1', 10, x + 2, 274, month, muted)
  })
  box(596, 289, 214, 1, '0.800 0.800 0.800')
  // Two short lists.
  let y = 360
  for (const [heading, items] of t.sections) {
    text('F2', 15, 48, y, heading)
    y -= 24
    for (const item of items) {
      box(50, y + 3, 5, 5, accent)
      text('F1', 12.5, 64, y, item)
      y -= 20
    }
    y -= 14
  }
  box(48, 50, 746, 1, '0.880 0.880 0.880')
  text('F1', 9.5, 48, 34, t.foot, muted)
  const stream = ops.join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Title ${pdfTextString(def.title[ctx.lang])} /Producer (Lucium site captures) >>`
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return out
}

// ---------- the server ----------

const RENDERERS: Readonly<Record<PageDef['kind'], (def: PageDef, ctx: PageContext) => string>> = {
  notes: notesPage,
  board: boardPage,
  weather: weatherPage,
  recipes: recipesPage,
  museum: museumPage,
  agenda: agendaPage,
  checklist: checklistPage,
  library: libraryPage,
  trip: tripPage,
  article: articlePage,
  sowing: sowingPage,
  roadmap: roadmapPage,
  palette: palettePage,
  pdf: pdfPage
}

/**
 * The headers of a PDF: no Content-Security-Policy, which the viewer of the engine, a page of its own embedded in the document, would have to
 * live with; and no `Content-Disposition`, which would make it a download. It is ASCII text drawn above, with no link and nothing to fetch.
 */
export const PDF_HEADERS: Readonly<Record<string, string>> = { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }

/** The HTML of a page. */
export const renderPage = (def: PageDef, ctx: PageContext): string => RENDERERS[def.kind](def, ctx)

/** The keys that have their own text in a renderer with variants (lists and articles): a page of those kinds must be one of them. */
export const PAGE_VARIANTS: Readonly<Record<string, readonly string[]>> = { checklist: Object.keys(LISTS), article: Object.keys(ARTICLES) }

export interface Answer {
  status: number
  headers: Record<string, string>
  body: string
}

export interface Site {
  /** The page at this host and path, in the language it is written in. */
  find: (host: string, path: string) => { def: PageDef; lang: Lang } | undefined
  /** The first page of a host: its icon is the one of the site (/favicon.ico). */
  first: (host: string) => PageDef | undefined
  /** Its icon, as the `data:` address the state keeps and as the SVG text served at /favicon.ico. */
  icon: (def: PageDef) => { uri: string; svg: string }
  urlOf: (key: string, lang: Lang) => string
}

/** What the server answers for a GET of `host` and `path` (the query is left out): the page, its icon, or a short page that says nothing is there. */
export function respond(site: Site, host: string, rawPath: string): Answer {
  const path = rawPath.split('?')[0]!.split('#')[0]!
  if (path === '/favicon.ico') {
    const first = site.first(host)
    if (first) return { status: 200, headers: { ...PAGE_HEADERS, 'Content-Type': 'image/svg+xml' }, body: site.icon(first).svg }
    return { status: 404, headers: { ...PAGE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' }, body: '' }
  }
  const found = site.find(host, path)
  if (!found) return { status: 404, headers: { ...PAGE_HEADERS, 'Content-Type': 'text/html; charset=utf-8' }, body: '<!doctype html><meta charset="utf-8"><title>404</title><p>404</p>' }
  const { def, lang } = found
  const body = renderPage(def, { lang, icon: site.icon(def).uri, urlOf: (key) => site.urlOf(key, lang) })
  if (def.kind === 'pdf') return { status: 200, headers: { ...PDF_HEADERS }, body }
  return { status: 200, headers: { ...PAGE_HEADERS, 'Content-Type': 'text/html; charset=utf-8' }, body }
}
