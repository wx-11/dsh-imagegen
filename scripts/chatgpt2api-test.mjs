import assert from 'node:assert/strict'
import { generateImage } from '../lib/index.js'
import { listImageModels } from '../src/prompt-enhancer.ts'

const originalFetch = globalThis.fetch
const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY4sAAAAASUVORK5CYII='
const request = { mode: 'text', model: 'gpt-image-2.5-flare', prompt: 'fixture', size: 'auto', n: 100 }
const upstream = { apiUrl: 'https://fixture.invalid/v1/videos', apiKey: 'fixture', apiUrlFull: true }
let submissions = [], polls = [], state = 'completed', actual = 3
globalThis.fetch = async (url, init) => {
  assert.equal(init.headers.authorization, 'Bearer fixture')
  if (String(url).endsWith('/models')) {
    assert.equal(url, 'https://fixture.invalid/v1/models')
    return Response.json({ data: [{ id: 'gpt-image-2.5' }] })
  }
  if (init.method === 'POST') {
    submissions.push({ url, body: JSON.parse(init.body) })
    return Response.json({ id: 'task_fixture', status: 'queued', data: [], n: 100 }, { status: 202 })
  }
  polls.push(url)
  return Response.json({
    id: 'task_fixture', status: state, n: actual, revised_prompt: 'fixture revised',
    data: state === 'completed' ? Array.from({ length: actual }, () => ({ b64_json: b64 })) : [],
    error: state === 'failed' ? { message: 'fixture upstream failure' } : undefined,
  })
}
try {
  assert.deepEqual(await listImageModels(upstream), ['gpt-image-2.5'])
  const result = await generateImage(upstream, request)
  assert.equal(submissions.length, 1)
  assert.deepEqual(submissions[0], { url: upstream.apiUrl, body: { model: request.model, prompt: 'fixture', n: 100, response_format: 'b64_json' } })
  assert.equal(polls[0], 'https://fixture.invalid/v1/videos/task_fixture')
  assert.equal(result.images.length, 3, 'partial success uses actual results')
  assert.equal(result.images[0].revisedPrompt, 'fixture revised')
  for (const model of ['gpt-image-2', 'gpt-image-2.5', 'gpt-image-2.5-sunburst']) {
    const references = Array.from({ length: 8 }, () => `data:image/png;base64,${b64}`)
    await generateImage(upstream, { ...request, model, mode: 'edit', size: '2.35:1', n: 101, image: references[0], images: references.slice(1), quality: 'high', detail: 'high' })
    assert.deepEqual(submissions.at(-1).body, { model, prompt: 'fixture', n: 100, aspect_ratio: '2.35:1', images: references, response_format: 'b64_json' })
  }
  await generateImage({ ...upstream, apiUrl: 'https://fixture.invalid/v1/images/generations' }, request)
  assert.equal(polls.at(-1), 'https://fixture.invalid/v1/tasks/task_fixture')
  state = 'failed'
  await assert.rejects(generateImage(upstream, request), /fixture upstream failure/)
  state = 'completed'; actual = 0
  await assert.rejects(generateImage(upstream, request), /没有图片结果/)
  const controller = new AbortController()
  controller.abort()
  state = 'queued'
  await assert.rejects(generateImage(upstream, request, { signal: controller.signal }))
  console.log('PASS chatgpt2api native n<=100; videos/tasks polling; 8 references; auto omitted; partial results; failure/empty/cancellation')
} finally {
  globalThis.fetch = originalFetch
}
