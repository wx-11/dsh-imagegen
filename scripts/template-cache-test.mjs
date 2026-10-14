import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import net from 'node:net'
import { imageDataRoot, setImageDataRoot, setTemplateImageCacheRoot, templateImageCacheRoot } from '../src/image-storage-path.ts'
import { listTemplates, refreshTemplates, readTemplateImage, clearTemplateMemo } from '../src/templates-store.ts'
import { setTemplateProxy, templateFetch, readLimitedBody } from '../src/template-network.ts'
import { matchesTemplate } from '../src/template-registry.ts'
import { TEMPLATE_DOWNLOAD_CONCURRENCY } from '../src/protocol.ts'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'imagegen-template-test-'))
const realFetch = globalThis.fetch
const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010804000000b51c0c020000000b4944415478da6364f80f00010501012718e3660000000049454e44ae426082', 'hex')
let downloads = 0
let active = 0
let peak = 0
const upstream = http.createServer((req, res) => { res.end('via configured proxy') })
const proxy = http.createServer()
const sockets = new Set()
let tunnels = 0
proxy.on('connect', (req, socket, head) => {
  tunnels++
  const [host, port] = req.url.split(':')
  const target = net.connect(Number(port), host, () => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head.length) target.write(head)
    target.pipe(socket); socket.pipe(target)
  })
  for (const item of [socket, target]) { sockets.add(item); item.on('close', () => sockets.delete(item)) }
  target.on('error', () => socket.destroy())
  socket.on('error', () => target.destroy())
})
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
try {
  setImageDataRoot(root)
  const registry = await listTemplates('image-prompts')
  assert.ok(registry.total >= 1700)
  assert.ok(registry.cases.every(item => item.id && item.title && item.prompt && item.sourceUrl && item.githubUrl))
  const item = { title: 'A CAT Poster', prompt: 'Make a red car', sourceLabel: 'ghostauthor', category: 'phantomcategory' }
  assert.equal(matchesTemplate(item, 'cat'), true)
  assert.equal(matchesTemplate(item, 'RED CAR'), true)
  assert.equal(matchesTemplate(item, 'ghostauthor'), false)
  assert.equal(matchesTemplate(item, 'phantomcategory'), false)
  assert.equal(matchesTemplate(item, 'cat.*'), false)
  assert.equal(matchesTemplate(item, 'red cat'), false)
  assert.equal(TEMPLATE_DOWNLOAD_CONCURRENCY, 300)
  const cases = Array.from({ length: 330 }, (_, index) => ({ id: index, title: `Case ${index}`, prompt: 'prompt', image: `case${index}.png` }))
  globalThis.fetch = async url => {
    if (String(url).endsWith('cases.json')) return Response.json({ repository: 'test', cases })
    if (String(url).endsWith('prompts.json')) return Response.json([{id:'test:one', title:'Title', prompt:'Prompt',coverUrl:'https://pbs.twimg.com/one.png',sourceUrl:'https://example.org/credit',sourceId:'test',author:'Author'}])
    downloads++; active++; peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 100))
    active--
    return new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(png.length) } })
  }
  await refreshTemplates('vibeui')
  const results = await Promise.all(Array.from({ length: 8 }, () => readTemplateImage('vibeui', 'case0.png', 'all')))
  assert.equal(downloads, 1, 'same-view requests deduplicate')
  assert.ok(results.every(result => result?.data.equals(png)))
  await readTemplateImage('vibeui', 'case0.png', 'source-vibeui')
  await readTemplateImage('vibeui', 'case0.png', 'favorites')
  await readTemplateImage('vibeui', 'case0.png', 'inspiration')
  await readTemplateImage('vibeui', 'case0.png', 'detail')
  assert.equal(downloads, 5, 'separate views have separate disk and request caches')
  await readTemplateImage('vibeui', 'case0.png', 'all')
  assert.equal(downloads, 5, 'valid disk cache avoids network')
  await fs.writeFile(path.join(root, 'template-images/all/vibeui/case0.png'), png.subarray(0, 20))
  await readTemplateImage('vibeui', 'case0.png', 'all')
  assert.equal(downloads, 6, 'broken disk cache redownloads')
  await Promise.all(cases.slice(1).map(entry => readTemplateImage('vibeui', entry.image, 'all')))
  assert.equal(peak, 300, 'host-wide concurrency reaches but never exceeds 300')
  const customCache = path.join(root, 'cache-on-another-disk')
  setTemplateImageCacheRoot(customCache)
  assert.equal(templateImageCacheRoot(), customCache)
  assert.equal(imageDataRoot(), root, 'cache setting does not change generated image storage')
  await readTemplateImage('vibeui', 'case0.png', 'all')
  assert.deepEqual(await fs.readFile(path.join(customCache, 'all/vibeui/case0.png')), png)
  assert.deepEqual(await fs.readFile(path.join(root, 'template-images/all/vibeui/case0.png')), png, 'old files remain intact')
  const beforeCustomHit = downloads
  await readTemplateImage('vibeui', 'case0.png', 'all')
  assert.equal(downloads, beforeCustomHit, 'configured cache is read without another download')
  setImageDataRoot(path.join(root, 'generated-on-another-disk'))
  assert.equal(templateImageCacheRoot(), customCache, 'explicit cache remains independent of generated storage')
  setTemplateImageCacheRoot('')
  assert.equal(templateImageCacheRoot(), path.join(imageDataRoot(), 'template-images'), 'empty setting follows local image storage')
  setImageDataRoot(root)
  assert.equal(await readTemplateImage('vibeui', 'case0.png', '../escape'), undefined)
  assert.equal(await readTemplateImage('vibeui', 'unknown.png', 'all'), undefined)
  const priorFetch = globalThis.fetch
  const mirrorUrls = []
  globalThis.fetch = async url => {
    mirrorUrls.push(String(url))
    return String(url).includes('cdn.jsdelivr.net') ? new Response('gone', { status: 404 }) : new Response(png)
  }
  const mirrored = registry.cases.find(entry => entry.image.startsWith('https://cdn.jsdelivr.net/gh/'))
  assert.ok(await readTemplateImage('image-prompts', mirrored.image, 'all'))
  assert.equal(mirrorUrls.length, 2)
  assert.ok(mirrorUrls[1].startsWith('https://raw.githubusercontent.com/'), 'unavailable CDN falls back to original GitHub bytes')
  globalThis.fetch = priorFetch
  await refreshTemplates('image-prompts')
  assert.equal((await listTemplates('image-prompts')).cases[0].sourceLabel, 'test · Author')
  await assert.rejects(readLimitedBody(new Response(png), 10), /上限/)
  await assert.rejects(readLimitedBody(new Response(png, { headers:{'content-length':'1'} }), 1000), /不完整/)
  const goodFetch = globalThis.fetch
  let retryCount = 0
  globalThis.fetch = async () => new Response(++retryCount === 1 ? png.subarray(0, 20) : png)
  assert.ok(await readTemplateImage('vibeui', 'case0.png', 'source-canghe'))
  assert.equal(retryCount, 2, 'incomplete upstream bytes are retried before caching')
  retryCount = 0
  globalThis.fetch = async () => ++retryCount === 1 ? new Response('busy', { status: 503 }) : new Response(png)
  assert.ok(await readTemplateImage('vibeui', 'case3.png', 'detail'))
  assert.equal(retryCount, 2, 'temporary HTTP failures are retried')
  retryCount = 0
  globalThis.fetch = async () => { retryCount++; return new Response('gone', { status: 404 }) }
  assert.equal(await readTemplateImage('vibeui', 'case4.png', 'detail'), undefined)
  assert.equal(retryCount, 1, 'permanent HTTP failures are not retried')
  globalThis.fetch = async () => new Response('not an image')
  assert.equal(await readTemplateImage('vibeui', 'case1.png', 'detail'), undefined, 'invalid bytes cannot become a successful cache')
  globalThis.fetch = goodFetch
  const blocked = path.join(root, 'template-images/detail/vibeui/case2.png')
  await fs.mkdir(blocked, { recursive: true })
  assert.equal(await readTemplateImage('vibeui', 'case2.png', 'detail'), undefined, 'disk failure cannot claim cache success')
  assert.equal((await fs.readdir(path.dirname(blocked))).some(file => file.includes('.part-')), false, 'failed writes clean temporary files')
  setImageDataRoot(path.join(root, 'other-root'))
  assert.equal((await listTemplates('vibeui')).origin, 'bundled', 'data-root changes cannot leak list memos')
  globalThis.fetch = realFetch
  await Promise.all([listen(upstream), listen(proxy)])
  setTemplateProxy(`127.0.0.1:${proxy.address().port}`)
  const response = await templateFetch(`http://127.0.0.1:${upstream.address().port}/picture`, { signal: AbortSignal.timeout(5000) })
  assert.equal(await response.text(), 'via configured proxy')
  assert.equal(tunnels, 1, 'request actually crossed local HTTP CONNECT proxy')
  setTemplateProxy('')
  assert.equal(await (await templateFetch(`http://127.0.0.1:${upstream.address().port}/direct`)).text(), 'via configured proxy')
  assert.equal(tunnels, 1, 'empty setting connects directly')
  console.log('TEMPLATE CACHE TEST OK: 1742 entries; title/prompt search; 5 isolated scopes; custom cache path/reset; repair; concurrency=300; HTTP retry; bare-host proxy forwarding')
} finally {
  globalThis.fetch = realFetch
  setTemplateProxy(''); setTemplateImageCacheRoot(undefined); setImageDataRoot(undefined); clearTemplateMemo()
  sockets.forEach(socket => socket.destroy())
  for (const server of [proxy, upstream]) if (server.listening) await new Promise(resolve => server.close(resolve))
  await fs.rm(root, { recursive: true, force: true })
}
