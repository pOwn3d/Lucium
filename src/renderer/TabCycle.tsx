// The panel of ⌃Tab: a head, a card for each tab in the order they were used (the selected one on the accent
// of the space) and a foot with the position. The order and the keys are not drawn here: the shell has them.
// The shell moves the selection (`onCycleIndex`) as Tab is pressed and ends the panel when ⌃ is released; this only draws it.

import { useEffect, useRef, useState } from 'react'
import type { CycleCard, CycleMember } from '@shared/tab-cycle'
import { api } from './api'
import './tab-cycle.css'
import { t, tp } from '@shared/i18n'
import { iconSource } from '@shared/site-icon'

const EYE_OFF = (
  <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 3l18 18M10.6 5.1A9.6 9.6 0 0 1 12 5c5 0 8.600 4.200 9.700 6.100a1.900 1.900 0 0 1 0 1.800 15 15 0 0 1-2.600 3.100M6.700 6.800A15 15 0 0 0 2.300 11.900a1.900 1.900 0 0 0 0 1.800C3.400 15.600 7 19.800 12 19.800a9.400 9.400 0 0 0 4.200-1M9.900 9.900a3 3 0 0 0 4.200 4.200" />
  </svg>
)

/** The little icon of a tab: its emoji, its site icon, or a grey square. */
function Icon({ member }: { member: CycleMember }) {
  if (member.icon) return <span className="tc-icon tc-emoji">{member.icon}</span>
  const source = iconSource(member.faviconUrl)
  if (source) return <img className="tc-icon" src={source} alt="" draggable={false} />
  return <span className="tc-icon tc-blank" />
}

function Picture({ member }: { member: CycleMember }) {
  return member.thumb ? <img className="tc-img" src={member.thumb} alt="" draggable={false} /> : <div className="tc-none">{EYE_OFF}</div>
}

export function TabCycle({ cards, index: first }: { cards: CycleCard[]; index: number }) {
  const [index, setIndex] = useState(first)
  const selected = useRef<HTMLDivElement>(null)
  // An effect hands React what it returns to undo it: a bare `scrollIntoView(...)` or the bridge's remover as the whole body would hand it
  // something that is not a function, and React then unmounts the whole layer for good (every panel after this one is blank).
  useEffect(() => {
    const off = api().onCycleIndex(setIndex)
    return () => {
      off()
    }
  }, [])
  // Many tabs: the row scrolls, and keeps the selection in view.
  useEffect(() => {
    selected.current?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }, [index])
  return (
    <div className="tc-panel" role="group" aria-label={t('tab-cycle.onglets-recents')}>
      <div className="tc-head">
        <b>{t('tab-cycle.onglets-recents')}</b>
        <span className="tc-count">{tp('tab-cycle.tabs', cards.length)}</span>
      </div>
      <div className="tc-cards" role="listbox" aria-label={t('tab-cycle.onglets-recents')}>
        {cards.map((card, i) => (
          <div key={card.id} ref={i === index ? selected : undefined} className={`tc-card ${i === index ? 'selected' : ''}`} role="option" aria-selected={i === index}>
            <div className={`tc-thumb ${card.members.length > 1 ? `pair ${card.grid ? `grid span-${card.grid.span ?? 'none'}` : (card.orientation ?? 'horizontal')}` : ''}`}>
              {card.members.map((m) => (
                <Picture key={m.id} member={m} />
              ))}
            </div>
            <div className="tc-titles">
              {card.members.map((m) => (
                <span key={m.id} className="tc-ttl" title={m.title}>
                  <Icon member={m} />
                  <span className="tc-title">{m.title}</span>
                </span>
              ))}
            </div>
            <div className="tc-meta">{card.members.length > 1 ? t('tab-cycle.vue-scindee') : card.members[0]!.host}</div>
          </div>
        ))}
      </div>
      <div className="tc-bar">
        <span className="tc-pos">
          {index + 1} / {cards.length}
        </span>
        <span>{t('tab-cycle.relachez-pour-ouvrir-l-onglet-selectionne-echap-annule')}</span>
      </div>
    </div>
  )
}
