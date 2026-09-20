/**
 * Piece recognition by self-calibration.
 *
 * There is no universal piece classifier here on purpose. Every site renders
 * its own sprite set, so instead of shipping templates that go stale, the app
 * learns a set from one screenshot of a starting position. That takes about
 * ten seconds, gives labelled examples of all twelve piece types, and makes
 * subsequent recognition on that theme essentially exact.
 *
 * Corrections the user makes are folded back in as extra exemplars, so the
 * bank sharpens with use.
 */

import { allCellFeatures, distance, type Rect } from './board'

export type Label = '.' | 'P' | 'N' | 'B' | 'R' | 'Q' | 'K' | 'p' | 'n' | 'b' | 'r' | 'q' | 'k'

/** Starting position in visual order, white at the bottom. Index 0 = a8. */
export const START_LABELS: Label[] = [
  'r','n','b','q','k','b','n','r',
  'p','p','p','p','p','p','p','p',
  '.','.','.','.','.','.','.','.',
  '.','.','.','.','.','.','.','.',
  '.','.','.','.','.','.','.','.',
  '.','.','.','.','.','.','.','.',
  'P','P','P','P','P','P','P','P',
  'R','N','B','Q','K','B','N','R',
]

type Exemplar = { label: Label; vec: Float32Array }
type StoredTheme = { name: string; createdAt: number; exemplars: { label: Label; q: number[] }[] }

const STORAGE_KEY = 'chess-lab.themes.v1'
const SCALE = 10000
const MAX_EMPTY_EXEMPLARS = 10

const quantise = (v: Float32Array) => Array.from(v, (x) => Math.round(x * SCALE))
const dequantise = (q: number[]) => Float32Array.from(q, (x) => x / SCALE)

export class TemplateBank {
  readonly name: string
  private exemplars: Exemplar[]

  constructor(name: string, exemplars: Exemplar[] = []) {
    this.name = name
    this.exemplars = exemplars
  }

  get size() {
    return this.exemplars.length
  }

  get labelCounts(): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const e of this.exemplars) counts[e.label] = (counts[e.label] ?? 0) + 1
    return counts
  }

  /** True once every piece type has at least one exemplar. */
  get isComplete(): boolean {
    const counts = this.labelCounts
    return [...'PNBRQKpnbrqk.'].every((l) => counts[l] > 0)
  }

  add(label: Label, vec: Float32Array) {
    if (label === '.') {
      const empties = this.exemplars.filter((e) => e.label === '.')
      if (empties.length >= MAX_EMPTY_EXEMPLARS) return
    }
    this.exemplars.push({ label, vec })
  }

  /**
   * Nearest-neighbour label for one cell.
   * `margin` is the gap to the best *differently-labelled* exemplar -- a small
   * margin means the call was close and is worth surfacing for review.
   */
  classify(vec: Float32Array): { label: Label; margin: number } {
    if (!this.exemplars.length) return { label: '.', margin: 0 }

    let best = Infinity
    let bestLabel: Label = '.'
    for (const e of this.exemplars) {
      const d = distance(vec, e.vec)
      if (d < best) { best = d; bestLabel = e.label }
    }

    let runnerUp = Infinity
    for (const e of this.exemplars) {
      if (e.label === bestLabel) continue
      const d = distance(vec, e.vec)
      if (d < runnerUp) runnerUp = d
    }

    return { label: bestLabel, margin: runnerUp === Infinity ? 1 : runnerUp - best }
  }

  classifyBoard(feats: Float32Array[]) {
    return feats.map((f) => this.classify(f))
  }

  toStored(): StoredTheme {
    return {
      name: this.name,
      createdAt: Date.now(),
      exemplars: this.exemplars.map((e) => ({ label: e.label, q: quantise(e.vec) })),
    }
  }

  static fromStored(s: StoredTheme): TemplateBank {
    return new TemplateBank(
      s.name,
      s.exemplars.map((e) => ({ label: e.label, vec: dequantise(e.q) })),
    )
  }
}

/** Build a bank from a screenshot of the standard starting position. */
export function calibrate(name: string, img: ImageData, rect: Rect, flipped: boolean): TemplateBank {
  const feats = allCellFeatures(img, rect)
  const bank = new TemplateBank(name)
  feats.forEach((vec, i) => {
    // A flipped screenshot shows the same layout reversed cell-for-cell.
    const label = START_LABELS[flipped ? 63 - i : i]
    bank.add(label, vec)
  })
  return bank
}

// ---------------------------------------------------------------- persistence

function readAll(): Record<string, StoredTheme> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
  } catch {
    return {}
  }
}

export function listThemes(): string[] {
  return Object.keys(readAll()).sort()
}

export function loadTheme(name: string): TemplateBank | null {
  const stored = readAll()[name]
  return stored ? TemplateBank.fromStored(stored) : null
}

export function saveTheme(bank: TemplateBank): { ok: true } | { ok: false; error: string } {
  const all = readAll()
  all[bank.name] = bank.toStored()
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
    return { ok: true }
  } catch (err: any) {
    return {
      ok: false,
      error:
        err?.name === 'QuotaExceededError'
          ? 'Browser storage is full. Delete an unused theme and try again.'
          : String(err?.message ?? err),
    }
  }
}

export function deleteTheme(name: string) {
  const all = readAll()
  delete all[name]
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
}
