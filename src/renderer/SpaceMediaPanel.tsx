// Upload and manage background media (images, GIFs, videos) for space sidebar backgrounds
import { useEffect, useId, useRef, useState } from 'react'
import { t } from '@shared/i18n'
import type { Space } from '@shared/model'
import type { MediaBytes, SpaceBackgroundMediaReply } from '@shared/space-background-media'
import { toggledVideoPause, videoBackgroundPaused, type SpaceBackground } from '@shared/space-media'
import { BUILTIN_BACKGROUND_IDS, builtinPosterFile, builtinVideoFile, type BuiltinBackgroundId } from '@shared/builtin-backgrounds'
import { keepsHandLook, type AutoVeilLook } from '@shared/auto-veil'
import { measureBackground, type MeasuredLook } from './background-probe'
import { useSystemReducedMotion } from './reduced-motion'
import { BackgroundFraming } from './BackgroundFraming'
import './space-media-panel.css'

interface SpaceMediaPanelProps {
  space: Space
  /** The file the space now has: one of the user's comes with the look measured from it, unless the look it replaces was set by hand (`look` absent). */
  onMediaChange: (media: { filename: string; mimeType: string; look?: AutoVeilLook } | null) => void
  /** The background with its video paused or played again: the Pause / Lire control writes it, remembered for this space. Without it, no control. */
  onBackgroundChange?: (background: SpaceBackground) => void
  /** The part of a video the sidebar shows, in percent of the video (the frame of « Cadrage »): written as the choice of this space. Without it, no frame. */
  onPositionChange?: (x: number, y: number) => void
  /** Lucium's « Réduire les animations » (`forceReduceMotion`): with the system's, a video background is still until the user plays it. */
  forceReduceMotion?: boolean
  disabled?: boolean
  /** How a file the user adds is measured (background-probe.ts); a test gives its own. */
  measure?: (bytes: MediaBytes, mimeType: string) => Promise<MeasuredLook>
}

/** A preview is a blob URL of the media's bytes: it is released when another preview replaces it, or when the panel goes. */
interface Preview {
  url: string
  video: boolean
}

function previewOf(data: MediaBytes, mimeType: string): Preview {
  return { url: URL.createObjectURL(new Blob([data], { type: mimeType })), video: mimeType.startsWith('video/') }
}

/** The name of each video Lucium comes with. */
const BUILTIN_LABELS: Record<BuiltinBackgroundId, () => string> = {
  'aurores-boreales': () => t('space-media.aurores-boreales'),
  'temple-brume': () => t('space-media.temple-dans-la-brume'),
  'serre-lucioles': () => t('space-media.serre-aux-lucioles'),
  village: () => t('space-media.village-enneige'),
  foret: () => t('space-media.foret-au-clair-de-lune'),
  montagnes: () => t('space-media.montagnes-dans-la-brume'),
  'ville-cyberpunk': () => t('space-media.ville-neon-sous-la-pluie'),
  'fonds-marins': () => t('space-media.meduses'),
  'hublot-spatial': () => t('space-media.hublot-spatial')
}

/** The small pictures of the videos Lucium comes with, as blob URLs (read once the panel is open, released when it goes). Missing ones stay out. */
function useBuiltinPosters(): Partial<Record<BuiltinBackgroundId, string>> {
  const [posters, setPosters] = useState<Partial<Record<BuiltinBackgroundId, string>>>({})
  useEffect(() => {
    let live = true
    const made: string[] = []
    void Promise.all(
      BUILTIN_BACKGROUND_IDS.map(async (id): Promise<[BuiltinBackgroundId, string] | null> => {
        try {
          const reply = (await window.lucium.spaceBackgroundMedia({ op: 'read', filename: builtinPosterFile(id) })) as SpaceBackgroundMediaReply
          if (!reply.ok || !reply.data || !reply.mimeType) return null
          const url = URL.createObjectURL(new Blob([reply.data], { type: reply.mimeType }))
          made.push(url)
          return [id, url]
        } catch (err) {
          console.warn(`[space media] cannot read the picture of ${id}:`, err)
          return null
        }
      })
    ).then((entries) => {
      if (live) setPosters(Object.fromEntries(entries.filter((entry) => entry !== null)))
    })
    return () => {
      live = false
      for (const url of made) URL.revokeObjectURL(url)
    }
  }, [])
  return posters
}

/** The videos Lucium comes with, as small pictures: a click makes one the background of the space. The one it has is pressed. */
export function BuiltinBackgroundChoices({ current, disabled, onChoose }: { current: string | undefined; disabled: boolean; onChoose: (filename: string) => void }) {
  const posters = useBuiltinPosters()
  return (
    <div className="media-builtins" role="group" aria-labelledby="media-builtins-title">
      <span id="media-builtins-title" className="media-builtins-title">
        {t('space-media.videos-de-lucium')}
      </span>
      <div className="media-builtins-grid">
        {BUILTIN_BACKGROUND_IDS.map((id) => {
          const file = builtinVideoFile(id)
          const label = BUILTIN_LABELS[id]()
          const poster = posters[id]
          return (
            <button key={id} type="button" className="media-builtin" aria-pressed={current === file} aria-label={label} data-tip={label} disabled={disabled} onClick={() => onChoose(file)}>
              {poster ? <img src={poster} alt="" draggable={false} /> : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function SpaceMediaPanel({ space, onMediaChange, onBackgroundChange, onPositionChange, forceReduceMotion = false, disabled = false, measure = measureBackground }: SpaceMediaPanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const [uploading, setUploading] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [error, setError] = useState('')
  /** Said when the file added could not be measured and got the safe veil. */
  const [veilNote, setVeilNote] = useState('')
  const [loadingPreview, setLoadingPreview] = useState(false)
  const reduceMotion = useSystemReducedMotion() || forceReduceMotion
  const background = space.background
  // What the sidebar shows now: the space's own choice, else still under reduced motion (space-media.ts `videoBackgroundPaused`).
  const videoPaused = background?.type === 'video' && videoBackgroundPaused(background, reduceMotion)

  useEffect(() => {
    if (!preview) return
    return () => URL.revokeObjectURL(preview.url)
  }, [preview])

  // Load preview when space.background changes
  useEffect(() => {
    const background = space.background
    if (!background?.value) {
      setPreview(null)
      setError('')
      return
    }

    // The file may change again before this reading answers: only the reading of the file the space has now may draw the preview.
    let live = true
    const loadPreview = async () => {
      setLoadingPreview(true)
      try {
        const reply = await window.lucium.spaceBackgroundMedia({
          op: 'read',
          filename: background.value
        }) as SpaceBackgroundMediaReply

        if (!live) return
        if (!reply.ok) {
          console.warn('[space media] cannot read the background:', reply.message)
          setError(t('space-media.read-error'))
          return
        }
        if (reply.data && reply.mimeType) setPreview(previewOf(reply.data, reply.mimeType))
        else setPreview(null)
      } catch (err) {
        console.warn('[space media] cannot read the background:', err)
        if (live) setError(t('space-media.read-error'))
      } finally {
        // The reading that replaced this one says when it is done itself.
        if (live) setLoadingPreview(false)
      }
    }

    void loadPreview()
    return () => {
      live = false
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the preview is read again when the file changes, not when another field of the background does
  }, [space.background?.value])

  // Supported media types
  const SUPPORTED_TYPES = [
    'image/webp',
    'image/png',
    'image/jpeg',
    'image/gif',
    'video/mp4',
    'video/webm'
  ]

  const handleFileSelect = async (files: FileList | null) => {
    if (!files || files.length === 0) return

    const file = files.item(0)
    if (!file) return

    // Validate MIME type
    if (!SUPPORTED_TYPES.includes(file.type)) {
      setError(t('space-media.unsupported-format'))
      return
    }

    // Validate file size: 50MB for a video, 10MB for an image
    const maxBytes = file.type.startsWith('video/') ? 50 * 1024 * 1024 : 10 * 1024 * 1024
    if (file.size > maxBytes) {
      setError(t('space-media.file-too-large'))
      return
    }

    setError('')
    setVeilNote('')
    setUploading(true)

    try {
      // The bytes go over IPC as they are: no base64 text, which is a third bigger and is decoded on each side.
      const data: MediaBytes = new Uint8Array(await file.arrayBuffer())

      const reply = await window.lucium.spaceBackgroundMedia({
        op: 'upload',
        spaceId: space.id,
        data,
        mimeType: file.type
      }) as SpaceBackgroundMediaReply

      if (!reply.ok) {
        console.warn('[space media] upload refused:', reply.message)
        setError(t('space-media.upload-failed'))
        return
      }
      if (!reply.filename) {
        setError(t('space-media.upload-failed'))
        return
      }

      setLoadingPreview(true)
      const readReply = await window.lucium.spaceBackgroundMedia({
        op: 'read',
        filename: reply.filename
      }) as SpaceBackgroundMediaReply
      if (!readReply.ok) {
        console.warn('[space media] cannot read the uploaded background:', readReply.message)
        setError(t('space-media.upload-failed'))
        return
      }
      if (!readReply.data || !readReply.mimeType) {
        setError(t('space-media.upload-failed'))
        return
      }

      setPreview(previewOf(readReply.data, readReply.mimeType))
      // Measured once, now, from the bytes in hand (shared/auto-veil.ts); not when the look of the background it replaces was set by hand, which it keeps.
      const measured = keepsHandLook(space.background) ? null : await measure(readReply.data, readReply.mimeType)
      if (measured && !measured.measured) setVeilNote(t('space-media.veil-auto-failed'))
      onMediaChange({ filename: reply.filename, mimeType: file.type, ...(measured ? { look: measured.look } : {}) })
    } catch (err) {
      console.warn('[space media] upload failed:', err)
      setError(t('space-media.upload-error'))
    } finally {
      setUploading(false)
      setLoadingPreview(false)
    }
  }

  const handleDelete = async () => {
    setUploading(true)
    try {
      const reply = await window.lucium.spaceBackgroundMedia({
        op: 'delete',
        spaceId: space.id
      }) as SpaceBackgroundMediaReply

      if (!reply.ok) {
        console.warn('[space media] delete refused:', reply.message)
        setError(t('space-media.delete-error'))
        return
      }

      setPreview(null)
      setVeilNote('')
      onMediaChange(null)
    } catch (err) {
      console.warn('[space media] delete failed:', err)
      setError(t('space-media.delete-error'))
    } finally {
      setUploading(false)
    }
  }

  return (
    // The title names the whole group (the videos, the file button, the removal): as a <label> of the hidden file input it named no control at all.
    <div className="space-media-panel" role="group" aria-labelledby={titleId}>
      <div id={titleId} className="media-label">
        {t('space-media.background-media')}
      </div>

      {/* The videos Lucium comes with: chosen like a file of the user's, without a copy (main/media-storage.ts reads them from the resources). */}
      <BuiltinBackgroundChoices
        current={background?.value}
        disabled={uploading || disabled || loadingPreview}
        onChoose={(filename) => {
          setError('')
          setVeilNote('')
          onMediaChange({ filename, mimeType: 'video/mp4' })
        }}
      />

      {preview && (
        <div className="media-preview">
          {preview.video ? (
            // The preview starts by itself only when the background plays: a paused one, or reduced motion, leaves it on its first frame (its own controls play it).
            <video key={videoPaused ? 'still' : 'playing'} src={preview.url} controls autoPlay={!videoPaused} muted loop style={{ maxWidth: '100%', borderRadius: '8px' }} />
          ) : (
            <img src={preview.url} alt={t('space-media.apercu')} style={{ maxWidth: '100%', borderRadius: '8px' }} />
          )}
        </div>
      )}

      {/* The part of a video the sidebar shows: a frame over the whole video, dragged or moved with the arrows (BackgroundFraming.tsx). */}
      {background?.type === 'video' && preview?.video && onPositionChange && <BackgroundFraming key={preview.url} src={preview.url} position={background.position} onChange={onPositionChange} disabled={disabled} />}

      {error && <div className="media-error" role="alert">{error}</div>}
      {veilNote && <div className="media-info" role="status">{veilNote}</div>}

      <div className="media-actions">
        <input
          ref={fileInputRef}
          tabIndex={-1}
          aria-hidden="true"
          type="file"
          accept={SUPPORTED_TYPES.join(',')}
          onChange={(e) => void handleFileSelect(e.currentTarget.files)}
          disabled={uploading || disabled || loadingPreview}
          style={{ display: 'none' }}
        />

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading || disabled || loadingPreview}
          className="media-button"
        >
          {uploading || loadingPreview ? t('space-media.uploading') : t('space-media.upload')}
        </button>

        {/* Pause / Lire of the video background (WCAG 2.2.2): remembered for this space; « Lire » starts it again at once, reduced motion or not. */}
        {background?.type === 'video' && onBackgroundChange && (
          <button type="button" className="media-button" disabled={disabled} onClick={() => onBackgroundChange(toggledVideoPause(background, reduceMotion))}>
            {videoPaused ? t('space-customize.fond-video-lire') : t('space-customize.fond-video-pause')}
          </button>
        )}

        {space.background && (
          <button type="button" onClick={() => void handleDelete()} disabled={uploading || disabled || loadingPreview} className="media-button media-button-danger">
            {t('space-media.delete')}
          </button>
        )}
      </div>
      {background?.type === 'video' && onBackgroundChange && reduceMotion && background.paused === undefined && (
        <div className="media-info">{t('space-media.video-still-reduced-motion')}</div>
      )}

      <div className="media-info">
        {t('space-media.info')}
      </div>
    </div>
  )
}
