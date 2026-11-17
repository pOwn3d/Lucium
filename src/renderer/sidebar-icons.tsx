import { t } from '@shared/i18n'
// The pictograms of the sidebar, drawn here: thin strokes in `currentColor`, at these sizes
// (closed folder 19 x 19, open folder 22 x 16, library button 14 x 16, "+" 14 x 14).

import { containerHex } from '@shared/containers'
import type { ProxyMarkReason } from '@shared/proxy-mark'

const base = { fill: 'none', stroke: 'currentColor', strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const

/** The cross of a row: 11 x 12, centred 17 px from the right edge of the row. */
export function CloseGlyph() {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" {...base} strokeWidth="1.9">
      <path d="M2 2l8 8M10 2 2 10" />
    </svg>
  )
}

/** The chevron of a branch of the tab tree: pointing down while its children show, to the right once they are folded away. */
export function ChevronGlyph({ folded }: { folded: boolean }) {
  return (
    <svg viewBox="0 0 10 10" width="10" height="10" {...base} strokeWidth="1.6" style={{ transform: folded ? 'none' : 'rotate(90deg)' }}>
      <path d="M3.4 1.8 6.6 5 3.4 8.2" />
    </svg>
  )
}

/**
 * A folder, closed (19 x 19) or open (22 x 16, seen at an angle). The state is carried by the icon alone: there is no chevron.
 * The flap takes the tint of the space (`--folder-tint`), the body is dark with a light outline.
 */
export function FolderIcon({ open }: { open: boolean }) {
  return open ? (
    <svg className="folder-glyph open" viewBox="0 0 23 17" width="22" height="16" aria-hidden="true">
      <path d="M1.4 2.6c0-.9.7-1.6 1.6-1.6h4.2l1.6 1.9h3.2L8.7 13.4H3.6c-1.2 0-2.2-1-2.2-2.2z" fill="var(--folder-tint)" />
      <path d="M5.4 16 3.7 7.9c-.1-.5.3-1 .8-1h16.2c.6 0 1 .5.9 1.1l-1.6 6.9c-.2.7-.8 1.2-1.5 1.2z" fill="var(--folder-body)" stroke="var(--folder-line)" strokeWidth="1.1" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg className="folder-glyph" viewBox="0 0 19 19" width="19" height="19" aria-hidden="true">
      <path d="M1.5 6.4V3.6c0-1 .8-1.8 1.8-1.8h3.6l1.7 1.9h6.2c1 0 1.8.8 1.8 1.8v1z" fill="var(--folder-tint)" />
      <rect x="1" y="5.2" width="17" height="12.4" rx="2.4" fill="var(--folder-body)" stroke="var(--folder-line)" strokeWidth="1.1" />
    </svg>
  )
}

/** The button at the left of the footer (the library of downloads): a box with its lid lifted and a spark above it, 14 x 16. */
export function DownloadsIcon() {
  return (
    <svg viewBox="0 0 14 16" width="14" height="16" fill="none" aria-hidden="true">
      <path fillRule="evenodd" fill="currentColor" d="M2.2 7.4h9.6v5.4c0 1-.8 1.8-1.8 1.8H4c-1 0-1.8-.8-1.8-1.8zM5.1 8.9v1.3h3.8V8.9z" />
      <path d="M1.2 6.2c.3-1.5 1.6-2.6 3.1-2.6h2.2L7 4.9l2.5-.9c1.3-.4 2.7.2 3.2 1.5l.2.7z" fill="currentColor" opacity=".9" />
      <path d="M10.3 1.2v1.6M9.5 2h1.6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}

/** The plus of the footer and of the new-tab row: a thin cross, 14 x 14 in the footer, 18 x 18 in a row. */
export function PlusGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 14 14" width={size} height={size} {...base} strokeWidth="1.3">
      <path d="M7 1.8v10.4M1.8 7h10.4" />
    </svg>
  )
}

/** The mark of a tab whose video floats in Lucium's window (« Image dans l'image »): a small window over a larger one, filled. */
export function FloatingVideoGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" {...base} strokeWidth="1.3">
      <path d="M2 10.4V4.1c0-.8.6-1.4 1.4-1.4h9.2c.8 0 1.4.6 1.4 1.4v2.3" />
      <rect x="7.2" y="8" width="7.6" height="5.4" rx="1.2" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** The mark of a tab an extension captures the sound of: a ring with a dot in it, the mark of a recording. */
export function CapturedGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" {...base} strokeWidth="1.3">
      <circle cx="8" cy="8" r="5.6" />
      <circle cx="8" cy="8" r="2.2" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** What a tab that makes sound shows: three bars that move to the music, or a crossed speaker once it is muted. */
export function SpeakerGlyph({ muted }: { muted: boolean }) {
  if (!muted) {
    return (
      <svg className="equalizer" viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
        <rect className="bar b1" x="2.4" y="3" width="2.6" height="10" rx="1.1" />
        <rect className="bar b2" x="6.7" y="3" width="2.6" height="10" rx="1.1" />
        <rect className="bar b3" x="11" y="3" width="2.6" height="10" rx="1.1" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" {...base} strokeWidth="1.3">
      <path d="M2.6 6.2h2.2l3.1-2.5c.4-.3.9 0 .9.5v7.6c0 .5-.5.8-.9.5L4.8 9.8H2.6c-.4 0-.7-.3-.7-.7V6.9c0-.4.3-.7.7-.7z" fill="currentColor" stroke="none" />
      <path d="M11.4 6.2l3 3.6M14.4 6.2l-3 3.6" />
    </svg>
  )
}

/** "Back to the pinned address": an arrow that turns back. */
export function BackToPinGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" {...base} strokeWidth="1.4">
      <path d="M6 3.6 2.9 6.5 6 9.4M3.3 6.5h6.2c2.2 0 3.6 1.3 3.6 3.2s-1.4 3.1-3.6 3.1H6.6" />
    </svg>
  )
}

/** The mark of a developer tab: a small round badge with a hammer, on the corner of the icon (the control center uses the same hammer). */
export function DeveloperBadge() {
  return (
    <span className="developer-badge" title={t('sidebar.mode-developpeur')} role="img" aria-label={t('sidebar.mode-developpeur')}>
      <svg viewBox="0 0 12 12" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M7.6 1.8 10.2 4.4l-1.3 1.3-.8-.8-1 1 .9.9-.7.7L4 4.3l.7-.7.9.9 1-1-.8-.8zM6.4 6.6 2 11" />
      </svg>
    </span>
  )
}

/** The mark of a private tab: a small dark badge with a pair of glasses (the look of the private window), on the corner of the icon. */
export function PrivateBadge() {
  return (
    <span className="private-badge tk-dark" title={t('sidebar.onglet-prive-rien-n-est-enregistre')} role="img" aria-label={t('sidebar.onglet-prive')}>
      <svg viewBox="0 0 12 12" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="3.4" cy="7.4" r="2" />
        <circle cx="8.6" cy="7.4" r="2" />
        <path d="M5.4 7.2h1.2M1.4 7 2 3.6h2M10.6 7 10 3.6H8" />
      </svg>
    </span>
  )
}

/** The mark of a tab in a container: a small round badge in the colour of the container, on the corner of the icon. */
export function ContainerBadge({ name, color }: { name: string; color: string }) {
  return <span className="container-badge" style={{ background: containerHex(color) }} title={t('sidebar-icons.conteneur-name', { name })} role="img" aria-label={t('sidebar-icons.conteneur-name', { name })} />
}

/**
 * The mark of a tab that does not go through the proxy of its profile (shared/proxy-mark.ts): a small round badge with an arrow that goes around a bar, on the
 * top-left corner of the icon. The words say why (a container or a private tab leaves by the general proxy); the colour is a role of the tokens, never the only signal.
 */
export function ProxyBadge({ reason }: { reason: ProxyMarkReason }) {
  const words = t(reason === 'container' ? 'sidebar-icons.proxy-du-profil-conteneur' : 'sidebar-icons.proxy-du-profil-prive')
  return (
    <span className="proxy-badge" title={words} role="img" aria-label={words}>
      <svg viewBox="0 0 12 12" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M2 6h6.5M6.5 3.5 9 6 6.5 8.5M10.5 2v8" />
      </svg>
    </span>
  )
}

/** A frozen page: a snowflake, 14 px, in the colour the row gives it. */
export function FrozenGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" {...base} strokeWidth="1.6">
      <path d="M8 1.5v13M2.2 4.75l11.6 6.5M13.8 4.75 2.2 11.25" />
      <path d="M6.1 2.9 8 4.7l1.9-1.8M6.1 13.1 8 11.3l1.9 1.8M2.9 6.3l.5 2.5M2.9 6.3l2.4-.6M13.1 9.7l-.5-2.5M13.1 9.7l-2.4.6" />
    </svg>
  )
}

/** « Dégeler l'onglet »: a drop, what the snowflake becomes (14 px), in the colour the row gives it. */
export function ThawGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" {...base} strokeWidth="1.5">
      <path d="M8 2.2c2.4 2.9 4.1 5 4.1 7.2a4.1 4.1 0 0 1-8.2 0C3.9 7.2 5.6 5.1 8 2.2z" />
      <path d="M6.3 10.2a1.8 1.8 0 0 0 1.5 1.5" />
    </svg>
  )
}

/**
 * The ring of a row, 14 px in the colour the row gives it: a pale track, drawn whole, and, while the page loads, an arc of a third that turns on it
 * (sidebar.css). The track alone is the mark of a row « Actualiser tous les onglets » will reload: the arc comes on the same ring when its turn comes.
 */
export function LoadingRing({ arc }: { arc: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" {...base} strokeWidth="1.6">
      <circle className="ring-track" cx="8" cy="8" r="6" />
      {arc && <path className="ring-arc" d="M8 2a6 6 0 0 1 5.2 9" />}
    </svg>
  )
}

/** « Actualisé »: a tick, the mark a row of « Actualiser tous les onglets » keeps a moment after its reload (12 px, in the colour the row gives it). */
export function ReloadedGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" {...base} strokeWidth="1.8">
      <path d="m3.5 8.4 3 3 6-6.6" />
    </svg>
  )
}

/** The archive in the footer: a box with its lid (16 px). */
export function ArchiveBoxGlyph({ small = false }: { small?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width={small ? 13 : 16} height={small ? 13 : 16} {...base} strokeWidth="1.5">
      <rect x="2" y="3" width="12" height="3.500" rx="1" />
      <path d="M3 6.500v6a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-6M6.500 9.500h3" />
    </svg>
  )
}

/** The list of "Lire plus tard" in the footer: a clock (the context menu's glyph for the action), the strokes of the archive box beside it. */
export function ReadLaterGlyph() {
  return (
    <svg viewBox="0 0 16 16" width={16} height={16} {...base} strokeWidth="1.5">
      <circle cx="8" cy="8" r="5.500" />
      <path d="M8 5.200V8l1.900 1.300" />
    </svg>
  )
}

/** "Ranger les onglets…": a folder with lines of tabs in it (the same strokes as the archive box beside it). */
export function TidyGlyph({ small = false }: { small?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width={small ? 13 : 16} height={small ? 13 : 16} {...base} strokeWidth="1.5">
      <path d="M2 4.2c0-.7.6-1.2 1.2-1.2h2.6l1.4 1.6h5.6c.7 0 1.2.5 1.2 1.2v5.6c0 .7-.5 1.2-1.2 1.2H3.2c-.6 0-1.2-.5-1.2-1.2z" />
      <path d="M5 8h6M5 10.3h3.5" />
    </svg>
  )
}

/** The arrow of a download in the chip and in the bubbles. */
export function ArrowDownGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} {...base} strokeWidth="1.5">
      <path d="M8 2.500v8M4.500 7.500 8 11l3.500-3.500M3 13h10" />
    </svg>
  )
}

/** A tick (a download that came to its end) and a warning triangle (one that did not): the colour is never the only signal. */
export function TickGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} {...base} strokeWidth="1.8">
      <path d="m3.500 8.500 3 3 6-7" />
    </svg>
  )
}
export function WarnGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} {...base} strokeWidth="1.6">
      <path d="M8 2.200 14.500 13.500h-13zM8 6.500v3.200M8 11.600v.01" />
    </svg>
  )
}

/** "Reprendre": an arrow that turns back on itself. */
export function RetryGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} {...base} strokeWidth="1.5">
      <path d="M13 8a5 5 0 1 1-1.500-3.600M13 3v3h-3" />
    </svg>
  )
}

/** « Mettre en veille » in the resource panel: a crescent moon, in the strokes of the glyphs beside it. */
export function MoonGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} {...base} strokeWidth="1.6">
      <path d="M13.500 9.800A5.800 5.800 0 0 1 6.200 2.500a5.800 5.800 0 1 0 7.300 7.300z" />
    </svg>
  )
}

/** The chevron of the header of a space: it says the name is a button that opens a menu. */
export function ChevronDownGlyph() {
  return (
    <svg className="space-header-chevron" viewBox="0 0 16 16" width="12" height="12" {...base} strokeWidth="1.8">
      <path d="m4 6 4 4 4-4" />
    </svg>
  )
}
