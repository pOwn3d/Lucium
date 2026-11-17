// Test support (nothing of the application imports it): what a React tree draws, without a window. The function components are called inside
// the render of a probe (where their hooks are allowed), so the elements they return can be read: their props, their handlers, their keys.

import { createElement, isValidElement, useState, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

export type Element = ReactElement<Record<string, unknown>>

/** The function of a component: a memo component is its function under `type`. */
function componentOf(type: unknown): unknown {
  return typeof type === 'object' && type !== null && (type as { $$typeof?: symbol }).$$typeof === Symbol.for('react.memo') ? (type as { type: unknown }).type : type
}

/**
 * Every element a tree draws, the function components called and what they return walked too. A component `keep` says yes to is listed
 * and not called (a row that needs a context the probe does not give, say).
 */
export function expandedElements(node: ReactNode, keep: (type: unknown) => boolean = () => false): Element[] {
  if (Array.isArray(node)) return node.flatMap((child: ReactNode) => expandedElements(child, keep))
  if (!isValidElement(node)) return []
  const element = node as Element
  const component = componentOf(element.type)
  if (!keep(element.type) && typeof component === 'function' && !(component as { prototype?: { isReactComponent?: unknown } }).prototype?.isReactComponent) {
    return [element, ...expandedElements((component as (props: unknown) => ReactNode)(element.props), keep)]
  }
  return [element, ...expandedElements(element.props['children'] as ReactNode, keep)]
}

/**
 * What `render` answers at each of `passes` renders of one probe, the probe drawn again by a state change during its own render: the hooks
 * called inside keep their state from one pass to the next, as on screen when a snapshot arrives. `wrap` puts the probe under a provider.
 */
export function rendersOf<T>(passes: number, render: (pass: number) => T, wrap: (probe: ReactElement) => ReactElement = (probe) => probe): T[] {
  const out: T[] = []
  const Probe = (): null => {
    const [pass, setPass] = useState(0)
    out.push(render(pass))
    if (pass < passes - 1) setPass(pass + 1)
    return null
  }
  renderToStaticMarkup(wrap(createElement(Probe)))
  return out
}

/** The elements of `node`, every component in it called inside the render of a probe. */
export function elementsOf(node: ReactNode, keep?: (type: unknown) => boolean, wrap?: (probe: ReactElement) => ReactElement): Element[] {
  return rendersOf(1, () => expandedElements(node, keep), wrap)[0]!
}
