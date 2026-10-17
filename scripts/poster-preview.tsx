/** Browser fixture for verifying the real Canvas renderer and pointer interactions. */
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { PosterEditor } from '../src/client/PosterEditor.tsx'
import type { CanvasAssetRef } from '../src/protocol.ts'
import type { PosterDocument } from '../src/poster.ts'
import type { ImageGenApi } from '../src/client/api.ts'

// This fixture uses the same asset paths and upload wire data as the host.
const source: CanvasAssetRef = { assetId: `${'a'.repeat(64)}.png`, url: `/api/dsh-imagegen/canvas/asset/${'a'.repeat(64)}.png`, mime: 'image/png', bytes: 100, width: 1000, height: 700, origin: 'upload' }
const api = {
  canvasUpload: async (dataUrl: string, width: number, height: number) => {
    const response = await fetch('/upload', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dataUrl, width, height }) })
    if (!response.ok) throw new Error('Upload failed')
    return await response.json() as CanvasAssetRef
  },
} as ImageGenApi
function Fixture() {
  const [open, setOpen] = useState(true)
  const [saved, setSaved] = useState<{ poster: PosterDocument; dataUrl: string } | null>(() => JSON.parse(localStorage.getItem('poster-fixture') ?? 'null'))
  return <><button onClick={() => setOpen(true)}>Reopen</button><output data-saved="">{saved ? JSON.stringify(saved.poster) : ''}</output>{open ? <PosterEditor api={api} asset={source} recipe={saved?.poster} onClose={() => setOpen(false)} onSave={async (poster, dataUrl) => { const next = { poster, dataUrl }; localStorage.setItem('poster-fixture', JSON.stringify(next)); setSaved(next) }} /> : null}</>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
