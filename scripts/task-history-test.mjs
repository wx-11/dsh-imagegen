import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { appendHistory, listHistory, readHistoryImage, removeHistory, clearHistory } from '../src/history-store.ts'
import { setImageDataRoot } from '../src/image-storage-path.ts'
import { ImageGenerationRuntime } from '../lib/index.js'

const directory = await mkdtemp(join(tmpdir(), 'dsh-task-history-'))
setImageDataRoot(directory)
const image = { mime: 'image/png', b64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY4sAAAAASUVORK5CYII=' }
const base = { mode: 'edit', model: 'gpt-image-2', prompt: 'reference fixture', size: '4:5', n: 2, references: [image, image], images: [image, image] }
await Promise.all(Array.from({ length: 20 }, (_, index) => appendHistory({ ...base, id: `task-${index}`, taskId: `task-${index}`, createdAt: index, status: 'completed', startedAt: index, finishedAt: index + 1 })))
let entries = await listHistory()
assert.equal(entries.length, 20, 'parallel tasks must not lose history rows')
const entry = entries.find(entry => entry.id === 'task-7')
assert.equal(entry.references.length, 2)
for (const ref of [...entry.references, ...entry.images]) assert.deepEqual((await readHistoryImage(basename(ref.url))).data, Buffer.from(image.b64, 'base64'))
assert.equal(await readHistoryImage('../index.json'), undefined)
await appendHistory({ ...base, id: 'task-7', taskId: 'task-7', createdAt: 7, status: 'failed', error: 'fixture failure', images: [] })
entries = await listHistory()
assert.equal(entries.length, 20, 'same task ID is deduplicated')
assert.equal(entries.find(entry => entry.id === 'task-7').error, 'fixture failure')
const disk = JSON.parse(await readFile(join(directory, 'index.json'), 'utf8'))
assert.equal(disk.entries.length, 20)
assert.equal(disk.entries.find(entry => entry.id === 'task-7').references.length, 2, 'references survive persisted reload')
await removeHistory('task-7')
assert.equal((await listHistory()).length, 19)
assert.equal(await readHistoryImage(basename(entry.references[0].url)), undefined, 'deleting a record deletes its reference files')
await clearHistory()

const saved = []
const history = { async append(entry) { saved.push(entry); return [] } }
const noChannel = new ImageGenerationRuntime(() => ({ channels: [], defaultChannelId: '' }), history)
await assert.rejects(noChannel.run({ ...base, image: `data:image/png;base64,${image.b64}`, images: undefined }), /尚未配置/)
assert.equal(saved.at(-1).status, 'failed')
assert.equal(saved.at(-1).references.length, 1)
let release
const gate = new Promise(resolve => { release = resolve })
const runtime = new ImageGenerationRuntime(() => ({ channels: [{ id: 'sub', auth: 'subscription', subscription: 'grok' }], defaultChannelId: 'sub' }), history, {
  async generate() { await gate; return [{ b64_json: image.b64 }] },
})
const request = { mode: 'text', model: 'grok-imagine-image', prompt: 'fixture', size: '1:1', n: 1 }
const running = Array.from({ length: 4 }, () => runtime.queue.submit(request))
const queued = runtime.queue.submit(request)
assert.equal(queued.status, 'queued')
runtime.queue.cancel(queued.id)
release()
for (let i = 0; i < 100 && running.some(task => runtime.queue.get(task.id).status === 'running'); i++) await new Promise(resolve => setTimeout(resolve, 5))
assert.equal(saved.find(entry => entry.taskId === queued.id).status, 'cancelled', 'queued cancellation is persisted')
for (const task of running) {
  assert.equal(runtime.queue.get(task.id).status, 'completed')
  assert.equal(saved.find(entry => entry.taskId === task.id).id, task.id, 'queue and durable history share identity')
}
console.log('PASS parallel persistence, task deduplication, reference reload/read/delete, failed records, queued cancellation, completed task identity')
