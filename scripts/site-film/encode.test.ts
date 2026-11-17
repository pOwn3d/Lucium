import { describe, expect, it } from 'vitest'
import { concatList, framesArgs, mp4Args, musicFilter, outputNames, pieceArgs, posterArgs, webmArgs } from './encode'

const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1]

describe('the files of a render', () => {
  it('names the whole film after its language, and a part after its scenes or frames', () => {
    expect(outputNames('fr')).toMatchObject({ mp4: 'lucium-fr.mp4', webm: 'lucium-fr.webm', square: 'lucium-fr-carre.mp4', poster: 'lucium-fr-affiche.jpg', log: 'lucium-fr-journal.txt' })
    expect(outputNames('en', { first: 1, last: 3 }).mp4).toBe('lucium-en-s01-s03.mp4')
    expect(outputNames('en', { startFrame: 375, endFrame: 600 }).mp4).toBe('lucium-en-f375-f600.mp4')
  })

  it('writes lossless pieces from PNG images on the standard input', () => {
    const args = pieceArgs('/tmp/a.mkv', 30)
    expect(after(args, '-f')).toBe('image2pipe')
    expect(after(args, '-i')).toBe('-')
    expect(after(args, '-crf')).toBe('0')
    expect(args.at(-1)).toBe('/tmp/a.mkv')
  })

  it('escapes the quotes of the list of pieces', () => {
    expect(concatList(['/a/b.mkv', "/l'x.mkv"])).toBe("file '/a/b.mkv'\nfile '/l'\\''x.mkv'\n")
  })
})

describe('the encodings', () => {
  it('makes an H.264 MP4 in yuv420p with its index at the start, in BT.709, silent without music', () => {
    const args = mp4Args('/m.mkv', '/o.mp4', 30)
    expect(after(args, '-c:v')).toBe('libx264')
    expect(after(args, '-vf')).toContain('format=yuv420p')
    expect(after(args, '-vf')).toContain('out_color_matrix=bt709')
    expect(after(args, '-movflags')).toBe('+faststart')
    expect(args).toContain('-an')
    expect(args).not.toContain('-filter_complex')
  })

  it('mixes the music in AAC (MP4) or Opus (WebM) when there is some', () => {
    const music = { file: '/music.wav', offset: 0, duration: 88, fadeIn: 1.5, fadeOut: 2.5 }
    const mp4 = mp4Args('/m.mkv', '/o.mp4', 30, music)
    expect(mp4.filter((a) => a === '-i')).toHaveLength(2)
    expect(after(mp4, '-c:a')).toBe('aac')
    expect(mp4).not.toContain('-an')
    const webm = webmArgs('/m.mkv', '/o.webm', 30, music)
    expect(after(webm, '-c:v')).toBe('libvpx-vp9')
    expect(after(webm, '-c:a')).toBe('libopus')
  })

  it('takes the stretch of the music under the part, and fades it in and out', () => {
    expect(musicFilter({ file: 'm', offset: 9, duration: 14, fadeIn: 1.5, fadeOut: 2.5 })).toBe(
      '[1:a]atrim=start=9:duration=14,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=1.5,afade=t=out:st=11.5:d=2.5,apad,atrim=duration=14[a]'
    )
    // A part shorter than both fades: each fade takes half of it at most.
    expect(musicFilter({ file: 'm', offset: 0, duration: 2, fadeIn: 1.5, fadeOut: 2.5 })).toContain('afade=t=in:st=0:d=1,afade=t=out:st=1:d=1')
  })

  it('takes the poster and the frames of a video at the given time and rate', () => {
    expect(posterArgs('/m.mkv', 6.2, '/p.jpg').slice(4, 6)).toEqual(['-ss', '6.200'])
    expect(after(framesArgs('/v.mov', '/cache/', 30, 1440), '-vf')).toBe("fps=30,scale='min(1440,iw)':-2:flags=lanczos")
    expect(framesArgs('/v.mov', '/cache/', 30, 1440).at(-1)).toBe('/cache/%04d.jpg')
  })
})
