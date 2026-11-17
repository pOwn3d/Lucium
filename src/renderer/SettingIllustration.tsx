// The animated card of a setting: a 300 x 170 scene drawn in CSS (settings-illustrations.css), a caption, and a play / pause button.
// The scenes are plain markup, built from the same parts; the animation is in the sheet, by the id of the setting, so nothing runs while no card is
// open. The words in a scene are the catalogue's, in the language of the window.

import { useContext, useState, type CSSProperties, type ReactNode } from 'react'
import { t } from '@shared/i18n'
import { illustrationTip, type Illustration } from '@shared/settings-illustrations'
import type { PlatformId } from '@shared/platform'
import { PlatformContext, SettingsStateContext } from './settings-context'
import { PauseGlyph, PlayGlyph } from './media-glyphs'
import './settings-illustrations.css'

const width = (value: string): CSSProperties => ({ ['--w' as string]: value })
const at = (x0: number, y0: number, x1: number, y1: number): CSSProperties => ({ ['--x0' as string]: `${x0}px`, ['--y0' as string]: `${y0}px`, ['--x1' as string]: `${x1}px`, ['--y1' as string]: `${y1}px` })

/** A row of the mini sidebar: `on` is the current tab, the other classes are the ones the scene animates. */
const T = ({ cls = '', w = '60%' }: { cls?: string; w?: string }) => <i className={cls} style={width(w)} />
const Sidebar = ({ children, cls = '' }: { children: ReactNode; cls?: string }) => (
  <div className={`sb ${cls}`.trim()}>
    <div className="hd" />
    {children}
  </div>
)
const Page = ({ children, cls = '' }: { children: ReactNode; cls?: string }) => <div className={`pg ${cls}`.trim()}>{children}</div>
const Lines = ({ cls = '' }: { cls?: string }) => (
  <>
    <b className={`t ${cls}`.trim()} />
    <b className={cls} style={width('80%')} />
    <b className={cls} style={width('65%')} />
    <b className={cls} style={width('72%')} />
  </>
)
const FourTabs = () => (
  <Sidebar>
    <T cls="on" w="70%" />
    <T w="55%" />
    <T w="64%" />
    <T w="48%" />
  </Sidebar>
)

/** The words drawn inside the scenes, kept apart so that the markup below reads as markup. */
function words() {
  return {
    memory: t('settings-illustrations.scene-memory'),
    memoryBefore: t('settings-illustrations.scene-memory-before'),
    memoryAfter: t('settings-illustrations.scene-memory-after'),
    archive: t('settings-illustrations.scene-archive'),
    idle: t('settings-illustrations.scene-idle'),
    order: t('settings-illustrations.scene-order'),
    recent: t('settings-illustrations.scene-recent'),
    visible: (count: number) => t('settings-illustrations.scene-visible', { count }),
    mail: t('settings-illustrations.scene-mail'),
    mini: t('settings-illustrations.scene-mini'),
    ad: t('settings-illustrations.scene-ad'),
    fileBefore: t('settings-illustrations.scene-file-before'),
    fileAfter: t('settings-illustrations.scene-file-after'),
    fileMeta: t('settings-illustrations.scene-file-meta'),
    back: t('settings-illustrations.scene-back'),
    percent: (percent: number) => t('appearance-settings.percent', { percent }),
    session: t('settings-illustrations.scene-session'),
    relaunch: t('settings-illustrations.scene-relaunch'),
    query: t('settings-illustrations.scene-query'),
    suggestions: [t('settings-illustrations.scene-suggest-1'), t('settings-illustrations.scene-suggest-2'), t('settings-illustrations.scene-suggest-3')],
    cookies: t('settings-illustrations.scene-cookies'),
    saveAs: t('settings-illustrations.scene-save-as'),
    downloads: t('settings-illustrations.scene-folder-downloads'),
    documents: t('settings-illustrations.scene-folder-documents'),
    save: t('settings-illustrations.scene-save'),
    fileMetaDocuments: t('settings-illustrations.scene-file-meta-documents')
  }
}

/** A window of the scenes that show more than one (the session restored): its sidebar and its page, smaller, with `tabs` rows. */
const SmallWindow = ({ cls, tabs }: { cls: string; tabs: readonly string[] }) => (
  <div className={`win ${cls} a`}>
    <Sidebar>
      {tabs.map((share, index) => (
        <T key={index} cls={index === 0 ? 'on a' : 'a'} w={share} />
      ))}
    </Sidebar>
    <Page>
      <div className="ph" />
      <b className="t" />
      <b style={width('80%')} />
      <b style={width('62%')} />
    </Page>
  </div>
)

/**
 * The light and the dark of the window, drawn with the tokens of each scheme (`tk-light`, `tk-dark` of tokens.css): what the setting really shows. Each
 * carries the Mac's appearance in a disc: a sun on the light one, a moon on the dark one.
 */
const Look = ({ scheme }: { scheme: 'light' | 'dark' }) => (
  <div className={`look tk-${scheme} ${scheme === 'dark' ? 'a' : ''}`.trim()}>
    <FourTabs />
    <Page>
      <div className="ph" />
      <Lines />
    </Page>
    <span className="mode">{scheme === 'light' ? <span className="sun a" /> : <span className="moon" />}</span>
  </div>
)

/** One key cap of a scene: the symbol on macOS, the word elsewhere. */
const Cap = ({ cls = 'key', style, children }: { cls?: string; style?: CSSProperties; children: ReactNode }) => (
  <span className={cls} style={style}>
    {children}
  </span>
)

/**
 * The keys of the scenes that show a press. macOS draws the symbols of its modifiers (⌃ ⌥ ⌘ ⇥); the other systems have no Command key, their main modifier is
 * Ctrl, and their caps are words (wider: the scene that places its caps by hand moves the second one along).
 */
const capsOf = (platform: PlatformId | null) => (platform === 'darwin' ? { ctrl: '⌃', alt: '⌥', cmd: '⌘', tab: '⇥', mac: true } : { ctrl: 'Ctrl', alt: 'Alt', cmd: 'Ctrl', tab: 'Tab', mac: false })

function Scene({ id }: { id: string }) {
  const w = words()
  const caps = capsOf(useContext(PlatformContext))
  switch (id) {
    case 'sleepAfterMinutes':
      return (
        <>
          <Sidebar>
            <T cls="on" w="70%" />
            <T cls="sleepy a" w="55%" />
            <T w="64%" />
            <T w="48%" />
          </Sidebar>
          <span className="zz a">{'zz'}</span>
          <Page>
            <div className="ph" />
            <Lines />
            <div className="gauge">
              {w.memory}{' '}
              <span className="swap">
                <span className="n1 a">{w.memoryBefore}</span>
                <span className="n2 a">{w.memoryAfter}</span>
              </span>
              <div className="bar">
                <i className="a" />
              </div>
            </div>
          </Page>
        </>
      )
    case 'hoverCards':
      return (
        <>
          <Sidebar>
            <T cls="on" w="70%" />
            <T w="55%" />
            <T cls="hov a" w="64%" />
            <T w="48%" />
          </Sidebar>
          <Page>
            <div className="ph" />
            <Lines />
          </Page>
          <span className="cur a" style={at(200, 120, 48, 58)} />
          <div className="hcard pop a">
            <b />
            <small>{'docs.example.org/alpha'}</small>
            <div className="th" />
          </div>
        </>
      )
    case 'autoArchiveHours':
      return (
        <>
          <Sidebar>
            <T cls="on" w="70%" />
            <T w="55%" />
            <T w="64%" />
            <T cls="arch a" w="48%" />
            <div className="abox">
              {w.archive} ·{' '}
              <span className="swap">
                <span className="n1 a">2</span>
                <span className="n2 a">3</span>
              </span>
            </div>
          </Sidebar>
          <span className="key clock a">{w.idle}</span>
          <Page>
            <div className="ph" />
            <Lines />
          </Page>
        </>
      )
    case 'dragToSplit':
      return (
        <>
          <FourTabs />
          <Page>
            <div className="ph" />
            <Lines />
            <div className="drop a" />
            <div className="pane2 a">
              <div className="ph" />
              <b className="t" />
              <b style={width('80%')} />
            </div>
          </Page>
          <span className="ghost a" />
          <span className="cur a" style={at(40, 50, 240, 92)} />
        </>
      )
    case 'tabTree':
      return (
        <>
          <Sidebar>
            <T w="55%" />
            <T cls="on" w="70%" />
            <T cls="child a" w="50%" />
            <T w="64%" />
            <T w="48%" />
          </Sidebar>
          <Page>
            <div className="ph" />
            <b className="t" />
            <b style={width('80%')} />
            <b className="lnk a" style={width('46%')} />
            <b style={width('72%')} />
          </Page>
          <span className="cur a" style={at(220, 130, 150, 66)} />
        </>
      )
    case 'tabCycleRecent':
      return (
        <>
          <Sidebar>
            <T w="55%" />
            <T cls="on" w="70%" />
            <T w="64%" />
            <T w="48%" />
          </Sidebar>
          <Page>
            <div className="ph" />
            <Lines />
          </Page>
          <Cap style={{ left: caps.mac ? 110 : 96, top: 16 }}>{caps.ctrl}</Cap>
          <Cap cls="key tabk a" style={{ left: caps.mac ? 132 : 128, top: 16 }}>{caps.tab}</Cap>
          <div className="cyc a">
            <div className="th">
              <i />
              <i />
              <i />
              <i />
              <span className="hl a" />
            </div>
            <small>
              {w.order}{' '}
              <span className="swap">
                <span className="n1 a">{w.recent}</span>
                <span className="n2 a">{w.recent}</span>
              </span>
            </small>
          </div>
        </>
      )
    case 'sidebarRight':
      return (
        <>
          <Sidebar cls="a">
            <T cls="on" w="70%" />
            <T w="55%" />
            <T w="64%" />
            <T w="48%" />
          </Sidebar>
          <Page cls="a">
            <div className="ph" />
            <Lines />
          </Page>
        </>
      )
    case 'compactMode':
      return (
        <>
          <Sidebar>
            <T cls="a fav" />
            <T cls="a on" w="70%" />
            <T cls="a" w="55%" />
            <T cls="a" w="64%" />
            <T cls="a" w="48%" />
            <T cls="a" w="60%" />
            <T cls="a" w="52%" />
            <T cls="a" w="66%" />
          </Sidebar>
          <Page>
            <div className="ph" />
            <Lines />
          </Page>
          <span className="count">
            <span className="swap">
              <span className="n1 a">{w.visible(5)}</span>
              <span className="n2 a">{w.visible(8)}</span>
            </span>
          </span>
        </>
      )
    case 'readableMode':
      return (
        <>
          <FourTabs />
          <div className="pg a">
            <div className="ph a" />
            <Lines cls="a" />
          </div>
          <span className="moon a" />
        </>
      )
    case 'littleArcShortcut':
      return (
        <>
          <div className="app">
            <div className="bar" />
            <div className="title">{w.mail}</div>
            <b style={width('50%')} />
            <b style={width('70%')} />
            <b style={width('62%')} />
            <b style={width('74%')} />
            <b style={width('40%')} />
          </div>
          <div className="keys">
            {caps.mac ? (
              <>
                <Cap cls="key press a">{caps.alt}</Cap>
                <Cap cls="key press a">{caps.cmd}</Cap>
              </>
            ) : (
              <>
                <Cap cls="key press a">{caps.cmd}</Cap>
                <Cap cls="key press a">{caps.alt}</Cap>
              </>
            )}
            <span className="key press a">N</span>
          </div>
          <div className="mini pop a">
            <small>{w.mini}</small>
            <div className="cb" />
            <div className="pg2" />
          </div>
        </>
      )
    case 'peekWithShift':
      return (
        <>
          <FourTabs />
          <Page>
            <div className="ph" />
            <b className="t" />
            <b style={width('80%')} />
            <b className="lnk" style={width('46%')} />
            <b style={width('72%')} />
          </Page>
          <span className="key shift a" style={{ left: 170, top: 50 }}>⇧</span>
          <span className="cur a" style={at(240, 130, 150, 66)} />
          <div className="dim a" />
          <div className="peek pop a">
            <div className="bar" />
            <div className="url" />
            <b className="t" />
            <div className="img" />
            <b style={width('70%')} />
          </div>
        </>
      )
    case 'blockAds':
      return (
        <>
          <FourTabs />
          <Page>
            <div className="ph" />
            <Lines />
            <b style={width('58%')} />
            <div className="ad a" style={{ left: 10, top: 30, width: 52, height: 38 }}>{w.ad}</div>
            <div className="ad a" style={{ right: 10, bottom: 10, width: 120, height: 22 }}>{w.ad}</div>
            <span className="trk a" style={{ left: 60, top: 110 }} />
            <span className="trk a" style={{ left: 150, top: 36 }} />
          </Page>
          <div className="shield a">
            <span className="swap">
              <span className="n1 a">0</span>
              <span className="n2 a">12</span>
            </span>
          </div>
        </>
      )
    case 'reduceFingerprint':
      return (
        <>
          <FourTabs />
          <Page>
            <div className="ph" />
            <b className="t" />
          </Page>
          <div className="cv" />
          <div className="fp a" />
          <div className="idc">
            <span className="n1 a">7f3a-91c2</span>
            <span className="n2 a" style={{ position: 'absolute', left: 6, top: 3, whiteSpace: 'nowrap' }}>2b9e-04d1</span>
            <span className="n3 a" style={{ left: 6, top: 3 }}>c81d-7a1a</span>
          </div>
        </>
      )
    case 'tidyDownloads':
      return (
        <>
          <FourTabs />
          <Page>
            <div className="ph" />
            <Lines />
          </Page>
          <span className="arrow a" />
          <div className="dl">
            <span className="doc" />
            <span className="nm">
              <span className="swap">
                <span className="n1 a">{w.fileBefore}</span>
                <span className="n2 a">{w.fileAfter}</span>
              </span>
              <small>{w.fileMeta}</small>
            </span>
          </div>
        </>
      )
    case 'boostsEnabled':
      return (
        <>
          <FourTabs />
          <Page>
            <div className="ph a" />
            <div className="ban a" />
            <Lines cls="a" />
          </Page>
          <span className="bolt a" />
        </>
      )
    case 'mouseGestures':
      return (
        <>
          <FourTabs />
          <div className="pg">
            <div className="layer prev">
              <div className="ph" />
              <b className="t" />
              <b style={width('78%')} />
              <b style={width('60%')} />
            </div>
            <div className="layer a">
              <div className="ph" />
              <Lines />
            </div>
          </div>
          <span className="ring a" />
          <span className="trail a" />
          <span className="cur a" style={at(222, 92, 146, 92)} />
          <span className="tag back a">{w.back}</span>
        </>
      )
    case 'interfaceAppearance':
      return (
        <>
          <Look scheme="light" />
          <Look scheme="dark" />
        </>
      )
    case 'uiScale':
      return (
        <>
          <Sidebar>
            <T cls="on a" w="70%" />
            <T cls="a" w="55%" />
            <T cls="a" w="64%" />
            <T cls="a" w="48%" />
            <T cls="a" w="58%" />
          </Sidebar>
          <Page>
            <div className="ph" />
            <Lines />
            <b style={width('58%')} />
          </Page>
          <div className="scale">
            <span className="track">
              <span className="fill a" />
              <span className="thumb a" />
            </span>
            <span className="swap">
              <span className="n1 a">{w.percent(100)}</span>
              <span className="n2 a">{w.percent(125)}</span>
            </span>
          </div>
        </>
      )
    case 'restoreWindows':
      return (
        <>
          <SmallWindow cls="w1" tabs={['70%', '55%', '64%', '48%']} />
          <SmallWindow cls="w2" tabs={['62%', '50%', '68%']} />
          <div className="keys">
            <Cap cls="key a">{caps.cmd}</Cap>
            <span className="key a">Q</span>
          </div>
          <span className="app a" />
          <span className="sess">
            <span className="n1 a">{w.session}</span>
            <span className="n2 a">{w.relaunch}</span>
          </span>
        </>
      )
    case 'searchSuggestions':
      return (
        <>
          <FourTabs />
          <Page>
            <div className="ph" />
            <Lines />
          </Page>
          <div className="cmd">
            <div className="q">
              <span className="ico mag" />
              <span className="typed a">{w.query}</span>
            </div>
            <span className="r sel a">
              <span className="ico mag" />
              {w.query}
            </span>
            {w.suggestions.map((text) => (
              <span key={text} className="r sug a">
                <span className="ico mag" />
                {text}
              </span>
            ))}
            <span className="r a">
              <span className="ico tab" />
              <b style={width('52%')} />
            </span>
            <span className="r a">
              <span className="ico clock" />
              <b style={width('64%')} />
            </span>
          </div>
        </>
      )
    case 'blockCookieBanners':
      return (
        <>
          <FourTabs />
          <Page>
            <div className="ph" />
            <span className="load a" />
            <Lines />
            <b style={width('58%')} />
            <b style={width('76%')} />
            <b style={width('50%')} />
            <b style={width('68%')} />
            <b style={width('44%')} />
            <div className="ckb a">
              <span className="ck" />
              <span className="msg">{w.cookies}</span>
              <span className="btns">
                <i />
                <i />
              </span>
            </div>
          </Page>
          <span className="nock a" />
        </>
      )
    case 'downloadAskWhere':
      return (
        <>
          <FourTabs />
          <Page>
            <div className="ph" />
            <b className="t" />
            <b style={width('80%')} />
            <b className="lnk a" style={width('40%')} />
            <b style={width('72%')} />
            <b style={width('60%')} />
            <div className="sheet a">
              <span className="ttl">{w.saveAs}</span>
              <span className="fld">{w.fileAfter}</span>
              <span className="dir a">
                <span className="fold" />
                <span className="swap">
                  <span className="n1 a">{w.downloads}</span>
                  <span className="n2 a">{w.documents}</span>
                </span>
              </span>
              <span className="btn a">{w.save}</span>
            </div>
          </Page>
          <span className="cur a" />
          <div className="dl a">
            <span className="doc" />
            <span className="nm">
              {w.fileAfter}
              <small>{w.fileMetaDocuments}</small>
            </span>
          </div>
        </>
      )
    default:
      return null
  }
}

/**
 * The card under a row: the scene and its caption (with a play / pause button), then a few lines of text. With "reduce motion" the sheet shows the
 * state "after" and hides the button, which would have nothing to stop.
 */
export function SettingIllustration({ illustration, name }: { illustration: Illustration; name: string }) {
  const [paused, setPaused] = useState(false)
  const settings = useContext(SettingsStateContext)
  const platform = useContext(PlatformContext)
  const tip = illustrationTip(illustration, settings?.keyBindings ?? {}, platform ?? undefined)
  return (
    <>
      <figure className={`illu ${paused ? 'paused' : ''}`.trim()} data-illu={illustration.key} aria-label={t('settings-illustrations.effet-de-name', { name })}>
        {/* The drawing is a picture: its words (a fake address, key caps, both the "before" and the "after" state) say nothing read one after
            the other. The name of the figure and its caption say the effect. */}
        <div className="scene" aria-hidden="true">
          <Scene id={illustration.key} />
          <span className="phase">
            <span>{t('settings-illustrations.avant')}</span>
            <span>{t('settings-illustrations.pendant')}</span>
            <span>{t('settings-illustrations.apres')}</span>
          </span>
          <span className="prog" />
        </div>
        <figcaption>{t(illustration.caption)}</figcaption>
        <button type="button" className="play" aria-label={paused ? t('settings-illustrations.lire') : t('settings-illustrations.pause')} onClick={() => setPaused(!paused)}>
          {paused ? <PlayGlyph height={11} /> : <PauseGlyph height={11} />}
        </button>
      </figure>
      <div className="txt">
        <b>{t('settings-illustrations.ce-que-vous-verrez')}</b>
        {tip && <span className="tip">{tip}</span>}
        <span className="esc">{t('settings-illustrations.echap-referme')}</span>
      </div>
    </>
  )
}
