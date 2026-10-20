// Stand-in for DSH's DisclosureRow: renders title, collapsed content and children.
import * as React from 'react'
export function DisclosureRow({ title, collapsedContent, children, running, open }) {
  return React.createElement('div', { 'data-row': true, 'data-running': String(Boolean(running)) },
    React.createElement('span', { className: 'title' }, title), collapsedContent, open ? children : null)
}
export function Modal({ children }) { return React.createElement('div', null, children) }
