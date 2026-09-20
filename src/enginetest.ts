/**
 * Dev-only checks on the Stockfish driver.
 * Open /enginetest.html with the dev server running.
 *
 * Section 2 is the important one: it imitates what the UI actually does when
 * you step through a game -- interrupt the current search and immediately ask
 * about the next position -- and asserts that every line the engine reports
 * is legal in the position it was reported for.
 */

import { Chess } from 'chess.js'
import { Engine, formatEval } from './lib/stockfish'
import { uciToObject } from './lib/pv'

const out = document.getElementById('out')!
const log = (s: string) => { out.textContent += '\n' + s }
let failures = 0
const check = (ok: boolean, name: string, detail = '') => {
  if (!ok) failures++
  log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

const legalIn = (fen: string, uci: string) => {
  const c = new Chess()
  try {
    c.load(fen)
    return !!c.move(uciToObject(uci))
  } catch {
    return false
  }
}

type Known = { name: string; fen: string; expect: (r: { san: string; evalText: string; mate: number | null; cp: number | null }) => boolean; want: string }

const KNOWN: Known[] = [
  {
    name: 'mate in one (back rank)',
    fen: '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1',
    want: 'Ra8#, score #1',
    expect: (r) => r.san === 'Ra8#' && r.mate === 1,
  },
  {
    name: "mate in one (scholar's)",
    // Queen on h5, not f3: from f3 a knight on f6 blocks the file and there is
    // no mate at all. Verified against chess.js before trusting it here.
    fen: 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4',
    want: 'Qxf7#, score #1',
    expect: (r) => r.san === 'Qxf7#' && r.mate === 1,
  },
  {
    name: 'start position is near equal',
    fen: new Chess().fen(),
    want: 'eval within [0.0, +0.6]',
    expect: (r) => r.cp !== null && r.cp >= 0 && r.cp <= 60,
  },
  {
    name: 'must not grab a defended pawn',
    // Nxe5?? loses a knight to Nxe5. The engine should prefer something else.
    fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 4 3',
    want: 'anything but Nxe5',
    expect: (r) => r.san !== 'Nxe5',
  },
  {
    name: 'free material is taken',
    // White to move and e5 is undefended -- the b8 knight has not come out yet,
    // so Nxe5 simply wins a pawn.
    fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 2',
    want: 'Nxe5, eval at least +0.8',
    expect: (r) => r.san === 'Nxe5' && r.cp !== null && r.cp >= 80,
  },
]

async function main() {
  out.textContent = 'Engine test'
  const engine = new Engine()
  await engine.init()

  log('\n[1] known positions, one search at a time')
  for (const k of KNOWN) {
    const lines = await engine.analyse(k.fen, { multipv: 2, depth: 16 })
    const top = lines[0]
    if (!top) { check(false, k.name, 'no lines returned'); continue }

    const c = new Chess()
    c.load(k.fen)
    const mv = c.move(uciToObject(top.pv[0]))
    const san = mv ? mv.san : '(illegal!)'
    const evalText = formatEval(top, k.fen.split(' ')[1] as 'w' | 'b')

    check(
      k.expect({ san, evalText, mate: top.mate, cp: top.cp }),
      k.name,
      `got ${san} ${evalText} (want ${k.want})`,
    )

    // Every line must be legal in the position we asked about.
    const illegal = lines.filter((l) => !legalIn(k.fen, l.pv[0]))
    check(illegal.length === 0, `  all ${lines.length} lines legal in that position`,
      illegal.length ? `${illegal.length} illegal` : '')
  }

  log('\n[2] stepping through a game (interrupt + re-ask, as the UI does)')
  const game = new Chess()
  const moves = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7']
  const violations: string[] = []
  let reports = 0
  let emptyPositions = 0

  for (const san of moves) {
    game.move(san)
    const fen = game.fen()
    let sawAny = false

    engine.stop()
    // Do not await: mimic the UI, which fires a new search and moves on.
    const pending = engine.analyse(fen, { multipv: 2, depth: 20 }, (u) => {
      for (const line of u.lines) {
        reports++
        sawAny = true
        if (!legalIn(fen, line.pv[0])) {
          violations.push(`after ${san}: reported ${line.pv[0]} which is illegal there`)
        }
      }
    })
    void pending.catch(() => {})

    // Let it think about as long as a person clicking through a game would.
    await new Promise((r) => setTimeout(r, 350))
    if (!sawAny) emptyPositions++
  }

  await new Promise((r) => setTimeout(r, 1200))

  check(reports > 0, 'engine reported lines while stepping', `${reports} line updates`)
  check(emptyPositions === 0, 'every position produced at least one line',
    `${emptyPositions}/${moves.length} positions went silent`)
  check(violations.length === 0, 'no line was reported for the wrong position',
    violations.slice(0, 4).join(' | '))

  log('\n[3] driver hygiene')
  const leaked = (engine as unknown as { listeners: Set<unknown> }).listeners.size
  check(leaked <= 1, 'listeners are cleaned up after each search', `${leaked} still registered`)

  log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`)
  ;(window as unknown as { __enginetest: unknown }).__enginetest = { failures }
}

main().catch((e) => {
  log('CRASH: ' + (e?.stack ?? e))
  ;(window as unknown as { __enginetest: unknown }).__enginetest = { failures: failures || 1 }
})
