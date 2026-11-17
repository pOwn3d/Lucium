import { describe, expect, it } from 'vitest'
import { auditAxTree, type AxNode } from './a11y-audit'

const node = (role: string, name: string, extra: Partial<AxNode> = {}): AxNode => ({ nodeId: `${role}-${name}`, role: { value: role }, name: { value: name }, ...extra })
const prop = (name: string, value: unknown) => ({ name, value: { value } })

describe('the rules applied to the accessibility tree of a surface', () => {
  it('flag a control that has no name, whatever its role: a screen reader would say only “button”', () => {
    const findings = auditAxTree([node('button', ''), node('textbox', '  '), node('link', ''), node('tab', '', { properties: [prop('selected', false)] }), node('dialog', ''), node('img', ''), node('combobox', ''), node('slider', '')])
    expect(findings.map((f) => f.problem)).toEqual(Array(8).fill('unnamed'))
    expect(findings.map((f) => f.role)).toEqual(['button', 'textbox', 'link', 'tab', 'dialog', 'img', 'combobox', 'slider'])
  })

  it('leave a named control, plain text and a heading alone', () => {
    expect(auditAxTree([node('button', 'Fermer'), node('textbox', 'Rechercher'), node('StaticText', ''), node('heading', ''), node('generic', ''), node('RootWebArea', '')])).toEqual([])
  })

  it('do not read what the page hides (ignored nodes: aria-hidden, display none, decorative images)', () => {
    expect(auditAxTree([node('button', '', { ignored: true }), node('img', '', { ignored: true })])).toEqual([])
  })

  it('flag a switch, a checkbox, a radio or a tab that does not say whether it is on', () => {
    const findings = auditAxTree([node('switch', 'Son'), node('checkbox', 'Option'), node('radio', 'Choix'), node('tab', 'Général'), node('menuitemcheckbox', 'Coché')])
    expect(findings.map((f) => f.problem)).toEqual(Array(5).fill('missing-state'))
    const fine = auditAxTree([
      node('switch', 'Son', { properties: [prop('checked', 'false')] }),
      node('checkbox', 'Option', { properties: [prop('checked', 'true')] }),
      node('tab', 'Général', { properties: [prop('selected', false)] })
    ])
    expect(fine).toEqual([])
  })

  it('flag a focusable thing that has no role, which cannot be told from text', () => {
    const findings = auditAxTree([node('generic', 'x', { properties: [prop('focusable', true)] }), node('StaticText', 'y', { properties: [prop('focusable', true)] }), node('button', 'z', { properties: [prop('focusable', true)] })])
    expect(findings.map((f) => [f.problem, f.role])).toEqual([['focusable-without-role', 'generic'], ['focusable-without-role', 'StaticText']])
  })

  it('keep the node that the finding points at, to show its markup', () => {
    expect(auditAxTree([node('button', '', { backendDOMNodeId: 42 })])[0]).toMatchObject({ problem: 'unnamed', backendDOMNodeId: 42 })
  })

  it('survive a tree that is not what the protocol promised', () => {
    expect(auditAxTree([{ nodeId: '1' }, { nodeId: '2', role: { value: 7 }, name: { value: {} } } as unknown as AxNode])).toEqual([])
  })
})
