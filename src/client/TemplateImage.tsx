import { useState } from 'react'
import { TEMPLATES_API, type TemplateCase } from '../protocol.ts'
import { tt } from './helpers.ts'
import css from './templates.module.css'

/** Same-origin URL of one case's reference image (host caching proxy). */
export function imageUrlOf(sourceId: string, item: TemplateCase, scope: string): string {
  return `${TEMPLATES_API.image}/${encodeURIComponent(sourceId)}/${encodeURIComponent(item.image)}?scope=${encodeURIComponent(scope)}`
}

/** A card thumbnail that falls back to a placeholder when the proxy 404s. */
export function TemplateThumb(props: { sourceId: string; item: TemplateCase; scope: string; className?: string }) {
  const [status, setStatus] = useState<'loading' | 'cached' | 'failed'>('loading')
  const [retry, setRetry] = useState(0)
  const url = imageUrlOf(props.sourceId, props.item, props.scope)
  return <span className={css.imageState}>
    {props.item.image && status !== 'failed' ? <img
      className={props.className ?? css.thumb} src={`${url}&retry=${retry}`} alt={props.item.title}
      loading="lazy" decoding="async"
      onLoad={() => { setStatus('cached') }} onError={() => { setStatus('failed') }}
    /> : <span className={css.thumbPlaceholder}>{props.item.title}</span>}
    {props.item.image ? <span className={css.cacheBadge} role={status === 'failed' ? 'button' : undefined}
      tabIndex={status === 'failed' ? 0 : undefined}
      onClick={event => { if (status === 'failed') { event.stopPropagation(); setRetry(value => value + 1); setStatus('loading') } }}
      onKeyDown={event => { if (status === 'failed' && ['Enter', ' '].includes(event.key)) { event.preventDefault(); event.stopPropagation(); setRetry(value => value + 1); setStatus('loading') } }}>
      {tt(status === 'failed' ? 'templates.imageFailed' : status === 'cached' ? 'templates.imageCached' : 'templates.imageLoading')}
    </span> : null}
  </span>
}

