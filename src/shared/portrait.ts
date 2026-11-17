// "Capture in Portrait Mode": the page's picture set on a tall canvas, on the colour of the site (not on the desktop
// wallpaper, and without a watermark). This is the layout, as numbers, so it can be tested.

export const PORTRAIT_CANVAS = { width: 1080, height: 1920 } as const
/** Space kept around the picture, and the corner radius of the picture's card. */
export const PORTRAIT_MARGIN = 80
export const PORTRAIT_RADIUS = 28

export interface PortraitLayout {
  x: number
  y: number
  width: number
  height: number
}

/** Where the picture goes: as large as the margins allow, never enlarged beyond its size, centred. Null for an empty picture. */
export function portraitLayout(picture: { width: number; height: number }): PortraitLayout | null {
  if (!(picture.width > 0) || !(picture.height > 0)) return null
  const room = { width: PORTRAIT_CANVAS.width - PORTRAIT_MARGIN * 2, height: PORTRAIT_CANVAS.height - PORTRAIT_MARGIN * 2 }
  const scale = Math.min(room.width / picture.width, room.height / picture.height, 1)
  const width = Math.round(picture.width * scale)
  const height = Math.round(picture.height * scale)
  return { x: Math.round((PORTRAIT_CANVAS.width - width) / 2), y: Math.round((PORTRAIT_CANVAS.height - height) / 2), width, height }
}

const HEX = /^#[0-9a-f]{6}$/i

/** The page that is painted to make the picture: the site's colour behind a card holding the capture. */
export function portraitHtml(dataUrl: string, layout: PortraitLayout, color: string | null): string {
  const base = color && HEX.test(color) ? color : '#26262e'
  return `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;width:${PORTRAIT_CANVAS.width}px;height:${PORTRAIT_CANVAS.height}px;overflow:hidden}
body{background:radial-gradient(120% 90% at 50% 0%, ${base}, color-mix(in srgb, ${base} 55%, #000))}
img{position:absolute;left:${layout.x}px;top:${layout.y}px;width:${layout.width}px;height:${layout.height}px;border-radius:${PORTRAIT_RADIUS}px;box-shadow:0 24px 80px rgb(0 0 0 / .45)}
</style><img src="${dataUrl}">`
}
