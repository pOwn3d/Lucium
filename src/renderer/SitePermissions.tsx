// The permissions of the site on show: each answer the site was given, with the choice "Demander / Autoriser / Bloquer" in place
// and "Oublier"; the camera and the microphone are always there, to be answered before a page asks. The answer for every site (notifications only) is
// named as what stands when the site has none. Nothing is decided here: a choice is one `permission/set` (or `container/permission`) of the panel.

import type { PermissionDecision } from '@shared/model'
import { decisionOfChoice, permissionName, type SitePermissionRow } from '@shared/permissions'
import { t } from '@shared/i18n'

const GLYPH = { viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const
/** The disc of the row: a check for an answer that lets the site, a cross for one that does not, a camera while the question is still to be asked. */
const PATHS = { allow: 'm5 10.500 3.200 3.200L15 6.800', deny: 'm6 6 8 8M14 6l-8 8', ask: 'M3 6.500h9v7H3zM12 9l5-2.500v7L12 11z' } as const

const choiceOf = (decision: PermissionDecision | undefined): 'allow' | 'deny' | 'ask' => decision ?? 'ask'
const decisionName = (decision: PermissionDecision): string => (decision === 'allow' ? t('site-panel.autorise') : t('site-panel.refuse'))

export function SitePermissionRows({ rows, onDecide }: { rows: readonly SitePermissionRow[]; onDecide: (permission: string, decision: PermissionDecision | null) => void }) {
  return (
    <>
      {rows.map((row) => {
        const effective = row.own ?? row.everywhere
        const name = permissionName(row.permission)
        return (
          <div key={row.permission} className="scc-perm">
            <span className={`scc-badge ${effective === 'allow' ? 'on' : ''}`}>
              <svg {...GLYPH} width="16" height="16">
                <path d={PATHS[effective ?? 'ask']} />
              </svg>
            </span>
            <span className="scc-setting-text">
              <strong>{name}</strong>
              <span>
                {row.own !== undefined ? decisionName(row.own) : row.everywhere !== undefined ? t('site-panel.comme-partout-decision', { decision: decisionName(row.everywhere) }) : t('site-panel.demander-a-chaque-fois')}
                {row.own !== undefined && (
                  <>
                    {' · '}
                    <button type="button" className="scc-perm-forget" aria-label={t('site-panel.oublier-name', { name })} onClick={() => onDecide(row.permission, null)}>
                      {t('site-panel.oublier')}
                    </button>
                  </>
                )}
              </span>
            </span>
            <select className="scc-perm-choice" aria-label={t('site-panel.reponse-pour-ce-site-name', { name })} value={choiceOf(row.own)} onChange={(e) => onDecide(row.permission, decisionOfChoice(e.target.value))}>
              <option value="ask">{row.everywhere !== undefined ? t('site-panel.comme-partout') : t('site-panel.demander')}</option>
              <option value="allow">{t('site-panel.autoriser')}</option>
              <option value="deny">{t('site-panel.bloquer')}</option>
            </select>
          </div>
        )
      })}
    </>
  )
}
