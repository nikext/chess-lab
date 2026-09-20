/**
 * Turning 64 recognised labels into a position chess.js will accept.
 *
 * Pixels give you piece placement and nothing else, so side-to-move, castling
 * rights and en-passant are inferred conservatively and then left for the user
 * to correct in the UI. Castling in particular is a guess: a king and rook on
 * their home squares may well have shuffled back.
 */

import { validateFen } from 'chess.js'
import type { Label } from '../vision/templates'

export type Orientation = 'white' | 'black'

const FILES = 'abcdefgh'

/** Square name for a cell at visual (row, col), given which side is at the bottom. */
export function squareAt(row: number, col: number, orientation: Orientation): string {
  if (orientation === 'white') return `${FILES[col]}${8 - row}`
  return `${FILES[7 - col]}${row + 1}`
}

/** Reorder visually-ordered labels into a8..h1 order (FEN reading order). */
function toFenOrder(labels: Label[], orientation: Orientation): Label[] {
  const out: Label[] = new Array(64).fill('.')
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const sq = squareAt(row, col, orientation)
      const file = FILES.indexOf(sq[0])
      const rank = Number(sq[1])
      out[(8 - rank) * 8 + file] = labels[row * 8 + col]
    }
  }
  return out
}

function placementFrom(fenOrder: Label[]): string {
  const ranks: string[] = []
  for (let r = 0; r < 8; r++) {
    let line = ''
    let gap = 0
    for (let f = 0; f < 8; f++) {
      const label = fenOrder[r * 8 + f]
      if (label === '.') gap++
      else {
        if (gap) { line += gap; gap = 0 }
        line += label
      }
    }
    if (gap) line += gap
    ranks.push(line)
  }
  return ranks.join('/')
}

/** Guess castling rights from home-square occupancy. */
function inferCastling(fenOrder: Label[]): string {
  const at = (sq: string) => {
    const file = FILES.indexOf(sq[0])
    const rank = Number(sq[1])
    return fenOrder[(8 - rank) * 8 + file]
  }
  let rights = ''
  if (at('e1') === 'K') {
    if (at('h1') === 'R') rights += 'K'
    if (at('a1') === 'R') rights += 'Q'
  }
  if (at('e8') === 'k') {
    if (at('h8') === 'r') rights += 'k'
    if (at('a8') === 'r') rights += 'q'
  }
  return rights || '-'
}

export type BuiltFen = {
  fen: string
  placement: string
  castling: string
  valid: boolean
  error?: string
}

export function buildFen(
  labels: Label[],
  orientation: Orientation,
  sideToMove: 'w' | 'b',
  castlingOverride?: string,
): BuiltFen {
  const fenOrder = toFenOrder(labels, orientation)
  const placement = placementFrom(fenOrder)
  const castling = castlingOverride ?? inferCastling(fenOrder)
  const fen = `${placement} ${sideToMove} ${castling} - 0 1`
  const check = validateFen(fen)
  return { fen, placement, castling, valid: check.ok, error: check.ok ? undefined : check.error }
}

const PIECE_VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 }

/**
 * Pixels cannot tell you which way round the board is. Prefer the orientation
 * that yields a legal position; if both are legal, fall back to the assumption
 * that the viewer is looking from their own side, so their material sits low.
 */
export function guessOrientation(labels: Label[], sideToMove: 'w' | 'b' = 'w'): Orientation {
  const white = buildFen(labels, 'white', sideToMove)
  const black = buildFen(labels, 'black', sideToMove)
  if (white.valid !== black.valid) return white.valid ? 'white' : 'black'

  let bottomBias = 0
  labels.forEach((label, i) => {
    if (label === '.') return
    const weight = PIECE_VALUE[label.toLowerCase()] || 0
    const isWhite = label === label.toUpperCase()
    const bottomHalf = Math.floor(i / 8) >= 4
    bottomBias += (isWhite ? 1 : -1) * (bottomHalf ? 1 : -1) * weight
  })
  return bottomBias >= 0 ? 'white' : 'black'
}

/** Sanity checks worth showing even when the FEN technically parses. */
export function positionWarnings(labels: Label[]): string[] {
  const counts: Record<string, number> = {}
  for (const l of labels) if (l !== '.') counts[l] = (counts[l] ?? 0) + 1

  const warnings: string[] = []
  if ((counts.K ?? 0) !== 1) warnings.push(`Found ${counts.K ?? 0} white kings (expected 1).`)
  if ((counts.k ?? 0) !== 1) warnings.push(`Found ${counts.k ?? 0} black kings (expected 1).`)
  if ((counts.P ?? 0) > 8) warnings.push(`Found ${counts.P} white pawns (max 8).`)
  if ((counts.p ?? 0) > 8) warnings.push(`Found ${counts.p} black pawns (max 8).`)
  return warnings
}
