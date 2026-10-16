/** Shared image controls and bounded single-image batches. */
export const IMAGE_RATIOS = ['auto', '1:1', '3:4', '4:3', '9:16', '2:3', '3:2', '16:9', '21:9', '4:5', '5:4', '5:7', '7:5', '9:21', '1:2', '2:1', '1:3', '3:1'] as const
export const IMAGE_SIZES = ['auto', '1024x1024', '1536x1024', '1024x1536', '2048x1536', '1536x2048', '2048x2048', '3072x2048', '2048x3072', '4096x1755', '4096x2304', '2304x4096', '4096x3072', '3072x4096', '4096x4096'] as const
export const IMAGE_QUALITIES = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export const IMAGE_COUNTS = [1, 2, 5, 10, 50, 100] as const

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
