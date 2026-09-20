import { Chess } from 'chess.js'

/** Convert a UCI principal variation into SAN, played out from `fen`. */
export function pvToSan(fen: string, pv: string[], limit = 8): string[] {
  const chess = new Chess()
  try {
    chess.load(fen)
  } catch {
    return []
  }
  const out: string[] = []
  for (const uci of pv.slice(0, limit)) {
    try {
      const move = chess.move(uciToObject(uci))
      if (!move) break
      out.push(move.san)
    } catch {
      break
    }
  }
  return out
}

export function uciToObject(uci: string) {
  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci.length > 4 ? uci[4] : undefined,
  }
}

/** Resolve a SAN move to its from/to squares, for drawing an arrow. */
export function sanToSquares(fen: string, san: string): { from: string; to: string } | null {
  const chess = new Chess()
  try {
    chess.load(fen)
    const move = chess.move(san)
    return move ? { from: move.from, to: move.to } : null
  } catch {
    return null
  }
}

/** Pair each SAN move with a move number, e.g. ['1. e4', '1... e5', '2. Nf3']. */
export function numberMoves(sans: string[], startTurn: 'w' | 'b', startNumber: number): string[] {
  let n = startNumber
  let turn = startTurn
  return sans.map((san) => {
    const label = turn === 'w' ? `${n}. ${san}` : `${n}... ${san}`
    if (turn === 'b') n++
    turn = turn === 'w' ? 'b' : 'w'
    return label
  })
}
