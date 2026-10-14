import { useState, type ReactNode, type ImgHTMLAttributes } from 'react'
import { tt } from './helpers.ts'
import css from './panel.module.css'

/** Missing or invalid durable files should show a readable placeholder. */
export function StoredThumbnail(props: ImgHTMLAttributes<HTMLImageElement>): JSX.Element {
  const [failedSource, setFailedSource] = useState<string | undefined>()
  if (props.src !== undefined && failedSource === props.src) {
    return <span className={`${props.className ?? ''} ${css.imageUnavailable}`} role="img" aria-label={tt('tasks.imageUnavailable')}>{tt('tasks.imageUnavailable')}</span>
  }
  return <img {...props} onError={() => { setFailedSource(props.src) }} />
}

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
