/**
 * Dev-only regression check for the board-vision pipeline.
 * Open /selftest.html with the dev server running.
 *
 * It renders synthetic boards (deliberately with padding, an off-centre
 * position and a page background, so detection has real work to do), calibrates
 * a theme from the starting position, then measures per-square accuracy on
 * other positions.
 */

import { Chess } from 'chess.js'
import { allCellFeatures, detectBoard, imageDataFrom, type Rect } from './vision/board'
import { calibrate, START_LABELS, type Label } from './vision/templates'
import { buildFen, guessOrientation } from './lib/fen'

const GLYPH: Record<string, string> = {
  P: '♙', N: '♘', B: '♗', R: '♖', Q: '♕', K: '♔',
  p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚',
}

const out = document.getElementById('out')!
const shots = document.getElementById('shots')!
const log = (s: string) => { out.textContent += '\n' + s }

/** Render a FEN to a canvas that looks roughly like a site screenshot. */
function render(fen: string, opts: { cell?: number; padX?: number; padY?: number; light?: string; dark?: string } = {}) {
  const { cell = 64, padX = 57, padY = 31, light = '#eeeed2', dark = '#769656' } = opts
  const canvas = document.createElement('canvas')
  canvas.width = padX + cell * 8 + 40
  canvas.height = padY + cell * 8 + 70
  const ctx = canvas.getContext('2d')!

  ctx.fillStyle = '#262421'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  // Decoy UI chrome, so the detector cannot just grab the biggest block.
  ctx.fillStyle = '#3a3835'
  ctx.fillRect(8, 8, canvas.width - 16, 16)

  const board = new Chess(fen).board()
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      ctx.fillStyle = (r + f) % 2 === 0 ? light : dark
      ctx.fillRect(padX + f * cell, padY + r * cell, cell, cell)
      const sq = board[r][f]
      if (sq) {
        const ch = sq.color === 'w' ? sq.type.toUpperCase() : sq.type
        ctx.font = `${Math.round(cell * 0.78)}px "DejaVu Sans", "Noto Sans Symbols2", serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillStyle = sq.color === 'w' ? '#ffffff' : '#111111'
        ctx.strokeStyle = sq.color === 'w' ? '#333333' : '#dddddd'
        ctx.lineWidth = Math.max(1, cell * 0.022)
        const cx = padX + f * cell + cell / 2
        const cy = padY + r * cell + cell / 2
        ctx.fillText(GLYPH[ch], cx, cy)
        ctx.strokeText(GLYPH[ch], cx, cy)
      }
    }
  }
  return { canvas, truth: { x: padX, y: padY, size: cell * 8 } as Rect }
}

function toImageData(canvas: HTMLCanvasElement) {
  return imageDataFrom(canvas, canvas.width, canvas.height)
}

function show(canvas: HTMLCanvasElement, caption: string) {
  const wrap = document.createElement('div')
  wrap.style.cssText = 'display:inline-block;margin:8px 10px 0 0;text-align:center'
  canvas.style.cssText = 'max-width:250px;border:1px solid #2b3040;border-radius:6px'
  const cap = document.createElement('div')
  cap.textContent = caption
  cap.style.cssText = 'font-size:11px;color:#8c93a6;margin-top:3px'
  wrap.append(canvas, cap)
  shots.append(wrap)
}

const START = new Chess().fen()
const CASES: [string, string][] = [
  ['Italian Game', 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 0 4'],
  ['Endgame, few pieces', '8/5k2/4p3/3pP3/3P1K2/8/8/8 w - - 0 1'],
  ['Queens and rooks', 'r2q1rk1/pp2ppbp/2n3p1/8/3PP3/2N1BN2/PP3PPP/R2Q1RK1 w - - 0 11'],
]

async function main() {
  out.textContent = 'Vision self-test'
  let failures = 0

  // 1. Detection, across a few cell sizes and board palettes.
  log('\n[1] board detection')
  const variants: { name: string; opts: Parameters<typeof render>[1] }[] = [
    { name: 'default 64px green', opts: {} },
    { name: 'small 40px', opts: { cell: 40, padX: 23, padY: 45 } },
    { name: 'large 92px brown', opts: { cell: 92, padX: 71, padY: 19, light: '#f0d9b5', dark: '#b58863' } },
    { name: 'low-contrast grey', opts: { cell: 56, padX: 35, padY: 27, light: '#d8d8d8', dark: '#a9a9a9' } },
  ]
  for (const v of variants) {
    const { canvas, truth } = render(START, v.opts)
    const found = detectBoard(toImageData(canvas))
    if (!found) { log(`  FAIL  ${v.name}: nothing detected`); failures++; continue }
    const dx = Math.abs(found.rect.x - truth.x)
    const dy = Math.abs(found.rect.y - truth.y)
    const ds = Math.abs(found.rect.size - truth.size)
    const tol = Math.max(3, truth.size * 0.02)
    const ok = dx <= tol && dy <= tol && ds <= tol * 2
    if (!ok) failures++
    log(`  ${ok ? 'ok  ' : 'FAIL'}  ${v.name}: off by x${dx} y${dy} size${ds} (tolerance ${tol.toFixed(1)})`)
  }

  // 2. Calibrate from the starting position, then recognise other positions.
  log('\n[2] calibration + recognition')
  const { canvas: startCanvas } = render(START)
  const startImg = toImageData(startCanvas)
  const startRect = detectBoard(startImg)!.rect
  const bank = calibrate('selftest', startImg, startRect, false)
  log(`  bank: ${bank.size} exemplars, complete=${bank.isComplete}`)
  if (!bank.isComplete) failures++
  show(startCanvas, 'calibration source')

  // Sanity: the calibration image must read back perfectly.
  const selfRead = bank.classifyBoard(allCellFeatures(startImg, startRect)).map((r) => r.label)
  const selfWrong = selfRead.filter((l, i) => l !== START_LABELS[i]).length
  log(`  ${selfWrong === 0 ? 'ok  ' : 'FAIL'}  re-reading the calibration image: ${64 - selfWrong}/64`)
  if (selfWrong !== 0) failures++

  for (const [name, fen] of CASES) {
    const { canvas } = render(fen)
    const img = toImageData(canvas)
    const found = detectBoard(img)
    if (!found) { log(`  FAIL  ${name}: no board detected`); failures++; continue }

    const labels = bank.classifyBoard(allCellFeatures(img, found.rect)).map((r) => r.label)
    const expected = fenToLabels(fen)
    const wrong = labels.map((l, i) => [i, l, expected[i]] as const).filter(([, a, b]) => a !== b)

    const orientation = guessOrientation(labels, 'w')
    const built = buildFen(labels, orientation, fen.split(' ')[1] as 'w' | 'b')
    const matches = built.placement === fen.split(' ')[0]

    if (wrong.length) failures++
    log(`  ${wrong.length === 0 ? 'ok  ' : 'FAIL'}  ${name}: ${64 - wrong.length}/64 squares, orientation=${orientation}, placement match=${matches}`)
    for (const [i, got, want] of wrong.slice(0, 6)) {
      log(`          square index ${i}: read "${got}", expected "${want}"`)
    }
    show(canvas, name)
  }

  // 3. A flipped board should still produce the correct FEN once oriented.
  log('\n[3] flipped board')
  const flippedFen = CASES[0][1]
  const { canvas: fc } = renderFlipped(flippedFen)
  const fimg = toImageData(fc)
  const frect = detectBoard(fimg)!.rect
  const flabels = bank.classifyBoard(allCellFeatures(fimg, frect)).map((r) => r.label)
  const fbuilt = buildFen(flabels, 'black', flippedFen.split(' ')[1] as 'w' | 'b')
  const fok = fbuilt.placement === flippedFen.split(' ')[0]
  if (!fok) failures++
  log(`  ${fok ? 'ok  ' : 'FAIL'}  black-at-bottom screenshot reconstructs the same position: ${fok}`)
  show(fc, 'flipped')

  log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`)
  ;(window as any).__selftest = { failures }
}

function renderFlipped(fen: string) {
  // Re-render with ranks and files reversed: what you see playing as Black.
  const board = new Chess(fen).board()
  const reversed = board.map((r) => [...r].reverse()).reverse()
  const placement = reversed
    .map((row) => {
      let line = '', gap = 0
      for (const sq of row) {
        if (!sq) { gap++; continue }
        if (gap) { line += gap; gap = 0 }
        line += sq.color === 'w' ? sq.type.toUpperCase() : sq.type
      }
      return gap ? line + gap : line
    })
    .join('/')
  return render(`${placement} w - - 0 1`)
}

function fenToLabels(fen: string): Label[] {
  const labels: Label[] = []
  for (const rank of fen.split(' ')[0].split('/')) {
    for (const ch of rank) {
      if (/\d/.test(ch)) labels.push(...Array(Number(ch)).fill('.' as Label))
      else labels.push(ch as Label)
    }
  }
  return labels
}

main().catch((e) => { log('CRASH: ' + (e?.stack ?? e)) })
