/**
 * Prompt-template library store (multi-source).
 *
 * The library is a registry of independent sources (see TEMPLATE_SOURCES in
 * protocol.ts): each source has its own upstream JSON list, its own bundled
 * snapshot, its own refreshed runtime copy, and its own on-disk image pool.
 * Sources never mix — the overlay shows one tab per source and every request
 * names the source explicitly.
 *
 * Each case list ships as a bundled snapshot (src/templates/<file>, inside the
 * npm package) so every library works offline out of the box; a successful
 * refresh (manual, or the periodic background sync) writes a runtime copy
 * under ~/.dsh/dsh-imagegen/templates/<sourceId>/ which then takes precedence.
 * Reference images are not bundled (hundreds of files, ≈100 MB per source) —
 * they are fetched from the source's mirror on demand, cached on disk under
 * ~/.dsh/dsh-imagegen/template-images/<sourceId>/, and served from there on
 * every later view.
 *
 * Framework-free (node:fs only) so the route layer and tests can drive it
 * directly.
 */

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { imageDataRoot } from './image-storage-path.ts'
import { atomicWrite } from './image-store-io.ts'
import { assertCompleteImage } from './image-format.ts'
import { registrySnapshot } from './template-registry.ts'
import { templateFetch, readLimitedBody } from './template-network.ts'
import { DEFAULT_TEMPLATE_SOURCE_ID, TEMPLATE_DOWNLOAD_CONCURRENCY, TEMPLATE_SOURCES, type TemplateCase, type TemplateListResult, type TemplateRefreshResult, type TemplateSample } from './protocol.ts'

/** Host-side fetch definition of one source (ids mirror TEMPLATE_SOURCES). */
interface TemplateSourceDef {
  /** Upstream JSON list refreshed from. */
  listUrl?: string
  /** Remote image directory (file names come from the case list). */
  imageBaseUrl?: string
  /** Bundled snapshot shipped inside the package. */
  bundledPath: string
  /** False when the snapshot only changes with a plugin release. */
  refreshable?: boolean
  /** Hosts allowed for absolute image URLs from this source. */
  allowedImageHosts?: readonly string[]
  /** Optional source-specific URL variants / mirrors for one image reference. */
  imageUrls?: (ref: string) => string[]
  /**
   * Pre-1.6 single-source layout: refreshed copies and images lived in
   * unscoped paths. Read as a fallback so existing users keep their state
   * until the next refresh rewrites it into the scoped location.
   */
  legacySnapshotPath?: string
  legacyImageDir?: string
}

/** Source registry (host half): where each TEMPLATE_SOURCES entry loads from. */
const SOURCE_DEFS: Record<string, TemplateSourceDef> = {
  'image-prompts': {
    listUrl: 'https://raw.githubusercontent.com/yukkcat/image-prompts/main/dist/prompts.json',
    bundledPath: fileURLToPath(new URL('../src/templates/image-prompts-cases.json', import.meta.url)),
    allowedImageHosts: ['raw.githubusercontent.com', 'cms-assets.youmind.com', 'pbs.twimg.com', 'cdn.imgedify.com', 'camo.githubusercontent.com', 'cdn.jsdelivr.net', 'github.com', 'linux.do', 'i.mji.rip', 'storage.googleapis.com'],
    imageUrls: githubImageUrls,
  },
  vibeui: {
    listUrl: 'https://vibeui.top/extra/awesome-gpt-image-2/data/cases.json',
    imageBaseUrl: 'https://vibeui.top/extra/awesome-gpt-image-2/data/images/',
    bundledPath: fileURLToPath(new URL('../src/templates/cases.json', import.meta.url)),
    legacySnapshotPath: 'legacy',
    legacyImageDir: 'legacy',
  },
  canghe: {
    listUrl: 'https://gpt-image2.canghe.ai/cases.json',
    imageBaseUrl: 'https://gpt-image2.canghe.ai/images/',
    bundledPath: fileURLToPath(new URL('../src/templates/canghe-cases.json', import.meta.url)),
  },
  handraw: {
    bundledPath: fileURLToPath(new URL('../src/templates/handraw-cases.json', import.meta.url)),
    refreshable: false,
    allowedImageHosts: ['cdn.jsdelivr.net', 'raw.githubusercontent.com'],
    imageUrls: githubImageUrls,
  },
  'prompt-signal': {
    bundledPath: fileURLToPath(new URL('../src/templates/prompt-signal-cases.json', import.meta.url)),
    refreshable: false,
    allowedImageHosts: ['raw.githubusercontent.com', 'pbs.twimg.com', 'mosaic.fxtwitter.com'],
  },
  evolink: {
    bundledPath: fileURLToPath(new URL('../src/templates/evolink-cases.json', import.meta.url)),
    refreshable: false,
    allowedImageHosts: ['raw.githubusercontent.com'],
  },
}

/** Category label map mirrored from the upstream sites' site.js (zh names). */
const CATEGORY_ZH: Record<string, string> = {
  'Architecture & Spaces': '建筑与空间',
  'Brand & Logos': '品牌与标志',
  'Characters & People': '人物与角色',
  'Charts & Infographics': '图表与信息可视化',
  'Documents & Publishing': '文档与出版物',
  'History & Classical Themes': '历史与古风题材',
  'Illustration & Art': '插画与艺术',
  'Other Use Cases': '其他应用场景',
  'Photography & Realism': '摄影与写实',
  'Posters & Typography': '海报与排版',
  'Products & E-commerce': '商品与电商',
  'Scenes & Storytelling': '场景与叙事',
  'UI & Interfaces': 'UI 与界面',
  'Portraits & Fashion': '人像与时尚',
  'Celebrities & Sports': '名人与运动',
  'Characters & IP': '角色与 IP',
  'Food & Beverage': '美食与饮品',
  'Brand & Icons': '品牌与图标',
  'Social Media & Stickers': '社媒与表情包',
  'Infographics & Diagrams': '信息图与图解',
  'UI & App Screens': 'UI 与应用界面',
  'Architecture & Interiors': '建筑与室内',
  'Cinematic & Storytelling': '影视与叙事',
  'Illustration & Comics': '插画与漫画',
  'Historical & Fantasy': '历史与幻想',
  'Animals & Nature': '动物与自然',
  'Other Creative Uses': '其他创意用途',
}

/** Budget for one upstream fetch (list refresh or one image). */
const FETCH_TIMEOUT_MS = 60_000

/** Refuse to cache implausibly large "images". */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/** Strict legacy reference-image file names this store writes and serves. */
const IMAGE_FILE_PATTERN = /^case\d+\.(jpg|jpeg|png|webp|gif)$/i

/** Absolute image URL length accepted from bundled/refreshed snapshots. */
const MAX_IMAGE_URL_LENGTH = 4_000

/** The on-disk / wire shape of the case-list snapshot. */
interface CasesSnapshot {
  repository?: unknown
  fetchedAt?: unknown
  cases?: unknown
}

/** Per-source in-memory memo of the active list (avoid re-parsing per request). */
const memos = new Map<string, TemplateListResult>()

/** Per-file in-flight downloads, so a gallery scroll never double-fetches. */
const inflightImages = new Map<string, Promise<{ data: Buffer; mime: string } | undefined>>()

/** Resolve a registered source id to its fetch definition. */
function sourceDefOf(sourceId: string): TemplateSourceDef | undefined {
  return SOURCE_DEFS[sourceId]
}

/** Validate + normalize one raw upstream case; undefined when unusable. */
function normalizeCase(raw: unknown): TemplateCase | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  const id = typeof record.id === 'number' && Number.isFinite(record.id)
    ? String(record.id)
    : typeof record.id === 'string'
      ? record.id.trim()
      : ''
  const title = typeof record.title === 'string' ? record.title.trim() : ''
  const prompt = typeof record.prompt === 'string' ? record.prompt.trim() : ''
  if (id === '' || title === '' || prompt === '') return undefined
  const category = typeof record.category === 'string' ? record.category : ''
  const rawImage = typeof record.image === 'string' ? record.image : ''
  const image = imageRefOf(rawImage)
  const categoryZh = typeof record.categoryZh === 'string' && record.categoryZh.trim() !== ''
    ? record.categoryZh.trim()
    : CATEGORY_ZH[category] ?? category
  return {
    id,
    title,
    prompt,
    category,
    categoryZh,
    styles: Array.isArray(record.styles) ? record.styles.map(String) : [],
    scenes: Array.isArray(record.scenes) ? record.scenes.map(String) : [],
    sourceLabel: typeof record.sourceLabel === 'string' ? record.sourceLabel : '',
    sourceUrl: typeof record.sourceUrl === 'string' ? record.sourceUrl : '',
    githubUrl: typeof record.githubUrl === 'string' ? record.githubUrl : '',
    image,
    featured: record.featured === true,
  }
}

/** Accept either a legacy bare file name or a safe absolute image URL. */
function imageRefOf(value: string): string {
  const raw = value.trim()
  if (/^https?:\/\//i.test(raw)) {
    if (raw.length > MAX_IMAGE_URL_LENGTH) return ''
    try {
      const url = new URL(raw)
      return (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === ''
        ? url.toString()
        : ''
    } catch {
      return ''
    }
  }
  const name = raw.replace(/^\/+/, '').split('/').pop() ?? ''
  return IMAGE_FILE_PATTERN.test(name) ? name : ''
}

/** Parse a snapshot payload (bundled, refreshed cache, or fresh download). */
function parseSnapshot(payload: unknown): { cases: TemplateCase[]; repository: string; fetchedAt: string } | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  const snapshot = payload as CasesSnapshot
  if (!Array.isArray(snapshot.cases)) return undefined
  const cases: TemplateCase[] = []
  for (const raw of snapshot.cases) {
    const normalized = normalizeCase(raw)
    if (normalized !== undefined) cases.push(normalized)
  }
  if (cases.length === 0) return undefined
  return {
    cases,
    repository: typeof snapshot.repository === 'string' && snapshot.repository !== '' ? snapshot.repository : 'freestylefly/awesome-gpt-image-2',
    fetchedAt: typeof snapshot.fetchedAt === 'string' && snapshot.fetchedAt !== '' ? snapshot.fetchedAt : '',
  }
}

/** Read + parse a snapshot file; undefined when missing/corrupt. */
async function readSnapshotFile(file: string): Promise<ReturnType<typeof parseSnapshot>> {
  try {
    return parseSnapshot(JSON.parse(await fs.readFile(file, 'utf8')))
  } catch {
    return undefined
  }
}

/**
 * The active template list of one source: the refreshed runtime copy wins, the
 * bundled snapshot is the always-available fallback. Memoized per source; a
 * successful refresh replaces that source's memo.
 */
export async function listTemplates(sourceId: string = DEFAULT_TEMPLATE_SOURCE_ID): Promise<TemplateListResult> {
  const def = sourceDefOf(sourceId)
  if (def === undefined) throw new Error(`未知的模板库来源：${sourceId}`)
  const memoKey = `${imageDataRoot()}/${sourceId}`
  const memo = memos.get(memoKey)
  if (memo !== undefined) return memo
  const refreshed = await readSnapshotFile(path.join(imageDataRoot(), 'templates', sourceId, 'cases.json'))
    ?? (def.legacySnapshotPath !== undefined ? await readSnapshotFile(path.join(imageDataRoot(), 'templates', 'cases.json')) : undefined)
  if (refreshed !== undefined) {
    const result: TemplateListResult = { sourceId, ...refreshed, total: refreshed.cases.length, origin: 'refreshed' }
    memos.set(`${imageDataRoot()}/${sourceId}`, result)
    return result
  }
  const bundled = await readSnapshotFile(def.bundledPath)
  if (bundled !== undefined) {
    const result: TemplateListResult = { sourceId, ...bundled, total: bundled.cases.length, origin: 'bundled' }
    memos.set(`${imageDataRoot()}/${sourceId}`, result)
    return result
  }
  const result: TemplateListResult = { sourceId, cases: [], total: 0, origin: 'bundled', repository: 'freestylefly/awesome-gpt-image-2', fetchedAt: '' }
  memos.set(`${imageDataRoot()}/${sourceId}`, result)
  return result
}

/**
 * Re-download one source's case list from its upstream mirror and persist it
 * as the runtime copy. Throws with a user-presentable message on failure; the
 * previous list (refreshed or bundled) stays active.
 */
export async function refreshTemplates(sourceId: string = DEFAULT_TEMPLATE_SOURCE_ID): Promise<TemplateRefreshResult> {
  const def = sourceDefOf(sourceId)
  if (def === undefined) throw new Error(`未知的模板库来源：${sourceId}`)
  if (def.refreshable === false || def.listUrl === undefined) {
    throw new Error('该模板库为随插件版本更新的内置快照，暂不支持在线刷新')
  }
  let response: Response
  try {
    response = await templateFetch(def.listUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  } catch (error) {
    throw new Error(`无法连接模板库源站（${sourceId}）：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) throw new Error(`模板库源站拒绝请求（HTTP ${response.status}）`)
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error('模板库源站返回了非 JSON 响应')
  }
  const parsed = parseSnapshot(sourceId === 'image-prompts' ? registrySnapshot(payload) : payload)
  if (parsed === undefined) throw new Error('模板库源站数据格式无效')
  const fetchedAt = new Date().toISOString()
  const snapshot = {
    repository: parsed.repository,
    sourceUrl: def.listUrl,
    fetchedAt,
    totalCases: parsed.cases.length,
    cases: parsed.cases,
  }
  const target = path.join(imageDataRoot(), 'templates', sourceId, 'cases.json')
  await fs.mkdir(path.dirname(target), { recursive: true })
  await atomicWrite(target, JSON.stringify(snapshot))
  const result: TemplateListResult = { sourceId, cases: parsed.cases, total: parsed.cases.length, origin: 'refreshed', repository: parsed.repository, fetchedAt }
  memos.set(`${imageDataRoot()}/${sourceId}`, result)
  return { sourceId, total: parsed.cases.length, fetchedAt }
}

/** Per-source outcome of one background sync pass. */
export interface TemplateSyncReport {
  sourceId: string
  ok: boolean
  total: number
  error?: string
}

/** Fisher–Yates shuffle (returns a copy; never mutates the pool). */
function shuffled<T>(items: T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    const a = out[i]!
    out[i] = out[j]!
    out[j] = a
  }
  return out
}

/**
 * Draw up to `count` random cases across every source that has data,
 * round-robin between sources so one huge library cannot crowd out the
 * others, then shuffle the final pick. Reads memoized lists, so this never
 * touches the network — cheap enough for every shuffle click.
 */
export async function sampleTemplates(count: number = 9): Promise<TemplateSample[]> {
  const size = Math.min(12, Math.max(1, Math.floor(count) || 9))
  const pools: Array<{ sourceId: string; cases: TemplateCase[] }> = []
  for (const source of TEMPLATE_SOURCES) {
    try {
      const list = await listTemplates(source.id)
      if (list.cases.length > 0) pools.push({ sourceId: source.id, cases: shuffled(list.cases) })
    } catch { /* an unusable source just contributes nothing */ }
  }
  const picks: TemplateSample[] = []
  for (let round = 0; picks.length < size && pools.some(pool => pool.cases.length > 0); round += 1) {
    const pool = pools[round % pools.length]!
    const picked = pool.cases.pop()
    if (picked !== undefined) picks.push({ sourceId: pool.sourceId, case: picked })
  }
  return shuffled(picks)
}

/** Serially refresh every registered source; one failure never stops the rest. */
export async function syncAllTemplates(): Promise<TemplateSyncReport[]> {
  const reports: TemplateSyncReport[] = []
  for (const source of TEMPLATE_SOURCES) {
    try {
      const def = sourceDefOf(source.id)
      if (def?.refreshable === false || def?.listUrl === undefined) {
        const bundled = await listTemplates(source.id)
        reports.push({ sourceId: source.id, ok: true, total: bundled.total })
        continue
      }
      const result = await refreshTemplates(source.id)
      reports.push({ sourceId: source.id, ok: true, total: result.total })
    } catch (error) {
      reports.push({ sourceId: source.id, ok: false, total: 0, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return reports
}

function isAllowedImageRef(def: TemplateSourceDef, ref: string): boolean {
  if (!/^https?:\/\//i.test(ref)) return IMAGE_FILE_PATTERN.test(ref) && !ref.includes('..')
  if (ref.length > MAX_IMAGE_URL_LENGTH || ref.includes('..')) return false
  try {
    const url = new URL(ref)
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && url.username === ''
      && url.password === ''
      && (def.allowedImageHosts ?? []).includes(url.hostname.toLowerCase())
  } catch {
    return false
  }
}

/** All upstream URLs to try for one image reference. */
function githubImageUrls(ref: string): string[] {
  const cdn = /^https:\/\/cdn\.jsdelivr\.net\/gh\/([^/]+\/[^/@]+)@([^/]+)(\/.*)$/i.exec(ref)
  if (cdn) return [ref, `https://raw.githubusercontent.com/${cdn[1]}/${cdn[2]}${cdn[3]}`]
  const github = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:blob|raw)\/([^/]+)(\/[^?]+)(?:\?.*)?$/i.exec(ref)
  if (github) return [`https://raw.githubusercontent.com/${github[1]}/${github[2]}${github[3]}`, ref]
  return [ref]
}

/** All upstream URLs to try for one image reference. */
function imageUrlsOf(def: TemplateSourceDef, ref: string): string[] {
  if (/^https?:\/\//i.test(ref)) return (def.imageUrls ?? (value => [value]))(ref)
  if (def.imageBaseUrl === undefined) return []
  return [`${def.imageBaseUrl}${encodeURIComponent(ref)}`]
}

/** Cache file name: legacy bare names stay readable; remote URLs are hashed. */
function cacheFileOf(ref: string): string {
  if (IMAGE_FILE_PATTERN.test(ref) && !ref.includes('..')) return ref
  let ext = ''
  try {
    const url = new URL(ref)
    ext = path.extname(url.pathname).toLowerCase()
    if (!/^\.[a-z0-9]{2,5}$/.test(ext)) {
      const format = (url.searchParams.get('format') ?? '').toLowerCase()
      ext = ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(format) ? `.${format}` : ''
    }
  } catch { /* hash below is enough */ }
  const hash = createHash('sha256').update(ref).digest('hex').slice(0, 32)
  return `${hash}${ext}`
}

/** Shared transfer budget; cache files and in-flight keys stay view-scoped. */
let activeDownloads = 0
const downloadWaiters: Array<() => void> = []

/** One host-wide limit also covers lazy thumbnails and concurrent page batches. */
async function withDownloadSlot<T>(work: () => Promise<T>): Promise<T> {
  if (activeDownloads >= TEMPLATE_DOWNLOAD_CONCURRENCY) await new Promise<void>(resolve => downloadWaiters.push(resolve))
  else activeDownloads += 1
  try { return await work() } finally {
    const next = downloadWaiters.shift()
    if (next) next()
    else activeDownloads -= 1
  }
}

async function fetchTemplateImage(def: TemplateSourceDef, ref: string, cacheFile: string, cacheDir: string): Promise<{ data: Buffer; mime: string } | undefined> {
  return withDownloadSlot(async () => {
    for (const url of imageUrlsOf(def, ref)) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const response = await templateFetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
          if (!response.ok) {
            await response.body?.cancel()
            if (attempt === 0 && [408, 429, 500, 502, 503, 504].includes(response.status)) {
              const delay = Number(response.headers.get('retry-after'))
              await new Promise(resolve => setTimeout(resolve, Number.isFinite(delay) && delay > 0 ? Math.min(delay * 1000, 5000) : 250))
              continue
            }
            console.error('[imagegen] template image HTTP failure', response.status, new URL(url).hostname)
            break
          }
          const data = await readLimitedBody(response, MAX_IMAGE_BYTES)
          const mime = assertCompleteImage(data)
          await fs.mkdir(cacheDir, { recursive: true })
          await atomicWrite(path.join(cacheDir, cacheFile), data)
          return { data, mime }
        } catch (error) {
          console.error('[imagegen] template image download/cache failed', error instanceof Error ? error.message : String(error))
        }
      }
    }
    return undefined
  })
}

/**
 * Read one reference image for a source's library. Cache hit → disk; miss →
 * fetch from that source's mirror, cache, and serve. Only file names present
 * in the active case list are served, so the route can never act as an open
 * proxy. Undefined when the name is unknown or the fetch failed.
 */
export async function readTemplateImage(sourceId: string, file: string, scope: string = 'library'): Promise<{ data: Buffer; mime: string } | undefined> {
  if (!/^(library|inspiration|all|favorites|detail|source-[a-z-]+)$/.test(scope)) return undefined
  const def = sourceDefOf(sourceId)
  if (def === undefined) return undefined
  if (!isAllowedImageRef(def, file)) return undefined
  const list = await listTemplates(sourceId)
  if (!list.cases.some(entry => entry.image === file)) return undefined
  const cacheDir = path.join(imageDataRoot(), 'template-images', scope, sourceId)
  const cacheFile = cacheFileOf(file)
  try {
    const data = await fs.readFile(path.join(cacheDir, cacheFile))
    const mime = assertCompleteImage(data)
    if (mime !== undefined) return { data, mime }
  } catch { /* fall through to legacy cache / download */ }
  const cacheKey = `${cacheDir}/${file}`
  const inflight = inflightImages.get(cacheKey)
  if (inflight !== undefined) return inflight
  const pending = fetchTemplateImage(def, file, cacheFile, cacheDir)
  inflightImages.set(cacheKey, pending)
  try {
    return await pending
  } finally {
    inflightImages.delete(cacheKey)
  }
}

/** Drop the in-memory list memos (tests). */
export function clearTemplateMemo(): void {
  memos.clear()
}
