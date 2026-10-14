import { useState, type ReactNode } from 'react'
import { tt } from './helpers.ts'
import css from './panel.module.css'

/** Keep closed task details out of the DOM, including their image sources. */
export function LazyDetails({ summary, children }: { summary: ReactNode; children: () => ReactNode }): JSX.Element {
  const [open, setOpen] = useState(false)
  return <details className={css.taskDetails} onToggle={event => { setOpen(event.currentTarget.open) }}>
    <summary>{summary}</summary>
    {open ? children() : null}
  </details>
}

/** Bound the initial image/record mount without dropping access to later items. */
export function ProgressiveItems<T>({ items, children, pageSize = 24 }: {
  items: readonly T[]
  children: (item: T, index: number) => ReactNode
  pageSize?: number
}): JSX.Element {
  const [limit, setLimit] = useState(pageSize)
  return <>
    {items.slice(0, limit).map(children)}
    {items.length > limit ? <button type="button" className={css.loadMore} data-imagegen-load-more="" onClick={() => { setLimit(current => current + pageSize) }}>
      {tt('tasks.loadMore')} · {Math.min(limit, items.length)} / {items.length}
    </button> : null}
  </>
}
