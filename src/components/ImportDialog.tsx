import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  allCellFeatures, cellThumbnail, detectBoard, imageDataFrom, refineBoard, type Rect,
} from '../vision/board'
import {
  calibrate, deleteTheme, listThemes, loadTheme, saveTheme, TemplateBank, type Label,
} from '../vision/templates'
import { buildFen, guessOrientation, positionWarnings, squareAt, type Orientation } from '../lib/fen'

const LABELS: Label[] = ['.', 'P', 'N', 'B', 'R', 'Q', 'K', 'p', 'n', 'b', 'r', 'q', 'k']
const GLYPH: Record<Label, string> = {
  '.': '·', P: '♙', N: '♘', B: '♗', R: '♖', Q: '♕', K: '♔',
  p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚',
}
/** Below this nearest-neighbour margin, flag the cell for a human look. */
const UNSURE_MARGIN = 0.22
const DETECT_MAX_DIM = 700

type Props = { onUse: (fen: string) => void; onClose: () => void }

export function ImportDialog({ onUse, onClose }: Props) {
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const [dataUrl, setDataUrl] = useState<string>('')
  const [rect, setRect] = useState<Rect | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [hot, setHot] = useState(false)

  const [themes, setThemes] = useState<string[]>(() => listThemes())
  const [themeName, setThemeName] = useState<string>(() => listThemes()[0] ?? '')
  const [bank, setBank] = useState<TemplateBank | null>(null)
  const [newThemeName, setNewThemeName] = useState('')

  const [labels, setLabels] = useState<Label[] | null>(null)
  const [margins, setMargins] = useState<number[]>([])
  const [orientation, setOrientation] = useState<Orientation>('white')
  const [sideToMove, setSideToMove] = useState<'w' | 'b'>('w')
  const [selected, setSelected] = useState<number | null>(null)
  const [error, setError] = useState<string>('')

  const imgRef = useRef<HTMLImageElement | null>(null)
  const dragStart = useRef<{ x: number; y: number } | null>(null)
  const fullData = useRef<ImageData | null>(null)

  useEffect(() => {
    if (themeName) setBank(loadTheme(themeName))
  }, [themeName])

  // ---------------------------------------------------------------- loading

  const loadFile = useCallback((file: File) => {
    setError('')
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        setImage(img)
        setDataUrl(String(reader.result))
        setLabels(null)
        setSelected(null)
        fullData.current = imageDataFrom(img, img.naturalWidth, img.naturalHeight)
        runDetect(img)
      }
      img.onerror = () => setError('That file could not be decoded as an image.')
      img.src = String(reader.result)
    }
    reader.readAsDataURL(file)
  }, [])

  const runDetect = (img: HTMLImageElement) => {
    setDetecting(true)
    // Defer so the spinner paints before the synchronous sweep blocks the thread.
    setTimeout(() => {
      try {
        const scale = Math.min(1, DETECT_MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight))
        const w = Math.round(img.naturalWidth * scale)
        const h = Math.round(img.naturalHeight * scale)
        const small = imageDataFrom(img, w, h)
        const found = detectBoard(small)
        if (found) {
          const upscaled: Rect = {
            x: Math.round(found.rect.x / scale),
            y: Math.round(found.rect.y / scale),
            size: Math.round(found.rect.size / scale),
          }
          // Each pixel of error at detection scale becomes 1/scale pixels here,
          // so sharpen against the original before reading any squares.
          const full = fullData.current
          setRect(full && scale < 1 ? refineBoard(full, upscaled, 0.25).rect : upscaled)
        } else {
          setRect(null)
          setError('No board found automatically. Drag a square over the board instead.')
        }
      } catch (err: any) {
        setError(String(err?.message ?? err))
      } finally {
        setDetecting(false)
      }
    }, 20)
  }

  // Paste straight from the clipboard -- the usual way a screenshot arrives.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const file = [...(e.clipboardData?.items ?? [])]
        .find((i) => i.type.startsWith('image/'))?.getAsFile()
      if (file) loadFile(file)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [loadFile])

  // ------------------------------------------------------------ crop by drag

  const displayScale = () => {
    const el = imgRef.current
    if (!el || !image) return 1
    return el.clientWidth / image.naturalWidth
  }

  const onMouseDown = (e: React.MouseEvent) => {
    if (!image) return
    const box = imgRef.current!.getBoundingClientRect()
    const s = displayScale()
    dragStart.current = { x: (e.clientX - box.left) / s, y: (e.clientY - box.top) / s }
  }

  const onMouseMove = (e: React.MouseEvent) => {
    if (!dragStart.current || !image) return
    const box = imgRef.current!.getBoundingClientRect()
    const s = displayScale()
    const x = (e.clientX - box.left) / s
    const y = (e.clientY - box.top) / s
    // Keep it square -- a chessboard always is.
    const size = Math.max(Math.abs(x - dragStart.current.x), Math.abs(y - dragStart.current.y))
    if (size < 24) return
    setRect({
      x: Math.round(Math.min(dragStart.current.x, x)),
      y: Math.round(Math.min(dragStart.current.y, y)),
      size: Math.round(size),
    })
    setLabels(null)
  }

  const endDrag = () => { dragStart.current = null }

  const nudge = (dx: number, dy: number, ds: number) => {
    setRect((r) => (r ? { x: r.x + dx, y: r.y + dy, size: Math.max(32, r.size + ds) } : r))
    setLabels(null)
  }

  // -------------------------------------------------------------- recognition

  const cells = useMemo(() => {
    if (!image || !rect) return []
    return Array.from({ length: 64 }, (_, i) =>
      cellThumbnail(image, rect, Math.floor(i / 8), i % 8))
  }, [image, rect])

  const doCalibrate = () => {
    if (!fullData.current || !rect) return
    const name = newThemeName.trim()
    if (!name) return setError('Give the theme a name first, e.g. "lichess brown".')

    const created = calibrate(name, fullData.current, rect, orientation === 'black')
    const result = saveTheme(created)
    if (!result.ok) return setError(result.error)

    setThemes(listThemes())
    setThemeName(name)
    setBank(created)
    setNewThemeName('')
    setError('')
  }

  const doRecognise = () => {
    if (!fullData.current || !rect) return
    if (!bank) return setError('Pick a theme, or calibrate one from a starting-position screenshot.')

    const feats = allCellFeatures(fullData.current, rect)
    const results = bank.classifyBoard(feats)
    const found = results.map((r) => r.label)
    setLabels(found)
    setMargins(results.map((r) => r.margin))
    setOrientation(guessOrientation(found, sideToMove))
    setError('')
  }

  const correct = (index: number, label: Label) => {
    if (!labels) return
    const next = [...labels]
    next[index] = label
    setLabels(next)
    setMargins((m) => m.map((v, i) => (i === index ? 1 : v)))
    setSelected(null)

    // Fold the correction back into the bank so this theme improves with use.
    if (bank && fullData.current && rect) {
      const feats = allCellFeatures(fullData.current, rect)
      bank.add(label, feats[index])
      saveTheme(bank)
    }
  }

  const built = labels ? buildFen(labels, orientation, sideToMove) : null
  const warnings = labels ? positionWarnings(labels) : []
  const unsureCount = margins.filter((m) => m < UNSURE_MARGIN).length

  const step = !image ? 0 : !labels ? 1 : 2

  return (
    <div className="backdrop" onMouseUp={endDrag}>
      <div className="modal">
        <div className="row spread" style={{ marginBottom: 12 }}>
          <h2>Import a position from a screenshot</h2>
          <button className="ghost" onClick={onClose}>Close</button>
        </div>

        <div className="steps">
          <span className={`step ${step === 0 ? 'active' : 'done'}`}>1 · Image</span>
          <span className={`step ${step === 1 ? 'active' : step > 1 ? 'done' : ''}`}>2 · Frame &amp; theme</span>
          <span className={`step ${step === 2 ? 'active' : ''}`}>3 · Check &amp; use</span>
        </div>

        {error && <div className="notice error" style={{ marginBottom: 12 }}>{error}</div>}

        {!image && (
          <div
            className={`dropzone ${hot ? 'hot' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setHot(true) }}
            onDragLeave={() => setHot(false)}
            onDrop={(e) => {
              e.preventDefault(); setHot(false)
              const f = e.dataTransfer.files[0]
              if (f) loadFile(f)
            }}
            onClick={() => document.getElementById('file-input')?.click()}
          >
            <div style={{ fontSize: 15, marginBottom: 6 }}>Drop a screenshot, paste with Ctrl+V, or click to browse</div>
            <div className="small">A board from a book, a video, a stream, or your own finished game.</div>
            <input
              id="file-input" type="file" accept="image/*" hidden
              onChange={(e) => { const f = e.target.files?.[0]; if (f) loadFile(f) }}
            />
          </div>
        )}

        {image && (
          <div className="layout" style={{ gridTemplateColumns: '1fr 340px' }}>
            <div>
              <div
                className="preview"
                onMouseDown={onMouseDown}
                onMouseMove={onMouseMove}
                style={{ cursor: 'crosshair', userSelect: 'none' }}
              >
                <img ref={imgRef} src={dataUrl} alt="Imported screenshot" draggable={false} />
                {rect && imgRef.current && (
                  <div
                    className="cropbox"
                    style={{
                      left: rect.x * displayScale(),
                      top: rect.y * displayScale(),
                      width: rect.size * displayScale(),
                      height: rect.size * displayScale(),
                    }}
                  >
                    {[1, 2, 3, 4, 5, 6, 7].map((i) => (
                      <span key={`v${i}`} className="g" style={{ left: `${(i / 8) * 100}%`, top: 0, bottom: 0, width: 1 }} />
                    ))}
                    {[1, 2, 3, 4, 5, 6, 7].map((i) => (
                      <span key={`h${i}`} className="g" style={{ top: `${(i / 8) * 100}%`, left: 0, right: 0, height: 1 }} />
                    ))}
                  </div>
                )}
              </div>

              <div className="row tight" style={{ marginTop: 10 }}>
                <button onClick={() => runDetect(image)} disabled={detecting}>
                  {detecting ? 'Detecting…' : 'Auto-detect board'}
                </button>
                <span className="muted small">or drag a square over it</span>
                <span className="grow" />
                <button className="ghost" onClick={() => nudge(-1, 0, 0)} title="Move left">←</button>
                <button className="ghost" onClick={() => nudge(1, 0, 0)} title="Move right">→</button>
                <button className="ghost" onClick={() => nudge(0, -1, 0)} title="Move up">↑</button>
                <button className="ghost" onClick={() => nudge(0, 1, 0)} title="Move down">↓</button>
                <button className="ghost" onClick={() => nudge(0, 0, -2)} title="Shrink">−</button>
                <button className="ghost" onClick={() => nudge(0, 0, 2)} title="Grow">+</button>
              </div>
              <div className="row" style={{ marginTop: 8 }}>
                <button className="ghost small" onClick={() => { setImage(null); setLabels(null); setRect(null) }}>
                  Use a different image
                </button>
              </div>
            </div>

            <div className="stack">
              <div className="panel">
                <h2>Piece theme</h2>
                {themes.length > 0 ? (
                  <div className="row tight">
                    <select value={themeName} onChange={(e) => setThemeName(e.target.value)} className="grow">
                      {themes.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                    <button
                      className="ghost danger"
                      onClick={() => {
                        deleteTheme(themeName)
                        const rest = listThemes()
                        setThemes(rest)
                        setThemeName(rest[0] ?? '')
                        setBank(rest[0] ? loadTheme(rest[0]) : null)
                      }}
                    >Delete</button>
                  </div>
                ) : (
                  <div className="notice info">
                    No themes yet. Import one screenshot of the <b>starting position</b> from the
                    site you use, frame the board above, then calibrate. That one step teaches the
                    app every piece in that set.
                  </div>
                )}

                <div className="row tight" style={{ marginTop: 10 }}>
                  <input
                    type="text" placeholder="New theme name" value={newThemeName}
                    onChange={(e) => setNewThemeName(e.target.value)} className="grow"
                  />
                  <button onClick={doCalibrate} disabled={!rect}>Calibrate</button>
                </div>
                <div className="small muted" style={{ marginTop: 6 }}>
                  Calibrating reads the framed board <i>as the starting position</i>. Set the
                  orientation below first if that screenshot is from Black's side.
                </div>
                {bank && (
                  <div className="small muted" style={{ marginTop: 8 }}>
                    <b className="mono">{bank.name}</b> · {bank.size} exemplars ·{' '}
                    {bank.isComplete
                      ? <span className="pill good">all pieces covered</span>
                      : <span className="pill warn">incomplete</span>}
                  </div>
                )}
              </div>

              <div className="panel">
                <h2>Position</h2>
                <div className="row tight">
                  <span className="small muted" style={{ width: 88 }}>Bottom side</span>
                  <select
                    value={orientation}
                    onChange={(e) => setOrientation(e.target.value as Orientation)}
                    className="grow"
                  >
                    <option value="white">White at bottom</option>
                    <option value="black">Black at bottom</option>
                  </select>
                </div>
                <div className="row tight" style={{ marginTop: 8 }}>
                  <span className="small muted" style={{ width: 88 }}>To move</span>
                  <select
                    value={sideToMove}
                    onChange={(e) => setSideToMove(e.target.value as 'w' | 'b')}
                    className="grow"
                  >
                    <option value="w">White</option>
                    <option value="b">Black</option>
                  </select>
                </div>
                <button
                  className="primary" style={{ marginTop: 12, width: '100%' }}
                  onClick={doRecognise} disabled={!rect || !bank}
                >Read the board</button>
              </div>
            </div>
          </div>
        )}

        {labels && (
          <div className="panel" style={{ marginTop: 14 }}>
            <div className="row spread">
              <h2 style={{ margin: 0 }}>Check the reading</h2>
              <span className="small muted">
                {unsureCount > 0
                  ? <><span className="pill warn">{unsureCount} uncertain</span> — outlined below</>
                  : <span className="pill good">all squares confident</span>}
              </span>
            </div>

            <div className="row" style={{ alignItems: 'flex-start', gap: 18, marginTop: 10 }}>
              <div className="grid8">
                {cells.map((src, i) => (
                  <div
                    key={i}
                    className={`cell ${margins[i] < UNSURE_MARGIN ? 'unsure' : ''} ${selected === i ? 'selected' : ''}`}
                    onClick={() => setSelected(selected === i ? null : i)}
                    title={`${squareAt(Math.floor(i / 8), i % 8, orientation)} — click to correct`}
                  >
                    <img src={src} alt="" />
                    <span className="tag">{GLYPH[labels[i]]}</span>
                  </div>
                ))}
              </div>

              <div className="stack grow" style={{ minWidth: 240 }}>
                {selected !== null ? (
                  <div>
                    <div className="small muted" style={{ marginBottom: 6 }}>
                      Square <b className="mono">{squareAt(Math.floor(selected / 8), selected % 8, orientation)}</b> —
                      pick what is actually there:
                    </div>
                    <div className="palette">
                      {LABELS.map((l) => (
                        <button key={l} onClick={() => correct(selected, l)} title={l === '.' ? 'empty' : l}>
                          {GLYPH[l]}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="small muted">Click any square to correct it. Corrections are saved into the theme, so the same mistake will not repeat.</div>
                )}

                {warnings.map((w, i) => <div key={i} className="notice error small">{w}</div>)}
                {built && !built.valid && (
                  <div className="notice error small">Not a legal position: {built.error}</div>
                )}

                <div>
                  <div className="small muted" style={{ marginBottom: 4 }}>FEN</div>
                  <input type="text" className="mono small" readOnly value={built?.fen ?? ''} onFocus={(e) => e.target.select()} />
                </div>

                <div className="row tight">
                  <button
                    className="primary grow"
                    disabled={!built?.valid}
                    onClick={() => built && onUse(built.fen)}
                  >Use this position</button>
                  <button className="ghost" onClick={() => setOrientation(orientation === 'white' ? 'black' : 'white')}>
                    Flip
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
