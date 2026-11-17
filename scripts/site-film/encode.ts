// The files of a render and the arguments of ffmpeg that make them: the lossless pieces the pages write, the H.264 MP4 (yuv420p, faststart), the
// VP9 WebM, the square version, the poster, the music mixed with a fade at both ends, and the frames taken out of the screen
// recordings for the page.
// Pure, and loaded by Node with type stripping: no runtime import, no enum, no parameter property.

import type { Lang } from '../site-captures/shots'
import type { FormatName } from './layout'

export interface OutputNames {
  /** `lucium-fr` for the whole film, `lucium-fr-s01-s03` for a part of it. */
  base: string
  mp4: string
  webm: string
  square: string
  poster: string
  squarePoster: string
  transcript: string
  vtt: string
  log: string
}

/** The names of the files of a render, in the output folder. A part of the film is named after its scenes (or its frames). */
export function outputNames(lang: Lang, part?: { first: number; last: number } | { startFrame: number; endFrame: number }): OutputNames {
  const pad = (n: number) => String(n).padStart(2, '0')
  const suffix = part === undefined ? '' : 'first' in part ? `-s${pad(part.first)}-s${pad(part.last)}` : `-f${part.startFrame}-f${part.endFrame}`
  const base = `lucium-${lang}${suffix}`
  return {
    base,
    mp4: `${base}.mp4`,
    webm: `${base}.webm`,
    square: `${base}-carre.mp4`,
    poster: `${base}-affiche.jpg`,
    squarePoster: `${base}-carre-affiche.jpg`,
    transcript: `${base}.txt`,
    vtt: `${base}.vtt`,
    log: `${base}-journal.txt`
  }
}

/** The lossless piece of film one page writes: PNG images on the standard input, RGB H.264 at constant quality 0 out (Matroska). */
export function pieceArgs(out: string, fps: number): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-', '-c:v', 'libx264rgb', '-preset', 'ultrafast', '-crf', '0', '-pix_fmt', 'rgb24', out]
}

/** The text of the list of pieces for the concat demuxer, one `file '…'` per piece, quotes escaped. */
export const concatList = (pieces: readonly string[]): string => pieces.map((piece) => `file '${piece.replace(/'/g, "'\\''")}'`).join('\n') + '\n'

/** The pieces joined into the master, without encoding again. */
export function concatArgs(list: string, out: string): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', out]
}

/** The music of the film, cut to its part and faded in and out. */
export interface Music {
  file: string
  /** Where the part starts in the film, in seconds: the music is taken from there. */
  offset: number
  duration: number
  fadeIn: number
  fadeOut: number
}

/** The audio filter: the stretch of the music under the part, a fade at the start and at the end, silence after it if it is too short. */
export function musicFilter(music: Music): string {
  const fadeIn = Math.min(music.fadeIn, music.duration / 2)
  const fadeOut = Math.min(music.fadeOut, music.duration / 2)
  const round = (n: number) => Number(n.toFixed(3))
  return [
    `[1:a]atrim=start=${round(music.offset)}:duration=${round(music.duration)}`,
    'asetpts=PTS-STARTPTS',
    `afade=t=in:st=0:d=${round(fadeIn)}`,
    `afade=t=out:st=${round(music.duration - fadeOut)}:d=${round(fadeOut)}`,
    'apad',
    `atrim=duration=${round(music.duration)}[a]`
  ].join(',')
}

/** RGB to the BT.709 colours of a video, said in the file too: without it ffmpeg uses BT.601 and the greys and the blue of the site shift. */
const COLOUR = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv']
const toYuv = (scale?: { width: number; height: number }) =>
  `${scale ? `scale=${scale.width}:${scale.height}:flags=lanczos,` : ''}scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709`

const inputs = (master: string, music?: Music) => (music ? ['-i', master, '-i', music.file] : ['-i', master])
const audio = (music: Music | undefined, codec: string[]) => (music ? ['-filter_complex', musicFilter(music), '-map', '0:v', '-map', '[a]', ...codec] : ['-map', '0:v', '-an'])

/** The MP4 of the site and of the social networks: H.264 High, yuv420p, the index at the start (`faststart`), AAC when there is music. */
export function mp4Args(master: string, out: string, fps: number, music?: Music): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-y', ...inputs(master, music),
    ...audio(music, ['-c:a', 'aac', '-b:a', '192k']),
    '-vf', toYuv(), '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-profile:v', 'high', '-r', String(fps), ...COLOUR,
    '-movflags', '+faststart', out
  ]
}

/** The WebM: VP9 at constant quality, Opus when there is music. */
export function webmArgs(master: string, out: string, fps: number, music?: Music): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-y', ...inputs(master, music),
    ...audio(music, ['-c:a', 'libopus', '-b:a', '160k']),
    '-vf', toYuv(), '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '31', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', '-r', String(fps), ...COLOUR, out
  ]
}

/** The poster: one frame of the master as a JPEG of high quality. */
export function posterArgs(master: string, seconds: number, out: string): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-y', '-ss', seconds.toFixed(3), '-i', master, '-frames:v', '1', '-q:v', '2', out]
}

/** The frames of a video for the page, at the frame rate of the film, as JPEG of high quality, `0001.jpg`, `0002.jpg`… `size`: the widest side. */
export function framesArgs(video: string, outDir: string, fps: number, size: number): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-vf', `fps=${fps},scale='min(${size},iw)':-2:flags=lanczos`, '-q:v', '2', `${outDir.replace(/\/+$/, '')}/%04d.jpg`]
}

/** The format of a master from its name, for the logs. */
export const formatLabel = (format: FormatName): string => (format === 'wide' ? '1920 × 1080' : '1080 × 1080')
