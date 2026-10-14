/**
 * Host-persisted generation history: images are stored as individual files
 * under ~/.dsh/dsh-imagegen/images/ and an index.json keeps the metadata +
 * file names. This makes the history survive across browsers/devices that
 * connect to the same DSH host, and keeps list responses small (the browser
 * loads image bytes lazily through the history image route).
 *
 * Framework-free (node:fs only) so the route layer can drive it directly.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWrite, commitImageEntry, readStoredIndex, recoverImageEntries, type ImageWrite } from './image-store-io.ts'
import { assertCompleteImage } from './image-format.ts'
import { HISTORY_MAX, type GenerateMode, type HistoryEntry, type HistoryEntryInput, type HistoryTaskMeta } from './protocol.ts'
import { notifyImageSaved } from './storage-sync.ts'
import { imageDataRoot } from './image-storage-path.ts'

function historyDir(): string { return imageDataRoot() }
function indexPath(): string { return path.join(historyDir(), 'index.json') }
function imagesDir(): string { return path.join(historyDir(), 'images') }

// History mutations read and replace one shared index. Serialize them so
// overlapping requests cannot each read an old index and lose the other's row.
let pendingMutation: Promise<void> = Promise.resolve()

function mutateHistory<T>(operation: () => Promise<T>): Promise<T> {
  const next = pendingMutation.then(operation, operation)
  pendingMutation = next.then(() => undefined, () => undefined)
  return next
}

/** One image's on-disk record (file name + mime, never base64). */
interface StoredImage {
  file: string
  mime: string
  revisedPrompt?: string
}

/** One entry's on-disk record. */
interface StoredEntry extends HistoryTaskMeta {
  references?: StoredImage[]
  id: string
  createdAt: number
  mode: GenerateMode
  model: string
  prompt: string
  size: string
  quality: string
  detail: string
  n: number
  images: StoredImage[]
  refName?: string
  channelId?: string
  channel?: string
  comparisonId?: string
  comparisonModels?: string[]
  workflow?: 'ecommerce'
  projectId?: string
  projectName?: string
  slotKey?: string
  slotLabel?: string
  canvas?: HistoryEntryInput['canvas']
}

/** File extension for a MIME type (image file names). */
function extensionOf(mime: string): string {
  switch (mime.split(';')[0]!.trim()) {
    case 'image/jpeg': return 'jpg'
    case 'image/webp': return 'webp'
    case 'image/gif': return 'gif'
    default: return 'png'
  }
}

/** Sanitize an entry id for use as a file-name prefix. */
function safeId(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9-]/g, '-').replace(/^-+/, '')
  return cleaned === '' ? 'entry' : cleaned
}

/** Ensure the storage directories exist. */
async function ensureDirs(): Promise<void> {
  await fs.mkdir(imagesDir(), { recursive: true })
}

/** Recover interrupted saves before exposing persisted records. */
async function readIndex(): Promise<StoredEntry[]> {
  const entries = await readStoredIndex(historyDir(), isStoredEntry)
  return recoverImageEntries(historyDir(), entries, isStoredEntry, (id, createdAt, images) => ({
    id, createdAt, mode: 'text', model: 'unknown', prompt: '', size: 'auto',
    quality: 'auto', detail: '', n: images.length, images,
    status: 'completed', error: '已恢复遗留图片，原始提示词和生成参数未知',
  }))
}

/** Persist the index without exposing a partial JSON document. */
async function writeIndex(entries: StoredEntry[]): Promise<void> {
  await ensureDirs()
  await atomicWrite(indexPath(), JSON.stringify({ entries }))
}

/** Structural guard for a stored entry. */
function isStoredEntry(value: unknown): value is StoredEntry {
  if (value === null || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return typeof entry.id === 'string'
    && typeof entry.createdAt === 'number'
    && (entry.mode === 'text' || entry.mode === 'edit')
    && (entry.workflow === undefined || entry.workflow === 'ecommerce')
    && (entry.projectId === undefined || typeof entry.projectId === 'string')
    && (entry.projectName === undefined || typeof entry.projectName === 'string')
    && (entry.slotKey === undefined || typeof entry.slotKey === 'string')
    && (entry.slotLabel === undefined || typeof entry.slotLabel === 'string')
    && typeof entry.prompt === 'string'
    && Array.isArray(entry.images)
    && entry.images.every(image => {
      if (image === null || typeof image !== 'object') return false
      const record = image as Record<string, unknown>
      return typeof record.file === 'string' && typeof record.mime === 'string'
    })
}

/** Remove one entry's image files (best effort). */
async function removeEntryFiles(entry: StoredEntry): Promise<void> {
  for (const image of [...entry.images, ...(entry.references ?? [])]) {
    try { await fs.rm(path.join(imagesDir(), image.file), { force: true }) } catch { /* ignore */ }
  }
}

/** Project a stored entry onto the wire shape (image URLs). */
function toWire(entry: StoredEntry): HistoryEntry {
  return {
    id: entry.id,
    createdAt: entry.createdAt,
    mode: entry.mode,
    model: entry.model,
    prompt: entry.prompt,
    size: entry.size,
    quality: entry.quality,
    detail: entry.detail,
    n: entry.n,
    ...taskMetadata(entry),
    references: (entry.references ?? []).map(image => ({ url: `/api/dsh-imagegen/history/image/${image.file}`, mime: image.mime })),
    images: entry.images.map(image => ({
      url: `/api/dsh-imagegen/history/image/${image.file}`,
      mime: image.mime,
      ...image.revisedPrompt === undefined ? {} : { revisedPrompt: image.revisedPrompt },
    })),
    ...entry.refName === undefined ? {} : { refName: entry.refName },
    ...entry.channel === undefined ? {} : { channel: entry.channel },
    ...entry.channelId === undefined ? {} : { channelId: entry.channelId },
    ...entry.comparisonId === undefined ? {} : { comparisonId: entry.comparisonId },
    ...entry.comparisonModels === undefined ? {} : { comparisonModels: entry.comparisonModels },
    ...entry.workflow === undefined ? {} : { workflow: entry.workflow },
    ...entry.projectId === undefined ? {} : { projectId: entry.projectId },
    ...entry.projectName === undefined ? {} : { projectName: entry.projectName },
    ...entry.slotKey === undefined ? {} : { slotKey: entry.slotKey },
    ...entry.slotLabel === undefined ? {} : { slotLabel: entry.slotLabel },
    ...entry.canvas === undefined ? {} : { canvas: entry.canvas },
  }
}

/** Keep task metadata in one projection for storage and API output. */
function taskMetadata(input: HistoryTaskMeta): HistoryTaskMeta {
  return {
    ...input.taskId === undefined ? {} : { taskId: input.taskId },
    ...input.status === undefined ? {} : { status: input.status },
    ...input.error === undefined ? {} : { error: input.error },
    ...input.startedAt === undefined ? {} : { startedAt: input.startedAt },
    ...input.finishedAt === undefined ? {} : { finishedAt: input.finishedAt },
    ...input.upstream === undefined ? {} : { upstream: input.upstream },
  }
}

/** List the persisted history, newest first, as wire entries. */
export async function listHistory(): Promise<HistoryEntry[]> {
  return mutateHistory(async () => (await readIndex()).map(toWire))
}

/** Append one generation, evicting the oldest beyond HISTORY_MAX. */
export async function appendHistory(input: HistoryEntryInput): Promise<HistoryEntry[]> {
  return mutateHistory(async () => {
    await ensureDirs()
    const previous = await readIndex()
    const prefix = `${safeId(input.id)}-${randomUUID()}`
    const storedImages: StoredImage[] = []
    const storedReferences: StoredImage[] = []
    const writes: ImageWrite[] = []
    for (let index = 0; index < input.images.length; index++) {
      const image = input.images[index]!
      const file = `${prefix}-${index}.${extensionOf(image.mime)}`
      writes.push({ file, b64: image.b64 })
      storedImages.push({ file, mime: image.mime,
        ...image.revisedPrompt === undefined ? {} : { revisedPrompt: image.revisedPrompt },
      })
    }
    for (const [index, image] of (input.references ?? []).entries()) {
      const file = `${prefix}-ref-${index}.${extensionOf(image.mime)}`
      writes.push({ file, b64: image.b64 })
      storedReferences.push({ file, mime: image.mime })
    }
    const entry: StoredEntry = {
      id: input.id,
      createdAt: input.createdAt,
      mode: input.mode,
      model: input.model,
      prompt: input.prompt,
      size: input.size,
      quality: input.quality ?? 'auto',
      detail: input.detail ?? '',
      n: input.n,
      ...taskMetadata(input),
      references: storedReferences,
      images: storedImages,
      ...input.refName === undefined ? {} : { refName: input.refName },
      ...input.channelId === undefined ? {} : { channelId: input.channelId },
      ...input.channel === undefined ? {} : { channel: input.channel },
      ...input.comparisonId === undefined ? {} : { comparisonId: input.comparisonId },
      ...input.comparisonModels === undefined ? {} : { comparisonModels: input.comparisonModels },
      ...input.workflow === undefined ? {} : { workflow: input.workflow },
      ...input.projectId === undefined ? {} : { projectId: input.projectId },
      ...input.projectName === undefined ? {} : { projectName: input.projectName },
      ...input.slotKey === undefined ? {} : { slotKey: input.slotKey },
      ...input.slotLabel === undefined ? {} : { slotLabel: input.slotLabel },
      ...input.canvas === undefined ? {} : { canvas: input.canvas },
    }
    const merged = [entry, ...previous.filter(old => old.id !== entry.id)]
    const kept = merged.slice(0, HISTORY_MAX)
    await commitImageEntry(historyDir(), entry, writes, kept, previous.find(old => old.id === entry.id))
    for (const image of storedImages) notifyImageSaved('history', path.join(imagesDir(), image.file))
    for (const dropped of previous.filter(old => old.id === entry.id || !kept.some(item => item.id === old.id))) await removeEntryFiles(dropped)
    return kept.map(toWire)
  })
}

/** Remove one entry (and its image files). */
export async function removeHistory(id: string): Promise<HistoryEntry[]> {
  return mutateHistory(async () => {
    const previous = await readIndex()
    const target = previous.find(entry => entry.id === id)
    const kept = previous.filter(entry => entry.id !== id)
    await writeIndex(kept)
    if (target !== undefined) await removeEntryFiles(target)
    return kept.map(toWire)
  })
}

/** Remove every entry (and all image files). */
export async function clearHistory(): Promise<HistoryEntry[]> {
  return mutateHistory(async () => {
    const previous = await readIndex()
    await writeIndex([])
    for (const entry of previous) await removeEntryFiles(entry)
    return []
  })
}

/** Read one stored image file by its (validated) file name. */
export async function readHistoryImage(file: string): Promise<{ data: Buffer; mime: string } | undefined> {
  // Only accept <id>-<index>.<png|jpg|jpeg|webp|gif> — the exact names this
  // store writes — so the route can never escape the images directory.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*-(?:ref-)?[0-9]+\.(png|jpg|jpeg|webp|gif)$/.test(file)) return undefined
  try {
    const data = await fs.readFile(path.join(imagesDir(), file))
    return { data, mime: assertCompleteImage(data) }
  } catch {
    return undefined
  }
}
