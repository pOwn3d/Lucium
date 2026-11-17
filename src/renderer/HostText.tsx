// A host drawn where the room may be short (the toolbar, the header of the mini window, the pill of the sidebar): the registrable domain is always
// whole, the subdomains before it give way with an ellipsis (shared/toolbar.ts `hostParts`). The text read by an assistive technology and by
// `textContent` is the host, unchanged.

import { hostParts } from '@shared/toolbar'
import './host-text.css'

export function HostText({ host, className }: { host: string; className?: string }) {
  const { sub, domain } = hostParts(host)
  return (
    <span className={['host-split', className].filter(Boolean).join(' ')}>
      {sub !== '' && <span className="host-sub">{sub}</span>}
      <span className="host-domain">{domain}</span>
    </span>
  )
}
