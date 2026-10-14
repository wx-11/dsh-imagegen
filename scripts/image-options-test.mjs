import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { generateImage } from '../lib/index.js'
import { IMAGE_RATIOS, IMAGE_COUNTS, normalizeImageCount, imageBatches } from '../src/image-options.ts'
assert.deepEqual(IMAGE_COUNTS, [1, 2, 5, 10, 50, 100])
assert.ok(IMAGE_RATIOS.includes('4:5'))
for (const [input, expected] of [[0, 1], [7, 7], [8.7, 9], [101, 100], [NaN, 1]]) assert.equal(normalizeImageCount(input), expected)
let active = 0, peak = 0, calls = 0
const server = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString())
  assert.equal(body.quality, undefined)
  assert.equal(body.detail, undefined)
  assert.equal(body.resolution, undefined)
  assert.equal(body.image_size, undefined)
  if (body.model === 'gpt-image-2') assert.ok(body.n >= 1 && body.n <= 100)
  else assert.equal(body.n, undefined)
  if (body.model === 'gpt-image-2') assert.equal(body.size, '1024x1280')
  else assert.equal(body.aspect_ratio, '4:5')
  calls++; active++; peak = Math.max(peak, active)
  await new Promise(resolve => setTimeout(resolve, 2)); active--
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ data: Array.from({ length: body.n ?? 1 }, () => ({ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY4sAAAAASUVORK5CYII=' })) }))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
try {
  for (const count of [1, 2, 5, 10, 50, 100, 7]) {
    calls = 0; peak = 0
    const result = await generateImage({ apiUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture' }, { mode: 'text', model: 'gpt-image-2', prompt: 'fixture', size: '4:5', n: count, quality: '4k', detail: 'high' })
    assert.equal(result.images.length, count); assert.equal(calls, 1); assert.equal(peak, 1)
  }
  for (const model of ['grok-imagine-image', 'nanobanana2']) {
    const result = await generateImage({ apiUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture' }, { mode: 'text', model, prompt: 'fixture', size: '4:5', n: 1, quality: '4k', detail: 'high' })
    assert.equal(result.images.length, 1)
  }
  let attempts = 0
  await assert.rejects(imageBatches(10, async () => { attempts++; throw new Error('fixture failure') }), /fixture failure/)
  assert.equal(attempts, 4)
  console.log('PASS native n=1,2,5,10,50,100,7; one submission; ratio=4:5; quality/detail omitted; failed batches stop')
} finally { await new Promise(resolve => server.close(resolve)) }
