import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Eraser, Pencil, Redo2, Undo2, X } from 'lucide-react'
import type { ImageModelGroup } from './settings-scope.ts'
import { ModelPicker, resolveModelChoice } from './ModelPicker.tsx'
import { tt } from './helpers.ts'
import css from './image-edit.module.css'

type MaskStroke = { mode: 'paint' | 'restore'; width: number; points: Array<{ x: number; y: number }> }

export interface ImageEditSubmission {
  model: string
  channelId: string
  prompt: string
  size: string
  quality: string
  mask: string
}

export function ImageEditOverlay(props: {
  imageUrl: string
  imageWidth: number
  imageHeight: number
  modelGroups: ImageModelGroup[]
  defaultChannelId?: string
  connected: boolean
  connectedChannelIds?: ReadonlySet<string>
  initialModel?: string
  initialChannelId?: string
  onClose: () => void
  onSubmit: (submission: ImageEditSubmission) => Promise<void>
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const liveRef = useRef<MaskStroke | null>(null)
  const strokesRef = useRef<MaskStroke[]>([])
  const [strokes, setStrokes] = useState<MaskStroke[]>([])
  const [redo, setRedo] = useState<MaskStroke[]>([])
  const [tool, setTool] = useState<'paint' | 'restore'>('paint')
  const [brushSize, setBrushSize] = useState(28)
  const [prompt, setPrompt] = useState('')
  const [size, setSize] = useState('auto')
  const [quality, setQuality] = useState('auto')
  const [choice, setChoice] = useState(() => resolveModelChoice(props.modelGroups, {
    channelId: props.initialChannelId,
    model: props.initialModel,
  }, props.defaultChannelId))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    canvas.width = props.imageWidth
    canvas.height = props.imageHeight
    redrawPreview()
  }, [props.imageWidth, props.imageHeight])

  const drawStroke = (ctx: CanvasRenderingContext2D, stroke: MaskStroke): void => {
    if (stroke.points.length === 0) return
    ctx.save()
    ctx.globalCompositeOperation = 'source-over'
    ctx.strokeStyle = stroke.mode === 'paint' ? 'rgba(239, 68, 68, .48)' : 'rgba(255,255,255,.75)'
    ctx.fillStyle = ctx.strokeStyle
    ctx.lineWidth = stroke.width
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const first = stroke.points[0]!
    ctx.beginPath()
    ctx.moveTo(first.x, first.y)
    if (stroke.points.length === 1) {
      ctx.arc(first.x, first.y, stroke.width / 2, 0, Math.PI * 2)
      ctx.fill()
    } else {
      for (const point of stroke.points.slice(1)) ctx.lineTo(point.x, point.y)
      ctx.stroke()
    }
    ctx.restore()
  }

  const redrawPreview = (): void => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (canvas === null || canvas === undefined || ctx === null || ctx === undefined) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    for (const stroke of strokesRef.current) drawStroke(ctx, stroke)
  }

  const pointerPoint = (event: ReactPointerEvent<HTMLCanvasElement>): { x: number; y: number; ratio: number } | null => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return null
    const x = (event.clientX - rect.left) * props.imageWidth / rect.width
    const y = (event.clientY - rect.top) * props.imageHeight / rect.height
    return { x, y, ratio: props.imageWidth / rect.width }
  }

  const pointerDown = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const point = pointerPoint(event)
    if (point === null) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const stroke: MaskStroke = { mode: tool, width: brushSize * point.ratio, points: [{ x: point.x, y: point.y }] }
    liveRef.current = stroke
    const ctx = event.currentTarget.getContext('2d')
    if (ctx !== null) drawStroke(ctx, stroke)
  }

  const pointerMove = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const stroke = liveRef.current
    if (stroke === null) return
    const point = pointerPoint(event)
    if (point === null) return
    const previous = stroke.points[stroke.points.length - 1]!
    if (Math.hypot(point.x - previous.x, point.y - previous.y) < point.ratio * 1.2) return
    stroke.points.push({ x: point.x, y: point.y })
    const ctx = event.currentTarget.getContext('2d')
    if (ctx !== null) {
      ctx.save()
      ctx.globalCompositeOperation = 'source-over'
      ctx.strokeStyle = stroke.mode === 'paint' ? 'rgba(239, 68, 68, .48)' : 'rgba(255,255,255,.75)'
      ctx.lineWidth = stroke.width
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.beginPath()
      ctx.moveTo(previous.x, previous.y)
      ctx.lineTo(point.x, point.y)
      ctx.stroke()
      ctx.restore()
    }
  }

  const pointerUp = (): void => {
    const stroke = liveRef.current
    if (stroke === null) return
    liveRef.current = null
    const next = [...strokesRef.current, stroke]
    strokesRef.current = next
    setStrokes(next)
    setRedo([])
  }

  const undo = (): void => {
    const last = strokesRef.current.at(-1)
    if (last === undefined) return
    const next = strokesRef.current.slice(0, -1)
    strokesRef.current = next
    setStrokes(next)
    setRedo(previous => [...previous, last])
  }

  const redoStroke = (): void => {
    const last = redo.at(-1)
    if (last === undefined) return
    const next = [...strokesRef.current, last]
    strokesRef.current = next
    setStrokes(next)
    setRedo(previous => previous.slice(0, -1))
  }

  useEffect(() => { redrawPreview() }, [strokes])

  const submit = async (): Promise<void> => {
    if (prompt.trim() === '') { setError(tt('canvas.editNeedPrompt')); return }
    if (strokes.length === 0) { setError(tt('canvas.editNeedMask')); return }
    if (choice.model === '') { setError(tt('canvas.needModel')); return }
    const maskCanvas = document.createElement('canvas')
    maskCanvas.width = props.imageWidth
    maskCanvas.height = props.imageHeight
    const ctx = maskCanvas.getContext('2d')
    if (ctx === null) { setError(tt('canvas.editMaskFailed')); return }
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, maskCanvas.width, maskCanvas.height)
    for (const stroke of strokes) {
      ctx.save()
      ctx.globalCompositeOperation = stroke.mode === 'paint' ? 'destination-out' : 'source-over'
      ctx.strokeStyle = '#000'
      ctx.fillStyle = '#000'
      ctx.lineWidth = stroke.width
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      const [first, ...rest] = stroke.points
      if (first !== undefined) {
        ctx.beginPath()
        ctx.moveTo(first.x, first.y)
        if (rest.length === 0) {
          ctx.arc(first.x, first.y, stroke.width / 2, 0, Math.PI * 2)
          ctx.fill()
        } else {
          for (const point of rest) ctx.lineTo(point.x, point.y)
          ctx.stroke()
        }
      }
      ctx.restore()
    }
    setBusy(true)
    setError('')
    try {
      await props.onSubmit({
        model: choice.model,
        channelId: choice.channelId,
        prompt: prompt.trim(),
        size,
        quality,
        mask: maskCanvas.toDataURL('image/png'),
      })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally { setBusy(false) }
  }

  const connected = props.connectedChannelIds?.has(choice.channelId) ?? props.connected
  return <div className={css.backdrop} role="dialog" aria-modal="true" aria-label={tt('canvas.editTitle')} onPointerDown={event => { if (event.target === event.currentTarget) props.onClose() }}>
    <section className={css.editor}>
      <header className={css.header}>
        <div><strong>{tt('canvas.editTitle')}</strong><span>{props.imageWidth} × {props.imageHeight}</span></div>
        <button type="button" aria-label={tt('canvas.close')} onClick={props.onClose}><X size={17} /></button>
      </header>
      <div className={css.body}>
        <div className={css.workarea}>
          <div className={css.stage} style={{ aspectRatio: `${props.imageWidth} / ${props.imageHeight}` }}>
            <img src={props.imageUrl} alt="" draggable={false} />
            <canvas ref={canvasRef} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} />
          </div>
        </div>
        <aside className={css.controls}>
          <div className={css.tools}>
            <button type="button" data-active={tool === 'paint' ? '' : undefined} title={tt('canvas.editBrush')} onClick={() => setTool('paint')}><Pencil size={16} /></button>
            <button type="button" data-active={tool === 'restore' ? '' : undefined} title={tt('canvas.editRestore')} onClick={() => setTool('restore')}><Eraser size={16} /></button>
            <span />
            <button type="button" title={tt('canvas.undo')} disabled={strokes.length === 0} onClick={undo}><Undo2 size={16} /></button>
            <button type="button" title={tt('canvas.redo')} disabled={redo.length === 0} onClick={redoStroke}><Redo2 size={16} /></button>
          </div>
          <label>{tt('canvas.editBrushSize')}<input type="range" min="4" max="120" value={brushSize} onChange={event => setBrushSize(Number(event.target.value))} /></label>
          <textarea value={prompt} onChange={event => setPrompt(event.target.value)} placeholder={tt('canvas.editPromptPlaceholder')} />
          <ModelPicker groups={props.modelGroups} value={choice} channelLabel={tt('model.channel')} modelLabel={tt('model.label')} channelPlaceholder={tt('model.channelPlaceholder')} emptyLabel={tt('canvas.modelPlaceholder')} ariaLabel={tt('canvas.model')} onChange={setChoice} />
          <label>{tt('canvas.size')}<select value={size} onChange={event => setSize(event.target.value)}>{['auto', '1024x1024', '1536x1024', '1024x1536', '1:1', '3:4', '4:3', '9:16', '2:3', '3:2', '16:9', '21:9', '4:5', '5:4', '5:7', '7:5', '9:21', '1:2', '2:1', '1:3', '3:1'].map(value => <option key={value} value={value}>{value === 'auto' ? tt('canvas.sizeAuto') : value}</option>)}</select></label>
          <label>{tt('canvas.editQuality')}<select value={quality} onChange={event => setQuality(event.target.value)}>{['auto', 'low', 'medium', 'high', 'xhigh', 'max'].map(value => <option key={value} value={value}>{value === 'auto' ? tt('canvas.qualityAuto') : value}</option>)}</select></label>
          <div className={css.hint}>{tt('canvas.editHint')}</div>
          <button className={css.submit} type="button" disabled={busy || !connected} onClick={() => { void submit() }}>{busy ? tt('canvas.generatingNode') : tt('canvas.editSubmit')}</button>
          {!connected ? <small>{tt('canvas.needApi')}</small> : null}
          {error !== '' ? <small role="alert">{error}</small> : null}
        </aside>
      </div>
    </section>
  </div>
}
