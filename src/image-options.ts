/** Shared image controls and bounded single-image batches. */
export const IMAGE_RATIOS = ['auto', '1:1', '3:4', '4:3', '9:16', '2:3', '3:2', '16:9', '21:9', '4:5', '5:4', '5:7', '7:5', '9:21', '1:2', '2:1', '1:3', '3:1'] as const
/** Yeahzi-compatible pixel presets. Every dimension is divisible by 16. */
export const IMAGE_SIZES = [
  'auto',
  '1024x1024', '1280x960', '1536x864', '960x1280', '864x1536',
  '2048x2048', '2048x1536', '2048x1152', '1536x2048', '1152x2048',
  '2560x1440', '1440x2560',
  '4096x4096', '4096x3072', '3840x2160', '3072x4096', '2160x3840',
] as const
export const IMAGE_QUALITIES = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export const IMAGE_COUNTS = [1, 2, 5, 10, 50, 100] as const

export type ImageSize = typeof IMAGE_SIZES[number]

export function imageSizeTier(size: string): 'auto' | '1K' | '2K' | '4K' {
  if (size === 'auto') return 'auto'
  const match = /^(\d+)x(\d+)$/.exec(size)
  if (match === null) return 'auto'
  const longEdge = Math.max(Number(match[1]), Number(match[2]))
  return longEdge >= 3840 ? '4K' : longEdge >= 2048 ? '2K' : '1K'
}

export function imageSizeNeedsUpscale(size: string): boolean {
  return imageSizeTier(size) === '4K'
}

export function normalizeImageCount(value: number): number {
  return Number.isFinite(value) ? Math.min(100, Math.max(1, Math.round(value))) : 1
}

/** Preserve result order while limiting in-flight upstream requests to four. */
export async function imageBatches<T>(count: number, generate: () => Promise<T>): Promise<T[]> {
  const results: T[] = []
  for (let start = 0; start < count; start += 4) {
    results.push(...await Promise.all(Array.from({ length: Math.min(4, count - start) }, generate)))
  }
  return results
}
