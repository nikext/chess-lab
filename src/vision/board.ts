/**
 * Finding a chessboard inside a screenshot, and turning its 64 cells into
 * background-invariant feature vectors.
 *
 * The detector optimises directly for the thing that actually identifies a
 * chessboard: a grid whose cells split cleanly into two alternating colour
 * groups. That beats generic line/contour detection on flat UI screenshots,
 * where board edges are often low-contrast but the checker pattern never is.
 */

export type Rect = { x: number; y: number; size: number }

export const GRID = 8
/** Feature thumbnails are FEAT x FEAT pixels per channel. */
export const FEAT = 20
/** Floor for feature normalisation; see the note in `cellFeature`. */
const MIN_FEATURE_NORM = 3.0

export function imageDataFrom(source: CanvasImageSource, w: number, h: number): ImageData {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(source, 0, 0, w, h)
  return ctx.getImageData(0, 0, w, h)
}

function medianPatch(img: ImageData, cx: number, cy: number, r: number): [number, number, number] {
  const rs: number[] = [], gs: number[] = [], bs: number[] = []
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue
      const i = (y * img.width + x) * 4
      rs.push(img.data[i]); gs.push(img.data[i + 1]); bs.push(img.data[i + 2])
    }
  }
  if (!rs.length) return [0, 0, 0]
  const mid = (a: number[]) => { a.sort((p, q) => p - q); return a[a.length >> 1] }
  return [mid(rs), mid(gs), mid(bs)]
}

/**
 * Coarse scorer: mean luminance per cell, no allocation, no sorting.
 * Cheap enough to sweep the whole image with, and accurate to well under half
 * a cell -- which is all the refinement pass needs to lock on.
 */
function fastScore(img: ImageData, rect: Rect): number {
  const cell = rect.size / GRID
  if (cell < 8) return -Infinity

  let sum0 = 0, sum1 = 0, sq0 = 0, sq1 = 0, n0 = 0, n1 = 0

  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) {
      const x0 = rect.x + col * cell
      const y0 = rect.y + row * cell
      let acc = 0, count = 0
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          const sx = Math.round(x0 + cell * (0.15 + 0.35 * i))
          const sy = Math.round(y0 + cell * (0.15 + 0.35 * j))
          if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) continue
          const k = (sy * img.width + sx) * 4
          acc += 0.2126 * img.data[k] + 0.7152 * img.data[k + 1] + 0.0722 * img.data[k + 2]
          count++
        }
      }
      if (!count) return -Infinity
      const lum = acc / count
      if ((row + col) & 1) { sum1 += lum; sq1 += lum * lum; n1++ }
      else { sum0 += lum; sq0 += lum * lum; n0++ }
    }
  }

  const m0 = sum0 / n0, m1 = sum1 / n1
  const sd0 = Math.sqrt(Math.max(0, sq0 / n0 - m0 * m0))
  const sd1 = Math.sqrt(Math.max(0, sq1 / n1 - m1 * m1))
  const separation = Math.abs(m0 - m1)
  if (separation < 8) return -Infinity
  return separation - 0.55 * (sd0 + sd1)
}

// Scratch buffers for the refinement scorer, reused across candidates.
const scratch = [new Float64Array(9), new Float64Array(9), new Float64Array(9)]

function median9(a: Float64Array, n: number): number {
  const slice = Array.prototype.slice.call(a, 0, n) as number[]
  slice.sort((p, q) => p - q)
  return slice[n >> 1]
}

/**
 * Refinement scorer: per-channel median per cell, so a piece sitting in the
 * cell cannot drag the estimate off the square's true colour. This robustness
 * is what makes the final alignment land exactly on the grid.
 */
function scoreCandidate(img: ImageData, rect: Rect): number {
  const cell = rect.size / GRID
  if (cell < 8) return -Infinity

  const means = [
    [0, 0, 0],
    [0, 0, 0],
  ]
  const cells: [number, number, number][][] = [[], []]

  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) {
      const x0 = rect.x + col * cell
      const y0 = rect.y + row * cell
      let n = 0
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          const sx = Math.round(x0 + cell * (0.15 + 0.35 * i))
          const sy = Math.round(y0 + cell * (0.15 + 0.35 * j))
          if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) continue
          const k = (sy * img.width + sx) * 4
          scratch[0][n] = img.data[k]
          scratch[1][n] = img.data[k + 1]
          scratch[2][n] = img.data[k + 2]
          n++
        }
      }
      if (!n) return -Infinity
      const px: [number, number, number] = [median9(scratch[0], n), median9(scratch[1], n), median9(scratch[2], n)]
      cells[(row + col) & 1].push(px)
    }
  }

  for (const parity of [0, 1]) {
    for (let c = 0; c < 3; c++) {
      means[parity][c] = cells[parity].reduce((t, px) => t + px[c], 0) / cells[parity].length
    }
  }

  let spread = 0
  for (const parity of [0, 1]) {
    const v = cells[parity].reduce(
      (t, px) => t + (px[0] - means[parity][0]) ** 2 + (px[1] - means[parity][1]) ** 2 + (px[2] - means[parity][2]) ** 2,
      0,
    ) / cells[parity].length
    spread += Math.sqrt(v)
  }

  const separation = Math.sqrt(
    [0, 1, 2].reduce((t, c) => t + (means[0][c] - means[1][c]) ** 2, 0),
  )

  // Real boards: strong separation between the two square colours, low spread
  // within each. The contrast floor keeps flat UI regions from scoring at all.
  if (separation < 12) return -Infinity
  return separation - 0.55 * spread
}

/**
 * Locate the board. Returns a rect in the coordinate space of `img`.
 * Coarse luminance sweep, then robust per-axis refinement.
 */
export function detectBoard(img: ImageData): { rect: Rect; score: number } | null {
  const minSize = Math.floor(Math.min(img.width, img.height) * 0.25)
  const maxSize = Math.min(img.width, img.height)
  if (maxSize < 64) return null

  type Candidate = { rect: Rect; score: number }
  // Held in an object because it is written from inside the closures below,
  // which defeats control-flow narrowing on a plain local.
  const state: { best: Candidate | null } = { best: null }

  const makeConsider = (score: (img: ImageData, r: Rect) => number) => (rect: Rect) => {
    if (rect.x < 0 || rect.y < 0 || rect.size < 64) return
    if (rect.x + rect.size > img.width || rect.y + rect.size > img.height) return
    const value = score(img, rect)
    if (value > -Infinity && (!state.best || value > state.best.score)) {
      state.best = { rect, score: value }
    }
  }

  // --- coarse: log-spaced scales, position stepped at half a cell
  const considerFast = makeConsider(fastScore)
  const SCALES = 18
  for (let s = 0; s < SCALES; s++) {
    const size = Math.round(minSize * (maxSize / minSize) ** (s / (SCALES - 1)))
    const step = Math.max(3, Math.round(size / GRID / 2))
    for (let y = 0; y + size <= img.height; y += step) {
      for (let x = 0; x + size <= img.width; x += step) considerFast({ x, y, size })
    }
  }
  if (!state.best) return null

  // --- refine with the robust scorer
  return refineBoard(img, state.best.rect)
}

/**
 * Polish a rect that is already roughly right, using the robust scorer.
 * Exposed separately so a detection run on a downscaled copy can be sharpened
 * against the full-resolution image, where a pixel is worth much less.
 *
 * `searchScale` shrinks the search window; pass a small value when the input
 * rect is known to be close.
 */
export function refineBoard(img: ImageData, rect: Rect, searchScale = 1): { rect: Rect; score: number } {
  const state: { best: { rect: Rect; score: number } } = {
    best: { rect, score: scoreCandidate(img, rect) },
  }

  const consider = (candidate: Rect) => {
    if (candidate.x < 0 || candidate.y < 0 || candidate.size < 64) return
    if (candidate.x + candidate.size > img.width || candidate.y + candidate.size > img.height) return
    const value = scoreCandidate(img, candidate)
    if (value > -Infinity && value > state.best.score) state.best = { rect: candidate, score: value }
  }

  for (let round = 0; round < 2; round++) {
    let cur = state.best.rect
    const cell = cur.size / GRID

    // Size, holding the centre roughly fixed. A full cell of span comfortably
    // covers the gap between adjacent coarse scales.
    const sizeSpan = Math.max(3, Math.round(cell * searchScale))
    for (let ds = -sizeSpan; ds <= sizeSpan; ds++) {
      consider({ x: cur.x - Math.round(ds / 2), y: cur.y - Math.round(ds / 2), size: cur.size + ds })
    }

    cur = state.best.rect
    const posSpan = Math.max(4, Math.round(cell * 0.35 * searchScale))
    for (let dy = -posSpan; dy <= posSpan; dy++) {
      for (let dx = -posSpan; dx <= posSpan; dx++) {
        consider({ x: cur.x + dx, y: cur.y + dy, size: cur.size })
      }
    }
  }

  const cur = state.best.rect
  for (let ds = -6; ds <= 6; ds++) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        consider({ x: cur.x + dx, y: cur.y + dy, size: cur.size + ds })
      }
    }
  }

  return state.best
}

/**
 * Feature vector for one cell: two FEAT x FEAT channels, concatenated.
 *   channel 0 -- how far the pixel is from this cell's own background colour
 *   channel 1 -- pixel luminance, but only where channel 0 says "piece"
 *
 * Deriving the background per cell is what makes this robust to light/dark
 * squares, board themes, and last-move highlights: all of those shift the
 * background uniformly and cancel out.
 */
export function cellFeature(img: ImageData, rect: Rect, row: number, col: number): Float32Array {
  const cell = rect.size / GRID
  const x0 = rect.x + col * cell
  const y0 = rect.y + row * cell

  // Ignore the outer ring: it carries board gridlines and the little rank/file
  // labels that lichess and chess.com draw inside corner squares.
  const pad = cell * 0.09
  const inner = cell - pad * 2

  const bg = medianPatch(img, Math.round(x0 + pad * 0.5), Math.round(y0 + pad * 0.5), Math.max(1, Math.round(pad * 0.4)))

  const out = new Float32Array(FEAT * FEAT * 2)
  for (let fy = 0; fy < FEAT; fy++) {
    for (let fx = 0; fx < FEAT; fx++) {
      const sx = Math.round(x0 + pad + ((fx + 0.5) / FEAT) * inner)
      const sy = Math.round(y0 + pad + ((fy + 0.5) / FEAT) * inner)
      const cx = Math.min(img.width - 1, Math.max(0, sx))
      const cy = Math.min(img.height - 1, Math.max(0, sy))
      const i = (cy * img.width + cx) * 4
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2]

      const delta = Math.sqrt((r - bg[0]) ** 2 + (g - bg[1]) ** 2 + (b - bg[2]) ** 2) / 441.67
      const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
      const k = fy * FEAT + fx
      out[k] = delta
      out[FEAT * FEAT + k] = delta > 0.12 ? lum : 0
    }
  }

  // Normalise so distances compare across themes and image scales -- but floor
  // the divisor. An empty cell's vector is nearly all zeros, and dividing that
  // by its own tiny norm would amplify noise into an arbitrary unit vector,
  // making empty squares stop resembling one another.
  let norm = 0
  for (const v of out) norm += v * v
  norm = Math.max(Math.sqrt(norm), MIN_FEATURE_NORM)
  for (let i = 0; i < out.length; i++) out[i] /= norm
  return out
}

/** All 64 features, in visual order: index 0 = top-left cell as drawn. */
export function allCellFeatures(img: ImageData, rect: Rect): Float32Array[] {
  const feats: Float32Array[] = []
  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) feats.push(cellFeature(img, rect, row, col))
  }
  return feats
}

/** Crop a cell to a small data URL, for showing the user what was classified. */
export function cellThumbnail(source: CanvasImageSource, rect: Rect, row: number, col: number, px = 48): string {
  const cell = rect.size / GRID
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = px
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, rect.x + col * cell, rect.y + row * cell, cell, cell, 0, 0, px, px)
  return canvas.toDataURL('image/png')
}

export function distance(a: Float32Array, b: Float32Array): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2
  return Math.sqrt(sum)
}
