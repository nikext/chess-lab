import { useEffect, useMemo, useRef, useState } from 'react'
import { Chess } from 'chess.js'
import { Chessboard } from 'react-chessboard'
import { Engine, formatEval, winProbability, type EngineLine } from '../lib/stockfish'
import { JevError, readPosition, type JevRead } from '../lib/jev'
import { pvToSan, sanToSquares, uciToObject } from '../lib/pv'
import { ImportDialog } from './ImportDialog'
import { JevPanel } from './JevPanel'
import { EvalBar } from './EvalBar'

const START = new Chess().fen()
const ARROW_COLORS = ['#56c271', '#3f8fd4']
const JEV_COLOR = '#e8a33d'

export function AnalyzeTab({ engine }: { engine: Engine }) {
  const [fen, setFen] = useState(START)
  const [fenDraft, setFenDraft] = useState(START)
  const [orientation, setOrientation] = useState<'white' | 'black'>('white')
  const [lines, setLines] = useState<EngineLine[]>([])
  const [depth, setDepth] = useState(0)
  const [thinking, setThinking] = useState(false)
  const [targetDepth, setTargetDepth] = useState(20)
  const [multipv, setMultipv] = useState(2)
  const [engineError, setEngineError] = useState('')

  const [jev, setJev] = useState<JevRead | null>(null)
  const [jevLoading, setJevLoading] = useState(false)
  const [jevError, setJevError] = useState('')
  const [autoJev, setAutoJev] = useState(true)

  const [importing, setImporting] = useState(false)
  const [pgn, setPgn] = useState('')
  const [pgnError, setPgnError] = useState('')

  const runId = useRef(0)

  const chess = useMemo(() => {
    const c = new Chess()
    try { c.load(fen) } catch { /* caller guards validity */ }
    return c
  }, [fen])

  const gameOver = chess.isGameOver()

  // ---------------------------------------------------------------- analysis

  useEffect(() => {
    if (gameOver) { setLines([]); setDepth(0); return }
    const id = ++runId.current
    setThinking(true)
    setEngineError('')
    engine.stop()

    engine
      .analyse(fen, { multipv, depth: targetDepth }, (u) => {
        if (id !== runId.current) return
        setLines(u.lines)
        setDepth(u.depth)
      })
      .then(() => { if (id === runId.current) setThinking(false) })
      .catch((err) => {
        if (id !== runId.current) return
        setEngineError(String(err?.message ?? err))
        setThinking(false)
      })
  }, [fen, multipv, targetDepth, engine, gameOver])

  const askJev = async () => {
    if (gameOver) return
    setJevLoading(true)
    setJevError('')
    try {
      setJev(await readPosition(chess))
    } catch (err) {
      setJev(null)
      setJevError(
        err instanceof JevError && err.code === 'no_key'
          ? err.message
          : `Jev: ${String((err as Error)?.message ?? err)}`,
      )
    } finally {
      setJevLoading(false)
    }
  }

  useEffect(() => {
    if (!autoJev || gameOver) return
    const t = setTimeout(askJev, 250)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fen, autoJev, gameOver])

  // ------------------------------------------------------------------ arrows

  const engineBestSan = lines[0] ? pvToSan(fen, lines[0].pv, 1)[0] ?? null : null

  const arrows = useMemo(() => {
    const out: { startSquare: string; endSquare: string; color: string }[] = []
    lines.slice(0, 2).forEach((line, i) => {
      const uci = line.pv[0]
      if (!uci) return
      out.push({
        startSquare: uci.slice(0, 2),
        endSquare: uci.slice(2, 4),
        color: ARROW_COLORS[i],
      })
    })
    // Only draw Jev's arrow when it disagrees -- otherwise it just hides one.
    if (jev && jev.move.choice !== engineBestSan) {
      const sq = sanToSquares(fen, jev.move.choice)
      if (sq) out.push({ startSquare: sq.from, endSquare: sq.to, color: JEV_COLOR })
    }
    return out
  }, [lines, jev, fen, engineBestSan])

  // ------------------------------------------------------------------ inputs

  const applyFen = (candidate: string) => {
    const test = new Chess()
    try {
      test.load(candidate.trim())
      setFen(test.fen())
      setFenDraft(test.fen())
      setPgnError('')
    } catch (err) {
      setPgnError(`Invalid FEN: ${String((err as Error)?.message ?? err)}`)
    }
  }

  const loadPgn = () => {
    const test = new Chess()
    try {
      test.loadPgn(pgn.trim())
      setFen(test.fen())
      setFenDraft(test.fen())
      setPgnError('')
    } catch (err) {
      setPgnError(`Could not read that PGN: ${String((err as Error)?.message ?? err)}`)
    }
  }

  const playMove = (from: string, to: string): boolean => {
    const next = new Chess(fen)
    try {
      const move = next.move({ from, to, promotion: 'q' })
      if (!move) return false
      setFen(next.fen())
      setFenDraft(next.fen())
      return true
    } catch {
      return false
    }
  }

  const playLineMove = (uci: string) => {
    const m = uciToObject(uci)
    playMove(m.from, m.to)
  }

  const sideToMove = chess.turn()
  const whiteProb = lines[0] ? winProbability(lines[0], sideToMove) : 0.5

  return (
    <>
      <div className="layout">
        <div>
          <div className="panel">
            <div className="board-wrap">
              <EvalBar whiteProb={whiteProb} />
              <div className="board-area">
                <Chessboard
                  options={{
                    position: fen,
                    boardOrientation: orientation,
                    arrows,
                    allowDrawingArrows: true,
                    onPieceDrop: ({ sourceSquare, targetSquare }) =>
                      targetSquare ? playMove(sourceSquare, targetSquare) : false,
                    darkSquareStyle: { backgroundColor: '#5b6b8c' },
                    lightSquareStyle: { backgroundColor: '#cfd6e4' },
                  }}
                />
              </div>
            </div>

            <div className="row tight" style={{ marginTop: 12 }}>
              <button onClick={() => setImporting(true)}>Import screenshot…</button>
              <button className="ghost" onClick={() => applyFen(START)}>Start position</button>
              <button
                className="ghost"
                onClick={() => setOrientation(orientation === 'white' ? 'black' : 'white')}
              >Flip</button>
              <span className="grow" />
              <span className="small muted">
                {gameOver ? 'Game over' : `${sideToMove === 'w' ? 'White' : 'Black'} to move`}
              </span>
            </div>
          </div>

          <div className="panel">
            <h2>Position input</h2>
            <div className="row tight">
              <input
                type="text" className="mono small grow" value={fenDraft}
                onChange={(e) => setFenDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && applyFen(fenDraft)}
                spellCheck={false}
              />
              <button onClick={() => applyFen(fenDraft)}>Load FEN</button>
            </div>
            <textarea
              rows={3} placeholder="…or paste a PGN and jump to its final position"
              value={pgn} onChange={(e) => setPgn(e.target.value)} style={{ marginTop: 8 }}
            />
            <div className="row tight" style={{ marginTop: 8 }}>
              <button onClick={loadPgn} disabled={!pgn.trim()}>Load PGN</button>
              {pgnError && <span className="small" style={{ color: 'var(--danger)' }}>{pgnError}</span>}
            </div>
          </div>
        </div>

        <div>
          <div className="panel">
            <div className="row spread">
              <h2 style={{ margin: 0 }}>Stockfish · search</h2>
              <span className="small muted mono" data-testid="engine-depth">
                depth {depth}{thinking ? ' …' : ''}
              </span>
            </div>

            {engineError && <div className="notice error" style={{ marginTop: 10 }}>{engineError}</div>}

            <div className="lines" style={{ marginTop: 10 }}>
              {lines.length === 0 && !engineError && (
                <div className="notice info">{gameOver ? 'No moves — the game is over.' : 'Starting engine…'}</div>
              )}
              {lines.map((line, i) => {
                const san = pvToSan(fen, line.pv, 8)
                return (
                  <div
                    className="line-row" key={line.multipv}
                    onClick={() => playLineMove(line.pv[0])}
                    style={{ cursor: 'pointer' }}
                    title="Click to play this move"
                  >
                    <span className="swatch" style={{ background: ARROW_COLORS[i] ?? 'var(--line)' }} />
                    <span className="score">{formatEval(line, sideToMove)}</span>
                    <span className="pv"><b>{san[0]}</b> {san.slice(1).join(' ')}</span>
                  </div>
                )
              })}
            </div>

            <div className="row tight" style={{ marginTop: 12 }}>
              <span className="small muted">Depth</span>
              <input
                type="number" min={6} max={30} value={targetDepth}
                onChange={(e) => setTargetDepth(Number(e.target.value))}
                style={{ width: 66 }}
              />
              <span className="small muted">Lines</span>
              <input
                type="number" min={1} max={5} value={multipv}
                onChange={(e) => setMultipv(Number(e.target.value))}
                style={{ width: 60 }}
              />
              <span className="grow" />
              <button className="ghost" onClick={() => engine.stop()} disabled={!thinking}>Stop</button>
            </div>
          </div>

          <JevPanel read={jev} loading={jevLoading} error={jevError} engineBest={engineBestSan} />

          <div className="panel">
            <div className="row tight">
              <button onClick={askJev} disabled={jevLoading || gameOver}>
                {jevLoading ? 'Asking…' : 'Ask Jev again'}
              </button>
              <label className="row tight small muted" style={{ cursor: 'pointer' }}>
                <input
                  type="checkbox" checked={autoJev} style={{ width: 'auto' }}
                  onChange={(e) => setAutoJev(e.target.checked)}
                />
                ask automatically on every position
              </label>
            </div>
          </div>
        </div>
      </div>

      {importing && (
        <ImportDialog
          onClose={() => setImporting(false)}
          onUse={(f) => { applyFen(f); setImporting(false) }}
        />
      )}
    </>
  )
}
