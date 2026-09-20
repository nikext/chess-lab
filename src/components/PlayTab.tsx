import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Chess } from 'chess.js'
import { Chessboard } from 'react-chessboard'
import { Engine, formatEval, winProbability, type EngineLine } from '../lib/stockfish'
import { JevError, rankedMoves, readPosition, type JevRead } from '../lib/jev'
import { numberMoves } from '../lib/pv'
import { JevPanel } from './JevPanel'
import { EvalBar } from './EvalBar'

type Pick = 'best' | 'sampled'

/** Draw from Jev's probability distribution instead of always taking the argmax. */
function sample(probabilities: Record<string, number>): string | null {
  const entries = Object.entries(probabilities ?? {})
  const total = entries.reduce((s, [, p]) => s + p, 0)
  if (!total) return null
  let r = Math.random() * total
  for (const [san, p] of entries) {
    r -= p
    if (r <= 0) return san
  }
  return entries[entries.length - 1][0]
}

export function PlayTab({ engine }: { engine: Engine }) {
  const game = useRef(new Chess())
  const [fen, setFen] = useState(game.current.fen())
  const [history, setHistory] = useState<string[]>([])
  const [myColor, setMyColor] = useState<'w' | 'b'>('w')
  const [pickMode, setPickMode] = useState<Pick>('best')

  const [jev, setJev] = useState<JevRead | null>(null)
  const [jevError, setJevError] = useState('')
  const [thinking, setThinking] = useState(false)
  const [fallback, setFallback] = useState('')

  const [coach, setCoach] = useState(false)
  const [evalLine, setEvalLine] = useState<EngineLine | null>(null)

  const chess = useMemo(() => {
    const c = new Chess()
    try { c.load(fen) } catch { /* fen always comes from chess.js */ }
    return c
  }, [fen])

  const gameOver = chess.isGameOver()
  const myTurn = chess.turn() === myColor

  const sync = () => {
    setFen(game.current.fen())
    setHistory(game.current.history())
  }

  const newGame = (color: 'w' | 'b' = myColor) => {
    game.current = new Chess()
    setMyColor(color)
    setJev(null)
    setJevError('')
    setFallback('')
    setEvalLine(null)
    sync()
  }

  // ------------------------------------------------------------- Jev's turn

  const jevMove = useCallback(async () => {
    if (game.current.isGameOver()) return
    setThinking(true)
    setJevError('')
    setFallback('')
    try {
      const read = await readPosition(game.current, game.current.history())
      setJev(read)

      const wanted = pickMode === 'sampled'
        ? sample(read.move.probabilities) ?? read.move.choice
        : read.move.choice

      // Jev only ever sees legal moves, but never trust a remote answer blindly:
      // fall back down its own ranking if the pick will not play.
      const candidates = [wanted, ...rankedMoves(read.move, 8).map((m) => m.san)]
      let played: string | null = null
      for (const san of candidates) {
        try {
          if (game.current.move(san)) { played = san; break }
        } catch { /* try the next candidate */ }
      }
      if (!played) {
        const legal = game.current.moves()
        played = legal[Math.floor(Math.random() * legal.length)]
        game.current.move(played)
        setFallback('Jev returned no playable move; picked a legal one at random.')
      } else if (played !== read.move.choice) {
        setFallback(`Played ${played} (sampled from Jev's distribution).`)
      }
      sync()
    } catch (err) {
      setJevError(
        err instanceof JevError && err.code === 'no_key'
          ? err.message
          : `Jev: ${String((err as Error)?.message ?? err)}`,
      )
    } finally {
      setThinking(false)
    }
  }, [pickMode])

  useEffect(() => {
    if (!gameOver && !myTurn && !thinking) {
      const t = setTimeout(jevMove, 300)
      return () => clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fen, myTurn, gameOver])

  // -------------------------------------------------------------- the coach

  useEffect(() => {
    if (!coach || gameOver) { setEvalLine(null); return }
    let live = true
    engine
      .analyse(fen, { multipv: 1, movetimeMs: 600 })
      .then((l) => { if (live) setEvalLine(l[0] ?? null) })
      .catch(() => { if (live) setEvalLine(null) })
    return () => { live = false }
  }, [fen, coach, engine, gameOver])

  // ------------------------------------------------------------------ my turn

  const playMove = (from: string, to: string): boolean => {
    if (!myTurn || gameOver || thinking) return false
    try {
      const move = game.current.move({ from, to, promotion: 'q' })
      if (!move) return false
      sync()
      return true
    } catch {
      return false
    }
  }

  const undo = () => {
    // Take back a full move pair so it is my turn again.
    game.current.undo()
    game.current.undo()
    setJev(null)
    sync()
  }

  const result = (() => {
    if (!gameOver) return null
    if (chess.isCheckmate()) return chess.turn() === myColor ? 'Jev wins by checkmate.' : 'You win by checkmate.'
    if (chess.isStalemate()) return 'Draw — stalemate.'
    if (chess.isThreefoldRepetition()) return 'Draw — threefold repetition.'
    if (chess.isInsufficientMaterial()) return 'Draw — insufficient material.'
    return 'Draw.'
  })()

  const numbered = numberMoves(history, 'w', 1)
  const pairs: [string, string | undefined][] = []
  for (let i = 0; i < numbered.length; i += 2) pairs.push([numbered[i], numbered[i + 1]])

  const whiteProb = evalLine ? winProbability(evalLine, chess.turn()) : 0.5

  return (
    <div className="layout">
      <div>
        <div className="panel">
          <div className="board-wrap">
            {coach && <EvalBar whiteProb={whiteProb} />}
            <div className="board-area">
              <Chessboard
                options={{
                  position: fen,
                  boardOrientation: myColor === 'w' ? 'white' : 'black',
                  allowDragging: myTurn && !gameOver && !thinking,
                  onPieceDrop: ({ sourceSquare, targetSquare }) =>
                    targetSquare ? playMove(sourceSquare, targetSquare) : false,
                  darkSquareStyle: { backgroundColor: '#5b6b8c' },
                  lightSquareStyle: { backgroundColor: '#cfd6e4' },
                }}
              />
            </div>
          </div>

          <div className="row tight" style={{ marginTop: 12 }}>
            <button className="primary" onClick={() => newGame(myColor)}>New game</button>
            <button className="ghost" onClick={() => newGame(myColor === 'w' ? 'b' : 'w')}>
              Switch sides
            </button>
            <button className="ghost" onClick={undo} disabled={history.length < 2 || thinking}>
              Take back
            </button>
            <span className="grow" />
            <span className="small muted">
              {result ?? (thinking ? 'Jev is deciding…' : myTurn ? 'Your move' : 'Jev to move')}
            </span>
          </div>

          {result && <div className="notice info" style={{ marginTop: 10 }}>{result}</div>}
          {fallback && <div className="notice info" style={{ marginTop: 10 }}>{fallback}</div>}
        </div>

        <div className="panel">
          <div className="row spread" style={{ marginBottom: 10 }}>
            <h2 style={{ margin: 0 }}>Moves</h2>
            <label className="row tight small muted" style={{ cursor: 'pointer' }}>
              <input
                type="checkbox" checked={coach} style={{ width: 'auto' }}
                onChange={(e) => setCoach(e.target.checked)}
              />
              show Stockfish eval
            </label>
          </div>

          {coach && evalLine && (
            <div className="row tight small" style={{ marginBottom: 8 }}>
              <span className="mono" style={{ fontSize: 15, fontWeight: 650 }}>
                {formatEval(evalLine, chess.turn())}
              </span>
              <span className="muted">after {history[history.length - 1] ?? 'the start'}</span>
            </div>
          )}

          <div className="movelist">
            {pairs.length === 0 && <span className="muted small" style={{ gridColumn: '1 / -1' }}>No moves yet.</span>}
            {pairs.map(([w, b], i) => (
              <Fragment key={i}>
                <span className="num">{i + 1}.</span>
                <span className="ply">{w?.replace(/^\d+\.+\s*/, '')}</span>
                <span className="ply">{b?.replace(/^\d+\.+\s*/, '') ?? ''}</span>
              </Fragment>
            ))}
          </div>
        </div>
      </div>

      <div>
        <div className="panel">
          <h2>Opponent</h2>
          <div className="row tight">
            <span className="small muted" style={{ width: 82 }}>Move choice</span>
            <select
              value={pickMode} onChange={(e) => setPickMode(e.target.value as Pick)} className="grow"
            >
              <option value="best">Always its top pick (strongest)</option>
              <option value="sampled">Sample its distribution (varied, weaker)</option>
            </select>
          </div>
          <div className="small muted" style={{ marginTop: 8 }}>
            Sampling makes Jev play the move in proportion to how much probability
            mass it assigned — more variety across games, and the occasional
            second-best idea, which is closer to how a human plays.
          </div>
        </div>

        <JevPanel read={jev} loading={thinking} error={jevError} />
      </div>
    </div>
  )
}
