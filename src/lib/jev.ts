/**
 * Client for TypeSafe AI's Jev (System One) model.
 *
 * Jev is not an engine: it does no search. It returns a typed, calibrated
 * decision in a single forward pass. So we use it as a *policy* -- "what does
 * intuition say here?" -- and let Stockfish handle actual move strength.
 *
 * Every question below goes in ONE request. TypeSafe's own docs note batching
 * is ~12x cheaper and ~10x faster than asking serially, and questions are
 * evaluated in parallel and in isolation.
 */

import { Chess, type Move } from 'chess.js'

export type ChoiceAnswer = {
  type: 'choice'
  choice: string
  probabilities: Record<string, number>
  confidence: number
}
export type ScoreAnswer = {
  type: 'score'
  score: number
  probabilities: Record<string, number>
  confidence: number
}
export type NoulAnswer = { type: 'noul'; noul: number }
export type JevAnswer = ChoiceAnswer | ScoreAnswer | NoulAnswer

export type JevResponse = {
  model: string
  answers: Record<string, JevAnswer>
  usage?: { input_tokens: number; output_tokens: number }
  _latencyMs?: number
}

export class JevError extends Error {
  readonly code: string
  readonly status?: number
  constructor(message: string, code: string, status?: number) {
    super(message)
    this.code = code
    this.status = status
  }
}

async function askJev(state: string, questions: Record<string, unknown>): Promise<JevResponse> {
  const res = await fetch('/api/jev', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, questions }),
  })

  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new JevError(
      body.message || body.body || `Jev request failed (${res.status})`,
      body.error || 'unknown',
      res.status,
    )
  }
  return body as JevResponse
}

/** Ordered rubric for the positional score question. Index -> label. */
export const EVAL_LEVELS = [
  'Black is completely winning; White has no practical defence',
  'Black is clearly better and should convert with accurate play',
  'Black is slightly better',
  'Balanced; neither side has a meaningful advantage',
  'White is slightly better',
  'White is clearly better and should convert with accurate play',
  'White is completely winning; Black has no practical defence',
]

/** Describe one legal move in words, so Jev has more than coordinates to work with. */
function describeMove(m: Move): string {
  const names: Record<string, string> = {
    p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king',
  }
  const parts = [`${names[m.piece]} ${m.from}->${m.to}`]
  if (m.captured) parts.push(`captures ${names[m.captured]}`)
  if (m.promotion) parts.push(`promotes to ${names[m.promotion]}`)
  if (m.san === 'O-O') parts.push('castles kingside')
  if (m.san === 'O-O-O') parts.push('castles queenside')
  if (m.san.includes('#')) parts.push('checkmate')
  else if (m.san.includes('+')) parts.push('gives check')
  return parts.join(', ')
}

/** Serialise the position into the unstructured "program state" Jev expects. */
export function positionState(chess: Chess, history: string[] = []): string {
  const board = chess.board()
  const ascii = board
    .map((row, i) =>
      `${8 - i} | ` +
      row.map((sq) => (sq ? (sq.color === 'w' ? sq.type.toUpperCase() : sq.type) : '.')).join(' '),
    )
    .join('\n')

  const values: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 }
  let material = 0
  for (const row of board) {
    for (const sq of row) {
      if (sq) material += (sq.color === 'w' ? 1 : -1) * values[sq.type]
    }
  }

  return [
    'Chess position.',
    `FEN: ${chess.fen()}`,
    '',
    'Board (uppercase = White, lowercase = Black, rank 8 at top):',
    ascii,
    '    +----------------',
    '      a b c d e f g h',
    '',
    `Side to move: ${chess.turn() === 'w' ? 'White' : 'Black'}`,
    `Move number: ${chess.moveNumber()}`,
    `In check: ${chess.inCheck() ? 'yes' : 'no'}`,
    `Material balance (pawns, + favours White): ${material > 0 ? '+' : ''}${material}`,
    history.length ? `Recent moves: ${history.slice(-12).join(' ')}` : 'Recent moves: (none given)',
  ].join('\n')
}

export type JevRead = {
  /** Jev's chosen move in SAN, plus its probability mass over all legal moves. */
  move: ChoiceAnswer
  evaluation: ScoreAnswer
  danger: NoulAnswer
  latencyMs?: number
  usage?: JevResponse['usage']
  model: string
}

/**
 * Ask Jev for its intuitive read on a position: best move, positional
 * assessment, and whether the side to move is in tactical trouble.
 */
export async function readPosition(chess: Chess, history: string[] = []): Promise<JevRead> {
  const legal = chess.moves({ verbose: true }) as Move[]
  if (!legal.length) throw new JevError('No legal moves in this position.', 'no_moves')

  // `choice` accepts up to 255 options; the theoretical max legal move count
  // is 218, so this only ever trims pathological inputs.
  const criteria: Record<string, string> = {}
  for (const m of legal.slice(0, 255)) criteria[m.san] = describeMove(m)

  const state = positionState(chess, history)
  const mover = chess.turn() === 'w' ? 'White' : 'Black'

  const res = await askJev(state, {
    move: {
      type: 'choice',
      instructions:
        `${mover} is to move. Which of these legal moves is strongest? ` +
        'Weigh material, king safety, piece activity, pawn structure and immediate tactics.',
      criteria,
    },
    evaluation: {
      type: 'score',
      instructions: 'Assess the position from White\'s point of view, assuming best play from both sides.',
      criteria: EVAL_LEVELS,
    },
    danger: {
      type: 'noul',
      instructions: `${mover} is to move and faces an immediate tactical threat that loses material or the game if ignored.`,
    },
  })

  return {
    move: res.answers.move as ChoiceAnswer,
    evaluation: res.answers.evaluation as ScoreAnswer,
    danger: res.answers.danger as NoulAnswer,
    latencyMs: res._latencyMs,
    usage: res.usage,
    model: res.model,
  }
}

/** Top-n moves by Jev's probability mass, highest first. */
export function rankedMoves(answer: ChoiceAnswer, n = 3): { san: string; p: number }[] {
  return Object.entries(answer.probabilities ?? {})
    .map(([san, p]) => ({ san, p }))
    .sort((a, b) => b.p - a.p)
    .slice(0, n)
}

/** Map Jev's 0..6 rubric score onto a rough pawn-equivalent eval for display. */
export function scoreToPawns(score: number): number {
  const centre = (EVAL_LEVELS.length - 1) / 2
  const offset = score - centre
  // Levels are ordinal, not linear -- expand the tails so "completely winning"
  // doesn't read as a 3-pawn edge.
  return Math.sign(offset) * (Math.abs(offset) ** 1.8) * 1.1
}
