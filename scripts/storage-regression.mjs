/** Run with node --experimental-strip-types scripts/storage-regression.mjs. */
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { deflateSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { setImageDataRoot } from '../src/image-storage-path.ts'
import { appendHistory, listHistory, readHistoryImage } from '../src/history-store.ts'
import { appendGallery, listGallery, readGalleryImage } from '../src/gallery-store.ts'
import { assertCompleteImage } from '../src/image-format.ts'
import { setStorageSyncHandler } from '../src/storage-sync.ts'

function crc32(data) {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
function png(red) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data])
    const size = Buffer.alloc(4); size.writeUInt32BE(data.length)
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(body))
    return Buffer.concat([size, body, checksum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, red, 0, 0, 255]))), chunk('IEND', Buffer.alloc(0))])
}
const image = bytes => ({ b64: bytes.toString('base64'), mime: 'image/png' })
const red = png(255), black = png(0)
const entry = (id, images = [image(red), image(black)]) => ({ id, createdAt: Date.now(), mode: 'text',
  model: 'gpt-image-2', prompt: 'retained prompt', size: '3:4', n: images.length, images })
const temporary = await fs.mkdtemp(path.join(tmpdir(), 'dsh-storage-regression-'))
const originalWrite = fs.writeFile, originalRename = fs.rename
let serial = 0
async function setup(kind) {
  const root = path.join(temporary, `${kind}-${serial++}`)
  setImageDataRoot(root)
  const directory = kind === 'history' ? root : path.join(root, 'gallery')
  return { directory, images: path.join(directory, 'images'),
    append: kind === 'history' ? appendHistory : appendGallery,
    list: kind === 'history' ? listHistory : listGallery,
    read: kind === 'history' ? readHistoryImage : readGalleryImage }
}
async function withFault(method, replacement, operation) {
  const original = fs[method]
  fs[method] = replacement(original)
  try { await operation() } finally { fs[method] = original }
}
const failure = code => Object.assign(new Error(`injected ${code}`), { code })
try {
  assert.equal(assertCompleteImage(red), 'image/png')
  assert.throws(() => assertCompleteImage(red.subarray(0, red.length - 1)))
  const oversize = Buffer.from(red); oversize.writeUInt32BE(100000, 33)
  assert.throws(() => assertCompleteImage(oversize), 'truncated IDAT must not pass an IEND-only check')
  assert.throws(() => assertCompleteImage(Buffer.alloc(0)))
  assert.throws(() => assertCompleteImage(Buffer.from('ffd8ff00', 'hex')))
  const webp = Buffer.from('524946460c000000574542505650384c00000000', 'hex')
  assert.equal(assertCompleteImage(webp), 'image/webp')
  assert.throws(() => assertCompleteImage(webp.subarray(0, -1)))
  console.log('PASS image container boundary checks')

  for (const kind of ['history', 'gallery']) {
    for (const failingIndex of [0, 1]) {
      const store = await setup(kind)
      await withFault('writeFile', original => async (file, data, ...options) => {
        if (String(file).startsWith(store.images + path.sep) && String(file).includes(`-${failingIndex}.png.part-`)) {
          await original(file, Buffer.from(data).subarray(0, failingIndex === 0 ? 0 : 12), ...options)
          throw failure('ENOSPC')
        }
        return original(file, data, ...options)
      }, async () => { await assert.rejects(store.append(entry('partial')), /ENOSPC/) })
      assert.deepEqual(await fs.readdir(store.images), [], 'includes the zero/partial in-flight write in cleanup')
      const records = await store.list()
      assert.equal(records.length, 1)
      assert.equal(records[0].prompt, 'retained prompt')
      assert.equal(records[0].status, 'failed')
      assert.equal(records[0].images.length, 0)
      assert.deepEqual(await fs.readdir(path.join(store.directory, 'transactions')), [])
    }
    console.log(`PASS ${kind}: zero/partial in-flight writes cleaned; failed-save inputs recovered`)

    const renameFailure = await setup(kind)
    await withFault('rename', original => async (source, destination) => {
      if (String(destination).startsWith(renameFailure.images + path.sep)) throw failure('EBUSY')
      return original(source, destination)
    }, async () => { await assert.rejects(renameFailure.append(entry('rename')), /EBUSY/) })
    assert.deepEqual(await fs.readdir(renameFailure.images), [], 'failed image rename cleans its temporary file')
    assert.equal((await renameFailure.list())[0].status, 'failed')
    console.log(`PASS ${kind}: failed image rename removes temporary files`)

    for (const stage of ['images', 'index']) {
      const crashed = await setup(kind)
      const root = kind === 'history' ? crashed.directory : path.dirname(crashed.directory)
      const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
        import { promises as fs } from 'node:fs';
        import { setImageDataRoot } from ${JSON.stringify(new URL('../src/image-storage-path.ts', import.meta.url).href)};
        import { ${kind === 'history' ? 'appendHistory' : 'appendGallery'} as append } from ${JSON.stringify(new URL(`../src/${kind}-store.ts`, import.meta.url).href)};
        setImageDataRoot(${JSON.stringify(root)});
        const write = fs.writeFile, rename = fs.rename;
        fs.writeFile = async (file, data, ...options) => {
          if (${JSON.stringify(stage)} === 'images' && String(file).includes('-1.png.part-')) {
            await write(file, Buffer.from(data).subarray(0, 12), ...options);
            process.exit(91);
          }
          return write(file, data, ...options);
        };
        fs.rename = async (source, destination) => {
          if (${JSON.stringify(stage)} === 'index' && String(destination).endsWith('/index.json')) process.exit(92);
          return rename(source, destination);
        };
        await append(${JSON.stringify(entry('crashed'))});
      `], { encoding: 'utf8' })
      assert.equal(child.status, stage === 'images' ? 91 : 92, child.stderr)
      const restored = await crashed.list()
      assert.equal(restored.length, 1)
      assert.equal(restored[0].prompt, 'retained prompt')
      assert.equal(restored[0].images.length, stage === 'images' ? 1 : 2)
      if (stage === 'images') assert.equal(restored[0].status, 'failed')
      assert.deepEqual(await fs.readdir(path.join(crashed.directory, 'transactions')), [])
      assert.equal((await crashed.list()).length, 1)
    }
    console.log(`PASS ${kind}: process exits during image/index writes recover metadata and only complete bytes`)

    const store = await setup(kind)
    await store.append(entry('old', [image(red)]))
    const before = await fs.readFile(path.join(store.directory, 'index.json'), 'utf8')
    const oldFile = JSON.parse(before).entries[0].images[0].file
    const uploads = []
    setStorageSyncHandler((type, file) => uploads.push(file))
    await withFault('rename', original => async (source, destination) => {
      if (destination === path.join(store.directory, 'index.json')) throw failure('EPERM')
      return original(source, destination)
    }, async () => { await assert.rejects(store.append(entry('old', [image(black)])), /EPERM/) })
    assert.equal(await fs.readFile(path.join(store.directory, 'index.json'), 'utf8'), before)
    assert.deepEqual(await fs.readFile(path.join(store.images, oldFile)), red, 'same-id retry cannot overwrite previous bytes')
    assert.equal(uploads.length, 0, 'upload only after committed index')
    const recovered = await store.list()
    assert.equal(recovered.length, 1, 'same-id replacement recovers without duplicate records')
    assert.deepEqual((await store.read(path.basename(recovered[0].images[0].url))).data, black)
    assert.equal((await fs.readdir(store.images)).length, 1, 'old files removed only after successful recovery commit')
    assert.deepEqual(await fs.readdir(path.join(store.directory, 'transactions')), [])
    const success = await store.append(entry('success', [image(red)]))
    assert.equal(uploads.length, 1)
    assert.equal((kind === 'history' ? success : success.entries).length, 2)
    setStorageSyncHandler(undefined)
    console.log(`PASS ${kind}: index failure preserves previous record; replacement recovery and post-commit notifications`)

    const legacy = await setup(kind)
    await fs.mkdir(legacy.images, { recursive: true })
    await fs.writeFile(path.join(legacy.images, 'legacy-0.png'), red)
    await fs.writeFile(path.join(legacy.images, 'legacy-1.png'), black)
    await fs.writeFile(path.join(legacy.images, 'broken-0.png'), red.subarray(0, 12))
    const records = await legacy.list()
    assert.equal(records.length, 1)
    assert.equal(records[0].images.length, 2)
    assert.equal(records[0].prompt, '', 'do not invent missing prompts')
    assert.match(records[0].error, /未知/)
    assert.equal(await legacy.read('broken-0.png'), undefined)
    assert.equal((await legacy.list()).length, 1, 'recovery is idempotent')
    await fs.writeFile(path.join(legacy.directory, 'index.json'), '{broken')
    await assert.rejects(legacy.append(entry('must-not-erase')), SyntaxError)
    assert.equal(await fs.readFile(path.join(legacy.directory, 'index.json'), 'utf8'), '{broken')
    console.log(`PASS ${kind}: legacy orphan recovery, invalid-image route fallback, corrupt-index preservation`)

    const concurrent = await setup(kind)
    await Promise.all(Array.from({ length: 8 }, (_, index) => concurrent.append(entry(`parallel-${index}`, [image(png(index))]))))
    assert.equal((await concurrent.list()).length, 8, 'parallel saves preserve all records')
    assert.equal((await fs.readdir(concurrent.images)).length, 8)
    console.log(`PASS ${kind}: concurrent saves keep all index records`)
  }

  const references = await setup('history')
  await withFault('writeFile', original => async (file, data, ...options) => {
    if (String(file).startsWith(references.images + path.sep) && String(file).includes('-ref-0.png.part-')) {
      await original(file, Buffer.alloc(0), ...options)
      throw failure('EBUSY')
    }
    return original(file, data, ...options)
  }, async () => { await assert.rejects(references.append({ ...entry('refs'), references: [image(red)] }), /EBUSY/) })
  assert.deepEqual(await fs.readdir(references.images), [])
  assert.equal((await references.list())[0].prompt, 'retained prompt')
  console.log('PASS reference image failure cleans generated and in-flight reference files')
  console.log('STORAGE REGRESSION OK')
} finally {
  fs.writeFile = originalWrite; fs.rename = originalRename
  setStorageSyncHandler(undefined); setImageDataRoot(undefined)
  await fs.rm(temporary, { recursive: true, force: true })
}
