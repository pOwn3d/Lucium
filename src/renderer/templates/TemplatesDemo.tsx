// The demonstration page of the templates: each family in each of its states, on the tokens, light or dark, for any hue. It is what the tests render, and
// what can be rendered to a file (renderToStaticMarkup, with the sheets of the templates and tokens.css) to look at the system without starting the browser.
// The sample texts below are demo data, not words of the interface.

import { useState, type ReactNode } from 'react'
import { ERROR_PAGE_STYLE, ERROR_TONES, errorButton, errorFrame } from '@shared/error-page-template'
import { ArchiveGlyph, DownloadGlyph, KeyGlyph, LockGlyph, QrGlyph, TrashGlyph } from './glyphs'
import { Invite } from './Invite'
import { ListEmpty, ListGroup, ListPanel, ListRow } from './ListPanel'
import { Sheet, SheetField } from './Sheet'
import { useUndoQueue } from './useUndoQueue'
import './primitives.css'

const noop = (): void => undefined

interface DemoItem {
  id: string
  title: string
  address: string
  when: string
  group: string
}

const ITEMS: readonly DemoItem[] = [
  { id: 'a', title: 'Tableau de bord', address: 'tableau.exemple.fr/accueil', when: '09:41', group: 'Aujourd’hui' },
  { id: 'b', title: 'Agenda partagé', address: 'agenda.exemple.fr', when: '08:02', group: 'Aujourd’hui' },
  { id: 'c', title: 'Notes de réunion', address: 'notes.exemple.fr/2026/10', when: '17:30', group: 'Hier' },
  { id: 'd', title: 'Galerie photo', address: 'galerie.exemple.fr/albums/2026', when: '11:15', group: 'Hier' }
]

const letter = (item: DemoItem): ReactNode => item.title.charAt(0)

/** The list panel as a panel of the application uses it: a search, a filter chip, rows with an action, a deletion that can be taken back. */
export function DemoList({ hue }: { hue?: number }) {
  const [filter, setFilter] = useState('')
  const [pressed, setPressed] = useState(false)
  const undo = useUndoQueue()
  const needle = filter.trim().toLowerCase()
  const shown = ITEMS.filter((item) => !undo.hidden.has(item.id) && (!needle || `${item.title} ${item.address}`.toLowerCase().includes(needle)) && (!pressed || item.group === 'Hier'))
  const groups = [...new Set(shown.map((item) => item.group))]
  return (
    <ListPanel
      title="Historique"
      icon={<ArchiveGlyph />}
      count={shown.length}
      hue={hue}
      search={{ value: filter, onChange: setFilter, label: 'Rechercher dans l’historique', placeholder: 'Titre ou adresse', onSubmit: noop }}
      filters={
        <button type="button" className="tk-chip" aria-pressed={pressed} onClick={() => setPressed(!pressed)}>
          Hier seulement
        </button>
      }
      filtersLabel="Filtres"
      footStart={
        <button type="button" className="tk-btn quiet danger" disabled={shown.length === 0}>
          Effacer l’historique
        </button>
      }
      onDone={noop}
      undo={undo.panel}
    >
      {shown.length === 0 && <ListEmpty icon={<ArchiveGlyph />} title="Rien à afficher" hint="Les pages que vous visitez apparaissent ici." />}
      {groups.map((group) => (
        <ListGroup key={group} title={group}>
          {shown
            .filter((item) => item.group === group)
            .map((item) => (
              <ListRow
                key={item.id}
                icon={letter(item)}
                title={item.title}
                subtitle={item.address}
                meta={item.when}
                onOpen={noop}
                actions={
                  <button type="button" className="tk-btn quiet icon" aria-label={`Oublier ${item.title}`} onClick={() => undo.remove(item.id, 'Page oubliée', noop)}>
                    <TrashGlyph />
                  </button>
                }
              />
            ))}
        </ListGroup>
      ))}
    </ListPanel>
  )
}

export function DemoSheet({ hue }: { hue?: number }) {
  const [address, setAddress] = useState('htp://agenda.local')
  const invalid = !/^https?:\/\//.test(address)
  return (
    <Sheet
      title="Modifier le favori"
      context="agenda.local"
      glyph={<QrGlyph />}
      hue={hue}
      onCancel={noop}
      onSubmit={noop}
      primary={{ label: 'Enregistrer', disabled: invalid }}
      footStart={
        <button type="button" className="tk-btn quiet danger">
          Retirer des favoris
        </button>
      }
    >
      <SheetField label="Nom">{(field) => <input className="tk-field" {...field} defaultValue="Agenda partagé" data-autofocus />}</SheetField>
      <SheetField label="Adresse" error={invalid ? 'L’adresse doit commencer par http:// ou https://.' : undefined} help="L’adresse que le favori ouvre.">
        {(field) => <input className="tk-field" {...field} value={address} onChange={(event) => setAddress(event.target.value)} />}
      </SheetField>
    </Sheet>
  )
}

export function DemoInvites({ hue }: { hue?: number }) {
  const [remember, setRemember] = useState(false)
  return (
    <>
      <Invite
        scrim={false}
        tone="info"
        glyph={<LockGlyph />}
        hue={hue}
        title={
          <>
            <strong>exemple.org</strong> souhaite connaître votre position
          </>
        }
        lead="Le site l’utilisera tant que la page est ouverte."
        remember={{ label: 'Se souvenir pour ce site', checked: remember, onChange: setRemember }}
        dismiss={{ label: 'Refuser', onClick: noop }}
        accept={{ label: 'Autoriser', onClick: noop }}
      />
      <Invite
        scrim={false}
        tone="warn"
        glyph={<KeyGlyph />}
        hue={hue}
        kicker="Connexion demandée"
        title={
          <>
            <strong>agenda.local</strong> demande un identifiant
          </>
        }
        banner={{ text: 'La connexion n’est pas chiffrée : le mot de passe passerait en clair.' }}
        initialFocus="field"
        dismiss={{ label: 'Annuler', kbd: 'ESC', onClick: noop }}
        accept={{ label: 'Se connecter', kbd: '↩', onClick: noop }}
      >
        <input className="tk-field" data-autofocus aria-label="Nom d’utilisateur" placeholder="Nom d’utilisateur" />
        <input className="tk-field" type="password" aria-label="Mot de passe" placeholder="Mot de passe" />
      </Invite>
    </>
  )
}

/** An error page, as the engine writes it into a failed document: here in a frame of its own. */
export function errorPageDemo(tone: (typeof ERROR_TONES)[number]): string {
  const body = errorFrame({
    tone,
    icon: '<svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="9" width="34" height="30" rx="5"/><path d="M17 20v2M31 20v2M17 33c2-4 12-4 14 0"/></svg>',
    title: 'Ce site ne répond pas',
    content: '<p><strong>127.0.0.1:8765</strong> a refusé la connexion.</p><ul><li>Le serveur est peut-être arrêté.</li></ul><p class="code">ERR_CONNECTION_REFUSED</p>',
    actions: errorButton('#', 'Réessayer')
  })
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><style>${ERROR_PAGE_STYLE}</style></head><body><main>${body}</main></body></html>`
}

export interface TemplatesDemoProps {
  /** Force a scheme for the whole page (`data-theme`); without it the page follows the system. */
  scheme?: 'light' | 'dark'
  /** The hue of the space, 0..359. */
  hue?: number
}

export function TemplatesDemo({ scheme, hue }: TemplatesDemoProps) {
  return (
    <div className="tk-demo" data-theme={scheme} style={{ display: 'grid', gap: 'var(--sp-5)', padding: 'var(--sp-5)', background: 'var(--surface-2)', color: 'var(--text)', font: 'var(--t-m)/1.45 var(--font)' }}>
      <section aria-labelledby="demo-list">
        <h1 id="demo-list" style={{ fontSize: 'var(--t-xl)', margin: '0 0 var(--sp-3)' }}>
          Panneau de liste
        </h1>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-5)' }}>
          <DemoList hue={hue} />
          <div className="lp tk-panel" style={{ height: 'auto', minHeight: 220 }}>
            <ListEmpty icon={<DownloadGlyph />} title="Aucun téléchargement pour cette session" hint="Les fichiers que vous enregistrez apparaîtront ici, avec leur avancement." />
          </div>
        </div>
      </section>
      <section aria-labelledby="demo-sheet">
        <h1 id="demo-sheet" style={{ fontSize: 'var(--t-xl)', margin: '0 0 var(--sp-3)' }}>
          Petit éditeur
        </h1>
        <DemoSheet hue={hue} />
      </section>
      <section aria-labelledby="demo-invite">
        <h1 id="demo-invite" style={{ fontSize: 'var(--t-xl)', margin: '0 0 var(--sp-3)' }}>
          Invites
        </h1>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-5)' }}>
          <DemoInvites hue={hue} />
        </div>
      </section>
      <section aria-labelledby="demo-error">
        <h1 id="demo-error" style={{ fontSize: 'var(--t-xl)', margin: '0 0 var(--sp-3)' }}>
          Pages d’erreur
        </h1>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 'var(--sp-4)' }}>
          {ERROR_TONES.map((tone) => (
            <iframe key={tone} title={`Page d’erreur, ton ${tone}`} srcDoc={errorPageDemo(tone)} style={{ width: '100%', height: 420, border: '1px solid var(--line)', borderRadius: 'var(--r-m)', colorScheme: scheme }} />
          ))}
        </div>
      </section>
    </div>
  )
}
