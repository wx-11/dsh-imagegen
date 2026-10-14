/**
 * Prompt-template library overlay: a multi-source, searchable, category-
 * filtered gallery. Each registered source (TEMPLATE_SOURCES) renders as its
 * own tab with an independent list, refresh state, and image pool; case lists
 * are served by the host (bundled snapshot, optionally refreshed online or
 * auto-synced in the background) and reference images load lazily through the
 * host's caching proxy, so browsing progressively mirrors the gallery onto the
 * local disk. Templates can be starred; favorites persist host-side as full
 * case snapshots and are reachable through a top-level tab grouped by source.
 * Picking a template hands its prompt back and closes the library.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ImageGenApi } from './api.ts'
import { TemplateThumb, imageUrlOf } from './TemplateImage.tsx'
import { ProgressiveItems } from './ProgressiveContent.tsx'
import { matchesTemplate } from '../template-registry.ts'
import { errorMessage, tt } from './helpers.ts'
import { TEMPLATES_API, TEMPLATE_DOWNLOAD_CONCURRENCY, TEMPLATE_SOURCES, type TemplateCase, type TemplateFavorite, type TemplateListResult } from '../protocol.ts'
import css from './templates.module.css'

/** One case paired with the source that owns it (favorites mix sources). */
interface TemplateEntry {
  sourceId: string
  item: TemplateCase
}

/** Detail-view selection keeps its source so proxy URLs and stars stay scoped. */
interface SelectedTemplate extends TemplateEntry {}

/** Stable favorites key of one case within a source. */
function favoriteKeyOf(sourceId: string, item: TemplateCase): string {
  return `${sourceId}:${item.id}`
}

/** Card-corner star toggle; the click must not open the detail view. Rendered
 *  as a span (a button cannot nest inside the card button). */
function FavoriteStar(props: { active: boolean; title: string; onToggle: () => void }) {
  return (
    <span
      role="button"
      tabIndex={0}
      className={css.favStar}
      data-active={props.active ? '' : undefined}
      aria-label={props.title}
      title={props.title}
      onClick={(event) => { event.stopPropagation(); props.onToggle() }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.stopPropagation()
        event.preventDefault()
        props.onToggle()
      }}
    >
      <svg viewBox="0 0 24 24" width="15" height="15" fill={props.active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.6 9.7l5.8-.8z"/></svg>
    </span>
  )
}

/** The template-library modal. Rendered through a portal above the studio. */
export function TemplateLibrary(props: {
  api: ImageGenApi
  /** Hand a picked prompt back to the studio form and close the library. */
  onUse: (prompt: string) => void
  onClose: () => void
}) {
  const { api, onUse, onClose } = props
  const [activeSource, setActiveSource] = useState(TEMPLATE_SOURCES[0]!.id)
  const [lists, setLists] = useState<Record<string, TemplateListResult>>({})
  const [loadErrors, setLoadErrors] = useState<Record<string, string>>({})
  const [favorites, setFavorites] = useState<TemplateFavorite[]>([])
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [favoritesView, setFavoritesView] = useState(false)
  const [selected, setSelected] = useState<SelectedTemplate | null>(null)
  const [copied, setCopied] = useState(false)
  const [refreshStates, setRefreshStates] = useState<Record<string, boolean>>({})
  const [notices, setNotices] = useState<Record<string, string | null>>({})
  const [cacheStates, setCacheStates] = useState<Record<string, { running: boolean; done: number; total: number; failed: number }>>({})
  const controllers = useRef(new Map<string, AbortController>())
  const viewKey = favoritesView ? 'favorites' : activeSource === 'all' ? 'all' : `source-${activeSource}`
  const cacheAll = cacheStates[viewKey] ?? { running: false, done: 0, total: 0, failed: 0 }
  const refreshing = refreshStates[viewKey] ?? false
  const notice = notices[viewKey] ?? null
  const setNotice = (value: string | null): void => { setNotices(current => ({ ...current, [viewKey]: value })) }
  const setRefreshing = (value: boolean): void => { setRefreshStates(current => ({ ...current, [viewKey]: value })) }
  const searchRef = useRef<HTMLInputElement>(null)

  const list = lists[activeSource]
  const loadError = favoritesView ? null : loadErrors[activeSource] || null

  /** Fetch one source's list into the per-source cache. */
  const loadSource = (sourceId: string): void => {
    api.templatesList(sourceId)
      .then(result => {
        setLists(current => ({ ...current, [sourceId]: result }))
        setLoadErrors(current => ({ ...current, [sourceId]: '' }))
      })
      .catch(caught => { setLoadErrors(current => ({ ...current, [sourceId]: errorMessage(caught) })) })
  }

  // Load the first source plus the favorites on open; focus the search box.
  useEffect(() => {
    TEMPLATE_SOURCES.forEach(source => { loadSource(source.id) })
    api.favoritesList().then(setFavorites).catch(() => { /* favorites stay empty; toggling retries */ })
    searchRef.current?.focus()
    return () => { controllers.current.forEach(controller => { controller.abort() }) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const switchSource = (sourceId: string): void => {
    if (sourceId === activeSource && !favoritesView) return
    setActiveSource(sourceId)
    setCategory('')
    setFavoritesView(false)
    setSelected(null)
    if (sourceId !== 'all' && lists[sourceId] === undefined) loadSource(sourceId)
  }

  /** Every favorite keeps its source so the favorites tab can group libraries. */
  const favoriteItems = useMemo<TemplateEntry[]>(
    () => favorites.map(entry => ({ sourceId: entry.sourceId, item: entry.case })),
    [favorites],
  )
  const visibleItems = useMemo<TemplateEntry[]>(() => {
    if (favoritesView) return favoriteItems
    if (activeSource === 'all') return TEMPLATE_SOURCES.flatMap(source => (lists[source.id]?.cases ?? []).map(item => ({ sourceId: source.id, item })))
    return (list?.cases ?? []).map(item => ({ sourceId: activeSource, item }))
  }, [activeSource, favoriteItems, favoritesView, list, lists])
  const favKeys = useMemo(() => new Set(favorites.map(entry => entry.key)), [favorites])

  const categories = useMemo(() => {
    const counts = new Map<string, { label: string; count: number }>()
    for (const { item } of visibleItems) {
      const entry = counts.get(item.category) ?? { label: item.categoryZh || item.category, count: 0 }
      entry.count += 1
      counts.set(item.category, entry)
    }
    return [...counts.entries()].map(([key, value]) => ({ key, label: value.label, count: value.count }))
  }, [visibleItems])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return visibleItems.filter(({ item }) => {
      if (category !== '' && item.category !== category) return false
      if (needle === '') return true
      return matchesTemplate(item, needle)
    })
  }, [visibleItems, query, category])

  // Escape backs out of the detail view first, then closes the modal.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      if (selected !== null) setSelected(null)
      else onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [selected, onClose])

  const refresh = async (): Promise<void> => {
    const source = TEMPLATE_SOURCES.find(candidate => candidate.id === activeSource)
    if (refreshing || source?.refreshable === false) return
    setRefreshing(true)
    setNotice(null)
    try {
      const result = await api.templatesRefresh(activeSource)
      const reloaded = await api.templatesList(activeSource)
      setLists(current => ({ ...current, [activeSource]: reloaded }))
      setNotice(tt('templates.refreshed', { count: result.total }))
    } catch (caught) {
      setNotice(tt('templates.refreshFailed', { error: errorMessage(caught) }))
    } finally {
      setRefreshing(false)
    }
  }

  /** Star / unstar one template, preserving its owning source. */
  const toggleFavorite = (sourceId: string, item: TemplateCase): void => {
    const key = favoriteKeyOf(sourceId, item)
    const pending = favKeys.has(key)
      ? api.favoritesRemove(key)
      : api.favoritesAdd(sourceId, item)
    pending.then(setFavorites).catch(() => { /* leave the star as-is on failure */ })
  }

  /** Mirror every reference image of the active source through the host cache. */
  const cacheAllImages = async (): Promise<void> => {
    const key = viewKey
    if (controllers.current.has(key) || !visibleItems.length) return
    const entries = [...new Map(visibleItems.filter(entry => entry.item.image).map(entry => [imageUrlOf(entry.sourceId, entry.item, key), entry])).values()]
    const controller = new AbortController()
    controllers.current.set(key, controller)
    const state = { running: true, done: 0, total: entries.length, failed: 0 }
    const publish = (): void => { if (!controller.signal.aborted) setCacheStates(current => ({ ...current, [key]: { ...state } })) }
    publish()
    let index = 0
    const worker = async (): Promise<void> => {
      while (index < entries.length && !controller.signal.aborted) {
        const entry = entries[index++]!
        try {
          const response = await fetch(TEMPLATES_API.cache, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ source: entry.sourceId, file: entry.item.image, scope: key }),
            signal: controller.signal,
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const result = await response.json() as { ok?: boolean }
          if (result.ok !== true) throw new Error('图片缓存失败')
          state.done += 1
        } catch { if (!controller.signal.aborted) state.failed += 1 }
        publish()
      }
    }
    try { await Promise.all(Array.from({ length: Math.min(TEMPLATE_DOWNLOAD_CONCURRENCY, entries.length) }, () => worker())) }
    finally { controllers.current.delete(key); state.running = false; publish() }
  }

  const copyPrompt = async (text: string): Promise<void> => {
    try {
      if (navigator.clipboard?.writeText !== undefined) {
        await navigator.clipboard.writeText(text)
      } else {
        const textarea = document.createElement('textarea')
        textarea.value = text
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.select()
        const copiedOk = document.execCommand('copy')
        textarea.remove()
        if (!copiedOk) throw new Error('copy failed')
      }
      setCopied(true)
      window.setTimeout(() => { setCopied(false) }, 1800)
    } catch {
      setCopied(false)
    }
  }

  const renderCard = ({ sourceId, item }: TemplateEntry): React.JSX.Element => {
    const key = favoriteKeyOf(sourceId, item)
    const active = favKeys.has(key)
    return <button
      key={`${viewKey}:${key}`}
      type="button"
      className={css.card}
      onClick={() => { setSelected({ sourceId, item }); setCopied(false) }}
    >
      <span className={css.thumbWrap}>
        <TemplateThumb sourceId={sourceId} item={item} scope={viewKey} />
        {item.featured ? <span className={css.featuredBadge}>{tt('templates.featured')}</span> : null}
        <FavoriteStar
          active={active}
          title={active ? tt('templates.favoriteRemove') : tt('templates.favoriteAdd')}
          onToggle={() => { toggleFavorite(sourceId, item) }}
        />
      </span>
      <span className={css.cardBody}>
        <span className={css.cardTitle}>{item.title}</span>
        <span className={css.cardMeta}>
          <span className={css.cardCategory}>{item.categoryZh || item.category}</span>
          {item.sourceLabel !== '' ? <span className={css.cardSource}>{item.sourceLabel}</span> : null}
        </span>
      </span>
    </button>
  }

  const applySelected = (): void => {
    if (selected === null) return
    const prompt = selected.item.prompt
    setSelected(null)
    onUse(prompt)
    onClose()
  }

  const originLabel = list === undefined ? '' : tt(list.origin === 'refreshed' ? 'templates.origin.refreshed' : 'templates.origin.bundled')
  const activeMeta = TEMPLATE_SOURCES.find(source => source.id === activeSource)

  return createPortal(
    <div className={css.overlay} role="dialog" aria-modal="true" aria-label={tt('templates.title')} onClick={onClose}>
      <section className={css.shell} onClick={(event) => { event.stopPropagation() }}>
        <header className={css.header}>
          <span className={css.heading}>
            <Button variant="outline" size="sm" onClick={() => { if (selected !== null) setSelected(null); else onClose() }}>← {tt('navigation.back')}</Button>
            <h3 className={css.title}>{tt('templates.title')}</h3>
            {favoritesView ? (
              <span className={css.meta}>{tt('templates.favoritesCount', { count: favorites.length })}</span>
            ) : list !== undefined ? (
              <span className={css.meta}>{tt('templates.meta', { count: list.total, origin: originLabel })}</span>
            ) : null}
          </span>
          <span className={css.headerActions}>
            {favoritesView || activeSource === 'all' || activeMeta?.refreshable === false ? null : (
              <Button variant="outline" size="sm" disabled={refreshing || cacheAll.running || favoritesView} onClick={() => { void refresh() }}>
                {refreshing ? tt('templates.refreshing') : tt('templates.refresh')}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={visibleItems.length === 0 || cacheAll.running}
              title={tt('templates.cacheAllHint')}
              onClick={() => { void cacheAllImages() }}
            >
              {cacheAll.running
                ? tt('templates.caching', { done: cacheAll.done, total: cacheAll.total })
                : cacheAll.total > 0 && cacheAll.done === cacheAll.total && cacheAll.failed === 0
                  ? tt('templates.cached')
                  : cacheAll.failed > 0 ? tt('templates.cacheStatus', { done: cacheAll.done, total: cacheAll.total, failed: cacheAll.failed }) : tt('templates.cacheAll')}
            </Button>
            <button type="button" className={css.close} aria-label={tt('templates.close')} title={tt('templates.close')} onClick={onClose}>
              <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>
            </button>
          </span>
        </header>

        <div className={css.sourceTabs} role="tablist" aria-label={tt('templates.sources')}>
          <button type="button" role="tab" className={css.sourceTab}
            aria-selected={!favoritesView && activeSource === 'all'}
            data-active={!favoritesView && activeSource === 'all' ? '' : undefined}
            onClick={() => { switchSource('all') }}>{tt('templates.all')} <span className={css.sourceTabCount}>{Object.values(lists).reduce((total, entry) => total + entry.total, 0)}</span></button>
          {TEMPLATE_SOURCES.map(source => (
            <button
              key={source.id}
              type="button"
              role="tab"
              aria-selected={!favoritesView && source.id === activeSource}
              className={css.sourceTab}
              data-active={!favoritesView && source.id === activeSource ? '' : undefined}
              title={source.description}
              onClick={() => { switchSource(source.id) }}
            >
              {source.label}
              {lists[source.id] !== undefined ? <span className={css.sourceTabCount}>{lists[source.id]!.total}</span> : null}
            </button>
          ))}
          <button
            type="button"
            role="tab"
            aria-selected={favoritesView}
            className={css.sourceTab}
            data-active={favoritesView ? '' : undefined}
            title={tt('templates.favoritesHint')}
            onClick={() => {
              setFavoritesView(true)
              setCategory('')
              setSelected(null)
            }}
          >
            ★ {tt('templates.favorites')}
            {favorites.length > 0 ? <span className={css.sourceTabCount}>{favorites.length}</span> : null}
          </button>
        </div>

        <div className={css.toolbar}>
          <input
            ref={searchRef}
            type="search"
            className={css.search}
            placeholder={tt('templates.search')}
            value={query}
            onChange={(event) => { setQuery(event.target.value) }}
          />
          <div className={css.categoryRow}>
            <button
              type="button"
              className={css.categoryPill}
              data-active={category === '' ? '' : undefined}
              onClick={() => { setCategory('') }}
            >
              {tt('templates.all')}{visibleItems.length > 0 ? ` ${visibleItems.length}` : ''}
            </button>
            {categories.map(entry => (
              <button
                key={entry.key}
                type="button"
                className={css.categoryPill}
                data-active={category === entry.key ? '' : undefined}
                onClick={() => { setCategory(entry.key) }}
              >
                {entry.label} {entry.count}
              </button>
            ))}
          </div>
        </div>

        {notice !== null ? <div className={css.notice} role="status">{notice}</div> : null}

        <div className={css.body}>
          {activeSource === 'all' && !favoritesView ? TEMPLATE_SOURCES.filter(source => loadErrors[source.id]).map(source => <div key={source.id} className={css.state} role="alert">
            {source.label}: {loadErrors[source.id]} <Button variant="outline" size="sm" onClick={() => { loadSource(source.id) }}>{tt('templates.retry')}</Button>
          </div>) : null}

          {!favoritesView && activeSource !== 'all' && list === undefined && loadError === null ? (
            <div className={css.state} role="status">
              <span className={css.spinner} />
              <span>{tt('templates.loading')}</span>
            </div>
          ) : null}

          {!favoritesView && loadError !== null ? (
            <div className={css.state} role="alert">
              <span>{tt('templates.loadFailed', { error: loadError })}</span>
              <Button variant="outline" size="sm" onClick={() => { setLoadErrors(current => ({ ...current, [activeSource]: '' })); loadSource(activeSource) }}>
                {tt('templates.retry')}
              </Button>
            </div>
          ) : null}

          {favoritesView && filtered.length === 0 ? (
            <div className={css.state}>{tt('templates.favoritesEmpty')}</div>
          ) : null}

          {!favoritesView && loadError === null && (list !== undefined || activeSource === 'all') && filtered.length === 0 ? (
            <div className={css.state}>{tt('templates.empty')}</div>
          ) : null}

          {favoritesView && filtered.length > 0 ? (
            <div className={css.favoriteGroups}>
              {TEMPLATE_SOURCES.map(source => {
                const group = filtered.filter(entry => entry.sourceId === source.id)
                if (group.length === 0) return null
                return <section key={source.id} className={css.favoriteGroup}>
                  <div className={css.favoriteGroupHead}>
                    <span className={css.favoriteGroupTitle}>{source.label}</span>
                    <span className={css.favoriteGroupCount}>{group.length}</span>
                  </div>
                  <div className={css.grid}><ProgressiveItems key={`${viewKey}:${query}:${category}:${source.id}`} items={group}>{renderCard}</ProgressiveItems></div>
                </section>
              })}
            </div>
          ) : null}

          {!favoritesView && filtered.length > 0 ? (
            <div className={css.grid}><ProgressiveItems key={`${viewKey}:${query}:${category}`} items={filtered}>{renderCard}</ProgressiveItems></div>
          ) : null}
        </div>

        <footer className={css.footer}>
          <span className={css.attribution}>{tt('templates.attribution')}</span>
          {!favoritesView && activeMeta ? <a className={css.sourceLink} href={activeMeta.homepage} target="_blank" rel="noreferrer">
            {tt('templates.source', { label: activeMeta.label })}
          </a> : null}
        </footer>
      </section>

      {selected !== null ? (
        <div className={css.detailOverlay} onClick={() => { setSelected(null) }}>
          <section className={css.detail} onClick={(event) => { event.stopPropagation() }}>
            <div className={css.detailMedia}>
              {selected.item.image !== '' ? (
                <TemplateThumb key={`${selected.sourceId}:${selected.item.image}`} sourceId={selected.sourceId} item={selected.item} scope="detail" className={css.detailImage} />
              ) : (
                <span className={css.thumbPlaceholder} aria-hidden="true" />
              )}
            </div>
            <div className={css.detailInfo}>
              <h4 className={css.detailTitle}>{selected.item.title}</h4>
              <div className={css.detailMeta}>
                <span className={css.cardCategory}>{selected.item.categoryZh || selected.item.category}</span>
                {selected.item.sourceUrl !== '' ? (
                  <a className={css.detailLink} href={selected.item.sourceUrl} target="_blank" rel="noreferrer">{selected.item.sourceLabel || selected.item.sourceUrl}</a>
                ) : null}
                {selected.item.githubUrl !== '' ? (
                  <a className={css.detailLink} href={selected.item.githubUrl} target="_blank" rel="noreferrer">GitHub</a>
                ) : null}
              </div>
              <pre className={css.detailPrompt}>{selected.item.prompt}</pre>
              <div className={css.detailActions}>
                <Button variant="primary" size="md" onClick={applySelected}>
                  {tt('templates.use')}
                </Button>
                <Button variant="outline" size="md" onClick={() => { void copyPrompt(selected.item.prompt) }}>
                  {copied ? tt('templates.copied') : tt('templates.copy')}
                </Button>
                <Button
                  variant="outline"
                  size="md"
                  onClick={() => { toggleFavorite(selected.sourceId, selected.item) }}
                >
                  {favKeys.has(favoriteKeyOf(selected.sourceId, selected.item)) ? tt('templates.unfavorite') : tt('templates.favorite')}
                </Button>
                <Button variant="outline" size="md" onClick={() => { setSelected(null) }}>
                  {tt('templates.back')}
                </Button>
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </div>,
    document.body,
  )
}
