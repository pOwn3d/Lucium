// The logo of Lucium, « les espaces en éventail »: five rounded tabs open from a point of light, each tab is a space and the centre is the
// page that lights up. ONE drawing for every version: only the colours change (the eight themes below, one per choice of Settings › Icône).
// This file is the single source of the drawing; scripts/logo/make-icons.mjs renders every icon of the application and of the site from it.
// Pure, and loaded by Node with type stripping: no runtime import, no enum, no parameter property.
//
// Copyright © 2026 ConsilioWeb. All rights reserved. This file is NOT under the GPL of the rest of the repository: the logo is reserved for the
// official builds. A modified version that is handed out puts its own drawing here; what else is allowed is in TRADEMARKS.md.

/** One colour version of the logo. `id` is the id of the choice in Settings › Icône (shared/icons.ts) and the name of its PNG in resources/app-icons. */
export interface FanTheme {
  id: string
  /** The name of the version, as the design board calls it (the labels shown to the user are in i18n, `icons.<id>`). */
  name: string
  /** The gradient of the tile, from the top left to the bottom right. */
  background: readonly [string, string]
  /** The five tabs, from the left one to the right one. */
  rays: readonly [string, string, string, string, string]
  /** The dark ring around the point of light. */
  hub: string
}

/** The eight versions, each under the id of its choice in the settings (shared/icons.ts). `clair` is the default one. */
export const FAN_THEMES: readonly FanTheme[] = [
  { id: 'clair', name: 'Clair', background: ['#fdfcff', '#e9e5fb'], rays: ['#ff7a59', '#ffc23d', '#3ccf91', '#33b6e6', '#5b7bff'], hub: '#2a2440' },
  { id: 'boreal', name: 'Boréal', background: ['#0f3a46', '#06161c'], rays: ['#5df2c6', '#38d4f0', '#7aa8ff', '#a98bff', '#3fe08a'], hub: '#06161c' },
  { id: 'solaire', name: 'Solaire', background: ['#fff4e2', '#ffd9a8'], rays: ['#ff5a3c', '#ff8a2a', '#ffb62e', '#ffd84a', '#ff6f91'], hub: '#4a2410' },
  { id: 'nebula', name: 'Nébula', background: ['#2a1854', '#120a2a'], rays: ['#c46bff', '#ff6fc7', '#8f7bff', '#5fb6ff', '#ff9bd8'], hub: '#120a2a' },
  { id: 'cyber', name: 'Cyber', background: ['#0b0c10', '#000'], rays: ['#00f0ff', '#ff2bd6', '#9dff3c', '#ffe600', '#7a5cff'], hub: '#000' },
  { id: 'crepuscule', name: 'Crépuscule', background: ['#2b2a5a', '#d06c7c'], rays: ['#ffb36b', '#ff7f8a', '#d773c7', '#8c7cff', '#ffd36b'], hub: '#231c3f' },
  { id: 'abysse', name: 'Abysse', background: ['#0a2a5c', '#04122b'], rays: ['#2fd3ff', '#2a8cff', '#57f0d0', '#7a6cff', '#9fe6ff'], hub: '#04122b' },
  { id: 'sepia-or', name: 'Sépia-or', background: ['#3b2a1a', '#1c140c'], rays: ['#e9c46a', '#f4a259', '#d4a373', '#f6d58e', '#c08552'], hub: '#1c140c' }
]

/** The drawing is made on a canvas of 1024; the tile (Apple's grid) is 824 wide with 100 around it, where the drop shadow falls. */
export const LOGO_CANVAS = 1024
export const LOGO_TILE = { x: 100, y: 100, size: 824, corner: 185 }

/** The length of each tab and its angle (degrees, from the vertical), left to right: the lengths differ a little, which gives the movement. */
const LENGTHS = [400, 430, 450, 430, 400]
const ANGLES = [-56, -28, 0, 28, 56]
/** The point where the tabs meet, in the canvas. */
const HUB = { x: 512, y: 655 }

export interface FanLogoOptions {
  /** `canvas`: the whole 1024 canvas, the tile with its margin (the icon as macOS shows it). `tile`: cropped to the tile (a favicon, a home-screen icon). */
  view?: 'canvas' | 'tile'
  /** The soft drop shadow under the tile; only visible in the `canvas` view. */
  shadow?: boolean
  /** The radius of the corners of the tile; 0 for a full-bleed square. */
  corner?: number
}

/**
 * The logo as an SVG document, `size` px wide. `uid` makes the ids of the gradients and of the filter unique, when several logos share a page.
 * Without options this is the validated drawing: the whole canvas, the shadow, the corners of 185.
 */
export function fanLogo(theme: FanTheme, size: number, uid: string | number = 0, options: FanLogoOptions = {}): string {
  const { view = 'canvas', shadow = true, corner = LOGO_TILE.corner } = options
  const { background, rays, hub } = theme
  const rayShapes = ANGLES.map((angle, index) => `<rect x="-52" y="${-LENGTHS[index]!}" width="104" height="${LENGTHS[index]! - 40}" rx="52" fill="${rays[index]!}" transform="rotate(${angle})"/>`).join('')
  const box = view === 'tile' ? `${LOGO_TILE.x} ${LOGO_TILE.y} ${LOGO_TILE.size} ${LOGO_TILE.size}` : `0 0 ${LOGO_CANVAS} ${LOGO_CANVAS}`
  const filter = shadow ? ` filter="url(#sh${uid})"` : ''
  const shadowDef = shadow ? `<filter id="sh${uid}" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="18" stdDeviation="22" flood-opacity=".28"/></filter>` : ''
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}" width="${size}" height="${size}"><defs><linearGradient id="bg${uid}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${background[0]}"/><stop offset="1" stop-color="${background[1]}"/></linearGradient>` +
    `<radialGradient id="gl${uid}" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#fff"/><stop offset=".5" stop-color="#fff" stop-opacity=".5"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>` +
    `${shadowDef}</defs>` +
    `<rect x="${LOGO_TILE.x}" y="${LOGO_TILE.y}" width="${LOGO_TILE.size}" height="${LOGO_TILE.size}" rx="${corner}" fill="url(#bg${uid})"${filter}/>` +
    `<g transform="translate(${HUB.x} ${HUB.y})">${rayShapes}<circle r="112" fill="${hub}"/><circle r="120" fill="none" stroke="#fff" stroke-opacity=".18" stroke-width="10"/><circle r="70" fill="url(#gl${uid})"/><circle r="38" fill="#fff"/></g></svg>`
  )
}
