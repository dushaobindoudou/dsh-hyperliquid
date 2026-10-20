/** Native <select> (keyboard, screen readers, mobile pickers) with DSH styling and an SVG chevron. */
import * as React from 'react'
import { UiIcon } from './panel-icons'

export function Select({ className, children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <span className={'dhl-select' + (className ? ' ' + className : '')}>
    <select {...props}>{children}</select>
    <UiIcon name="chevronDown" size={13} />
  </span>
}
