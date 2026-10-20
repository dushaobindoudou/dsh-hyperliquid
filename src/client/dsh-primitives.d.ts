declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ReactNode, KeyboardEventHandler } from 'react'
  export function Modal(props: {
    open: boolean
    onClose: () => void
    title: string
    closeLabel?: string
    description?: string
    children?: ReactNode
    footer?: ReactNode
    className?: string
    contentClassName?: string
    onKeyDownCapture?: KeyboardEventHandler<HTMLDivElement>
    headless?: boolean
    backdropBlur?: boolean
  }): ReactNode
  /** DSH's native button (36px md / 28px sm, --dsw-alias-button-* tokens). */
  export function Button(props: {
    variant?: 'primary' | 'ghost' | 'outline' | 'toolbar'
    size?: 'md' | 'sm'
    icon?: ReactNode
    className?: string
    children?: ReactNode
  } & import('react').ButtonHTMLAttributes<HTMLButtonElement>): ReactNode
  /** DSH's native text input (32px, 14px text). */
  export function Input(props: { icon?: ReactNode; className?: string } & import('react').InputHTMLAttributes<HTMLInputElement>): ReactNode
  /** DSH's native disclosure row (the shell's tool-call row chrome). */
  export function DisclosureRow(props: {
    icon: ReactNode
    title: string
    open: boolean
    expandable: boolean
    onToggle: () => void
    running?: boolean
    expandOnRowClick?: boolean
    previewChevron?: boolean
    keepContentWhenOpen?: boolean
    collapsedContent?: ReactNode
    children?: ReactNode
    className?: string
  }): ReactNode
}
