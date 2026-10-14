/** Detect the supported raster format from its encoded bytes. */
export type SupportedImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

export function detectImageMime(data: Uint8Array): SupportedImageMime | undefined {
  const startsWith = (...bytes: number[]): boolean => bytes.every((value, index) => data[index] === value)
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (startsWith(0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (startsWith(0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || startsWith(0x47, 0x49, 0x46, 0x38, 0x39, 0x61)) return 'image/gif'
  if (startsWith(0x52, 0x49, 0x46, 0x46) && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return 'image/webp'
  return undefined
}

/** Check container boundaries before persisting or serving an image. */
export function assertCompleteImage(data: Uint8Array): SupportedImageMime {
  const mime = detectImageMime(data)
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  let complete = false
  if (mime === 'image/png') {
    let offset = 8
    let header = false
    let pixels = false
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset)
      const type = bytes.toString('ascii', offset + 4, offset + 8)
      if (offset + length + 12 > bytes.length) break
      if (offset === 8) header = type === 'IHDR' && length === 13
      if (type === 'IDAT') pixels = true
      offset += length + 12
      if (type === 'IEND') {
        complete = header && pixels && length === 0 && offset === bytes.length
        break
      }
    }
  } else if (mime === 'image/jpeg') {
    complete = bytes.length >= 4 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9
  } else if (mime === 'image/webp') {
    complete = bytes.length >= 20 && bytes.readUInt32LE(4) + 8 === bytes.length
  } else if (mime === 'image/gif') {
    complete = bytes.length >= 14 && bytes[bytes.length - 1] === 0x3b
  }
  if (!complete || mime === undefined) throw new Error('图片数据不完整或格式无法识别')
  return mime
}
