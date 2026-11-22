import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { DEMO_TEXTS, demoPlaying, type DiscoverDemo as DemoId } from '@shared/discover'
import { t } from '@shared/i18n'
import './discover-demos.css'

/** Skeleton lines: the text of a fake page, which says nothing and so needs no translation. */
const Lines = ({ n }: { n: number }): ReactNode => Array.from({ length: n }, (_, i) => <i key={i} className="dvd-line" />)

/** A fake window: a column of tabs on the left, a page on the right. Drawn with the tokens, never a picture, so there is nothing to refresh when the interface changes. */
const Window = ({ children, tabs }: { children: ReactNode; tabs?: ReactNode }): ReactNode => (
  <div className="dvd-win">
    <div className="dvd-side">
      {tabs ?? (
        <>
          <span className="dvd-tab"><i className="dvd-line" /></span>
          <span className="dvd-tab dvd-hot"><i className="dvd-line" /></span>
          <span className="dvd-tab"><i className="dvd-line" /></span>
        </>
      )}
    </div>
    <div className="dvd-page">{children}</div>
  </div>
)

/** The command bar with a text being typed and the lines it brings up (the first one chosen): the scene of two demos. */
const Bar = ({ typed }: { typed: string }): ReactNode => (
  <div className="dvd-barscene">
    <div className="dvd-field">
      <span className="dvd-typed" data-step="type">{typed}</span>
    </div>
    <div className="dvd-row dvd-hot" data-step="a"><i className="dvd-dot" /><i className="dvd-line" /></div>
    <div className="dvd-row" data-step="b"><i className="dvd-dot" /><i className="dvd-line" /></div>
    <div className="dvd-row" data-step="c"><i className="dvd-dot" /><i className="dvd-line" /></div>
  </div>
)

/** One scene for each demo. A Record: a demo added to the catalogue without a scene does not compile. Every element that moves says its step (`data-step`); at rest, an element is on its final picture. */
const SCENES: Record<DemoId, () => ReactNode> = {
  'tab-reminders': () => (
    <div className="dvd-win">
      <div className="dvd-side">
        <span className="dvd-tab"><i className="dvd-line" /></span>
        <span className="dvd-tab dvd-hot" data-step="leave">{t('discover.demo-rappel-onglet')}</span>
        <span className="dvd-tab"><i className="dvd-line" /></span>
      </div>
      <div className="dvd-page"><Lines n={4} /></div>
      <div className="dvd-pop" data-step="a"><span className="dvd-hot">{t('reminder.me-le-rappeler')}</span></div>
      <div className="dvd-toast dvd-hot" data-step="c">{t('discover.demo-rappel-toast')}</div>
    </div>
  ),
  'focus-mode': () => (
    <Window>
      <Lines n={4} />
      <span className="dvd-chip" data-step="a">25:00</span>
      <div className="dvd-block" data-step="c">{t('discover.demo-concentration-bloque')}</div>
    </Window>
  ),
  markdown: () => (
    <Window>
      <Lines n={4} />
      <div className="dvd-pop dvd-pop-wide" data-step="a"><span className="dvd-hot">{t('menu.enregistrer-la-page-en-markdown')}</span></div>
      <div className="dvd-file dvd-hot" data-step="c"><b>page.md</b><i className="dvd-line" /><i className="dvd-line" /></div>
    </Window>
  ),
  totp: () => (
    <Window>
      <span className="dvd-dim">{t('discover.demo-totp-code')}</span>
      <span className="dvd-code" data-step="b">482 913</span>
      <i className="dvd-drain" data-step="drain" />
      <Lines n={2} />
    </Window>
  ),
  prefixes: () => <Bar typed={t('discover.demo-prefixes-saisie')} />,
  'split-view': () => (
    <div className="dvd-win dvd-split">
      <div className="dvd-page"><Lines n={5} /></div>
      <div className="dvd-page dvd-second" data-step="grow"><Lines n={5} /></div>
    </div>
  ),
  'command-bar': () => <Bar typed={t('discover.demo-barre-saisie')} />,
  capture: () => (
    <Window>
      <Lines n={5} />
      <i className="dvd-frame" data-step="frame" />
      <div className="dvd-toast dvd-hot" data-step="d">{t('discover.demo-capture-prete')}</div>
    </Window>
  )
}

/**
 * The animated demo of a card (docs/fonctions.md, « Découvrir Lucium »): a scene of 6 to 8 seconds in a loop, a text equivalent under it, and a button that pauses it.
 * It does not move before it is on screen, nor while it is paused (WCAG 2.2.2); « Réduire les animations » leaves its final picture and the text (discover-demos.css).
 * The scene is an image for a screen reader, labelled by the text equivalent, which stays visible. Nothing is loaded: no picture, no video, no network.
 */
export function DiscoverDemo({ demo, name, describedBy }: { demo: DemoId; name: string; describedBy: string }) {
  const captionId = useId()
  const ref = useRef<HTMLElement>(null)
  const [visible, setVisible] = useState(false)
  const [paused, setPaused] = useState(false)

  useEffect(() => {
    const node = ref.current
    if (!node) return undefined
    // Chromium always has it; without it the demo plays rather than stays blank.
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return undefined
    }
    const observer = new IntersectionObserver((entries) => setVisible(entries.some((entry) => entry.isIntersecting)), { threshold: 0.4 })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  return (
    <figure ref={ref} className="dvd" data-demo={demo} data-playing={String(demoPlaying(visible, paused))} data-paused={String(paused)}>
      <div className="dvd-stage" role="img" aria-labelledby={captionId}>
        {SCENES[demo]()}
      </div>
      <figcaption id={captionId} className="dvd-caption">
        <b>{t('discover.demo-texte-label')}</b> {t(DEMO_TEXTS[demo])}
      </figcaption>
      <button type="button" className="tk-btn dvd-pause" aria-label={paused ? t('discover.demo-reprendre-nom', { name }) : t('discover.demo-pause-nom', { name })} aria-describedby={describedBy} onClick={() => setPaused((was) => !was)}>
        {paused ? t('discover.demo-reprendre') : t('discover.demo-pause')}
      </button>
    </figure>
  )
}
