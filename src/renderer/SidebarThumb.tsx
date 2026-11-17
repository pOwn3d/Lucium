// A small drawing of the sidebar in the theme of a space: its header (icon and name), the row of favourites, a few tabs, and the footer with the icons of
// the spaces. The theme panel shows it taking the theme under the pointer; the icon picker shows it wearing the icon being chosen. It is a picture,
// not a control: nothing in it can be reached, and it is hidden from assistive technology except for its name.

import type { CSSProperties, ReactNode } from 'react'
import { resolveAppearance, themeVars, type SpaceTheme } from '@shared/theme'
import { t } from '@shared/i18n'
import './sidebar-thumb.css'

export interface SidebarThumbProps {
  theme: SpaceTheme
  /** The name in the header, and what stands before it (an icon). */
  name: string
  mark: ReactNode
  /** The icons of the footer, the one at `current` being the space shown. Without any, no footer. */
  footer?: ReactNode[]
  current?: number
  /** A word above it ("Aperçu"). */
  caption?: string
  systemDark: boolean
  className?: string
}

/** The custom properties a theme gives the drawing: the gradient and the ink, the tiles and the selected tile. */
export function thumbStyle(theme: SpaceTheme, systemDark: boolean): CSSProperties {
  const vars = themeVars(theme, resolveAppearance(theme, systemDark))
  return { '--th-bg': vars['--bg-gradient'], '--th-ink': vars['--text'], '--th-tile': vars['--hover'], '--th-sel': vars['--active'] } as CSSProperties
}

export function SidebarThumb({ theme, name, mark, footer, current = 0, caption, systemDark, className }: SidebarThumbProps) {
  return (
    <div className={['sb-thumb', className].filter(Boolean).join(' ')} style={thumbStyle(theme, systemDark)} role="img" aria-label={t('sidebar-thumb.apercu-de-la-barre-laterale')}>
      {caption && (
        <span className="sb-cap" aria-hidden="true">
          {caption}
        </span>
      )}
      <div className="sb-fav" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </div>
      <div className="sb-head" aria-hidden="true">
        <span className="sb-mark">{mark}</span>
        <span className="sb-name">{name}</span>
      </div>
      <div className="sb-rows" aria-hidden="true">
        <i />
        <i />
        <i className="sel" />
        <i />
        <i />
      </div>
      {footer && footer.length > 0 && (
        <div className="sb-foot" aria-hidden="true">
          {footer.map((icon, index) => (
            <span key={index} aria-current={index === current ? 'true' : undefined}>
              {icon}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
