/** Shared atomic writes and crash recovery for history and gallery. */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { assertCompleteImage } from './image-format.ts'

interface ImageFile { file: string; mime: string }
interface ImageEntry { id: string; createdAt: number; images: ImageFile[]; references?: ImageFile[] }
export interface ImageWrite { file: string; b64: string }
interface Journal<T> { entry: T; previousFiles: string[]; files: Array<{ file: string; bytes: number; sha256: string }> }
const reconciled = new Set<string>()
const imageName = /^[a-zA-Z0-9][a-zA-Z0-9-]*-(?:ref-)?[0-9]+\.(png|jpg|jpeg|webp|gif)$/
const digest = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

/** A failed write never exposes a partial destination or leaves its temp file. */
export async function atomicWrite(file: string, data: string | Buffer): Promise<void> {
  const temporary = `${file}.part-${randomUUID()}`
  try {
    await fs.writeFile(temporary, data, { flag: 'wx' })
    await fs.rename(temporary, file)
  } finally {
    await fs.rm(temporary, { force: true }).catch(error => {
      console.error('[dsh-imagegen] temporary file cleanup failed:', temporary, error)
    })
  }
}

/** Only a missing index means an empty store; other errors must not erase it. */
export async function readStoredIndex<T>(directory: string, guard: (value: unknown) => value is T): Promise<T[]> {
  let raw: string
  try { raw = await fs.readFile(path.join(directory, 'index.json'), 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const parsed: unknown = JSON.parse(raw)
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as { entries?: unknown }).entries)) {
    throw new Error(`图片索引格式损坏：${directory}`)
  }
  const entries = (parsed as { entries: unknown[] }).entries
  if (!entries.every(guard)) throw new Error(`图片索引条目损坏：${directory}`)
  return entries
}

/** Journal metadata before bytes; publish the index before removing any old files. */
export async function commitImageEntry<T extends ImageEntry>(directory: string, entry: T, writes: ImageWrite[], entries: T[], previous?: T): Promise<void> {
  const journals = path.join(directory, 'transactions')
  await fs.mkdir(journals, { recursive: true })
  const journal = path.join(journals, `${randomUUID()}.json`)
  const record: Journal<T> = { entry,
    previousFiles: previous === undefined ? [] : [...previous.images, ...(previous.references ?? [])].map(image => image.file),
    files: writes.map(write => {
      // Decode one image at a time; a 100-image batch must not retain another
      // entire batch of binary buffers alongside its base64 input.
      const data = Buffer.from(write.b64, 'base64')
      assertCompleteImage(data)
      return { file: write.file, bytes: data.length, sha256: digest(data) }
    }),
  }
  await atomicWrite(journal, JSON.stringify(record))
  let imagesComplete = false
  try {
    for (const write of writes) await atomicWrite(path.join(directory, 'images', write.file), Buffer.from(write.b64, 'base64'))
    imagesComplete = true
    await atomicWrite(path.join(directory, 'index.json'), JSON.stringify({ entries }))
  } catch (error) {
    // Include every planned name, even the write that failed. New unique names
    // cannot collide with a previously committed retry of the same task id.
    if (!imagesComplete) {
      for (const write of writes) await fs.rm(path.join(directory, 'images', write.file), { force: true }).catch(cleanupError => {
        console.error('[dsh-imagegen] image cleanup failed:', write.file, cleanupError)
      })
    }
    // Keep the journal: the next read/restart can recover metadata and complete
    // files after an index failure, or display a failed save with its inputs.
    throw error
  }
  await fs.rm(journal, { force: true }).catch(error => { console.error('[dsh-imagegen] journal cleanup failed:', error) })
}

/** Reconcile interrupted transactions and, once per directory, legacy orphans. */
export async function recoverImageEntries<T extends ImageEntry>(
  directory: string, entries: T[], guard: (value: unknown) => value is T,
  orphan: (id: string, createdAt: number, images: ImageFile[]) => T,
): Promise<T[]> {
  const journals = path.join(directory, 'transactions')
  const names = await fs.readdir(journals).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [] as string[]
    throw error
  })
  const consumed: string[] = []
  const obsolete = new Set<string>()
  let recovered = entries
  for (const name of names.filter(name => /^[a-f0-9-]+\.json$/.test(name)).sort()) {
    const file = path.join(journals, name)
    const journal: Journal<T> = JSON.parse(await fs.readFile(file, 'utf8'))
    if (!guard(journal.entry) || !Array.isArray(journal.previousFiles) || !journal.previousFiles.every(file => typeof file === 'string' && imageName.test(file)) || !Array.isArray(journal.files)
      || !journal.files.every(item => imageName.test(item.file) && typeof item.bytes === 'number' && typeof item.sha256 === 'string')) {
      throw new Error(`图片恢复日志损坏：${file}`)
    }
    const expected = [...journal.entry.images, ...(journal.entry.references ?? [])]
    if (expected.length !== journal.files.length || expected.some(image => !journal.files.some(item => item.file === image.file))) {
      throw new Error(`图片恢复日志文件列表不匹配：${file}`)
    }
    const existing = recovered.find(entry => entry.id === journal.entry.id)
    const existingFiles = existing === undefined ? [] : [...existing.images, ...(existing.references ?? [])].map(image => image.file)
    const matchesPrevious = existingFiles.length === journal.previousFiles.length && existingFiles.every(file => journal.previousFiles.includes(file))
    if (existing === undefined || matchesPrevious) {
      const valid = new Set<string>()
      for (const item of journal.files) {
        try {
          const data = await fs.readFile(path.join(directory, 'images', item.file))
          assertCompleteImage(data)
          if (data.length === item.bytes && digest(data) === item.sha256) valid.add(item.file)
        } catch { /* missing/partial bytes remain excluded from recovered entries */ }
      }
      const incomplete = valid.size !== journal.files.length
      const entry = { ...journal.entry,
        images: journal.entry.images.filter(image => valid.has(image.file)),
        references: journal.entry.references?.filter(image => valid.has(image.file)),
        ...(incomplete ? { status: 'failed', error: '图片生成后保存中断，已恢复输入记录；部分图片未保存' } : {}),
      }
      // A failed replacement must preserve the previous successful record.
      if (existing === undefined || !incomplete) {
        recovered = [entry, ...recovered.filter(old => old.id !== entry.id)]
        for (const file of existingFiles) obsolete.add(file)
      }
      console.warn('[dsh-imagegen] recovered interrupted image save:', entry.id, incomplete ? 'incomplete' : 'complete')
    }
    consumed.push(file)
  }
  if (!reconciled.has(directory)) {
    const known = new Set(recovered.flatMap(entry => [...entry.images, ...(entry.references ?? [])].map(image => image.file)))
    const groups = new Map<string, { createdAt: number; images: ImageFile[] }>()
    const files = await fs.readdir(path.join(directory, 'images')).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [] as string[]
      throw error
    })
    for (const file of files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
      if (file.includes('.part-')) {
        console.warn('[dsh-imagegen] interrupted temporary image retained for inspection:', file)
        continue
      }
      if (!imageName.test(file) || known.has(file) || obsolete.has(file) || /-ref-\d+\./.test(file)) continue
      try {
        const full = path.join(directory, 'images', file)
        const mime = assertCompleteImage(await fs.readFile(full))
        const id = file.replace(/-\d+\.[^.]+$/, '')
        const group = groups.get(id) ?? { createdAt: (await fs.stat(full)).mtimeMs, images: [] }
        group.images.push({ file, mime })
        groups.set(id, group)
      } catch (error) { console.warn('[dsh-imagegen] invalid orphan image retained for inspection:', file, error) }
    }
    for (const [id, group] of groups) {
      // A legacy prefix can match an indexed task. Never overwrite its metadata.
      const recoveredId = recovered.some(entry => entry.id === id) ? `recovered-${randomUUID()}` : id
      recovered = [orphan(recoveredId, group.createdAt, group.images), ...recovered]
      console.warn('[dsh-imagegen] recovered orphan images (original inputs unknown):', id, group.images.length)
    }
  }
  if (recovered !== entries) {
    recovered.sort((a, b) => b.createdAt - a.createdAt)
    await fs.mkdir(directory, { recursive: true })
    await atomicWrite(path.join(directory, 'index.json'), JSON.stringify({ entries: recovered }))
  }
  for (const file of consumed) await fs.rm(file, { force: true })
  for (const file of obsolete) await fs.rm(path.join(directory, 'images', file), { force: true }).catch(error => {
    console.error('[dsh-imagegen] replaced image cleanup failed:', file, error)
  })
  reconciled.add(directory)
  return recovered
}
