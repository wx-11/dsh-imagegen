import { ProxyAgent, fetch as proxyFetch } from 'undici'

let proxyUrl = ''
let agent: ProxyAgent | undefined

/** Settings changes apply to future requests; already-running requests may finish. */
export function setTemplateProxy(value: string | undefined): void {
  const next = value?.trim() ?? ''
  if (next === proxyUrl) return
  const previous = agent
  agent = undefined
  proxyUrl = next
  if (previous) void previous.close().catch(() => {})
}

/** Only template lists and reference images use the explicitly configured proxy. */
export async function templateFetch(url: string, options: RequestInit = {}): Promise<Response> {
  if (!proxyUrl) return fetch(url, options)
  const proxy = new URL(proxyUrl)
  if (!['http:', 'https:'].includes(proxy.protocol)) throw new Error('模板代理须使用 http:// 或 https:// 地址')
  agent ??= new ProxyAgent(proxyUrl)
  return await proxyFetch(url, { ...options, dispatcher: agent } as Parameters<typeof proxyFetch>[1]) as unknown as Response
}

/** Bound transfer memory, including responses without Content-Length. */
export async function readLimitedBody(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > maxBytes) { await response.body?.cancel(); throw new Error('图片超过缓存大小上限') }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('图片响应为空')
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw new Error('图片超过缓存大小上限')
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally { reader.releaseLock() }
  if (declared && !response.headers.get('content-encoding') && total !== declared) throw new Error('图片下载不完整')
  return Buffer.concat(chunks, total)
}
