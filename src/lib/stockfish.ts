/**
 * Minimal UCI driver for the single-threaded Stockfish 19 WASM build in
 * /public/engine. Single-threaded is deliberate: the multi-threaded build
 * needs SharedArrayBuffer, which means COOP/COEP headers on every response.
 * Not worth it for a local tool -- this build still plays far above human level.
 */

export type EngineLine = {
  multipv: number
  depth: number
  /** Centipawns from the side-to-move's point of view. Null when `mate` is set. */
  cp: number | null
  /** Moves-to-mate from the side-to-move's point of view. Negative = getting mated. */
  mate: number | null
  /** Principal variation as UCI move strings, e.g. ['e2e4', 'e7e5']. */
  pv: string[]
}

export type AnalysisUpdate = {
  lines: EngineLine[]
  depth: number
  done: boolean
}

const ENGINE_URL = '/engine/stockfish-19-lite-single.js'

export class Engine {
  private worker: Worker | null = null
  private listeners = new Set<(line: string) => void>()
  private ready: Promise<void> | null = null
  private generation = 0

  async init(): Promise<void> {
    if (this.ready) return this.ready
    this.ready = new Promise<void>((resolve, reject) => {
      try {
        this.worker = new Worker(ENGINE_URL)
      } catch (err) {
        reject(err)
        return
      }
      this.worker.onmessage = (e: MessageEvent) => {
        const text = typeof e.data === 'string' ? e.data : String(e.data?.data ?? '')
        for (const fn of this.listeners) fn(text)
      }
      this.worker.onerror = (e) => reject(new Error(`engine worker failed: ${e.message}`))

      const onReady = (line: string) => {
        if (line.startsWith('uciok')) this.send('isready')
        if (line.startsWith('readyok')) {
          this.listeners.delete(onReady)
          resolve()
        }
      }
      this.listeners.add(onReady)
      this.send('uci')
    })
    return this.ready
  }

  private send(cmd: string) {
    this.worker?.postMessage(cmd)
  }

  /** Abort whatever search is running. Safe to call when idle. */
  stop() {
    this.generation++
    this.send('stop')
  }

  /**
   * Search `fen` and report the top `multipv` lines.
   * Resolves with the final set of lines; `onUpdate` fires at each new depth.
   */
  async analyse(
    fen: string,
    opts: { multipv?: number; depth?: number; movetimeMs?: number } = {},
    onUpdate?: (u: AnalysisUpdate) => void,
  ): Promise<EngineLine[]> {
    await this.init()
    const { multipv = 2, depth = 20, movetimeMs } = opts

    const gen = ++this.generation
    const lines = new Map<number, EngineLine>()
    let maxDepth = 0

    return new Promise<EngineLine[]>((resolve) => {
      const collect = (text: string) => {
        if (gen !== this.generation) return

        if (text.startsWith('info ') && text.includes(' pv ')) {
          const parsed = parseInfo(text)
          if (parsed) {
            lines.set(parsed.multipv, parsed)
            maxDepth = Math.max(maxDepth, parsed.depth)
            onUpdate?.({ lines: sorted(lines), depth: maxDepth, done: false })
          }
          return
        }

        if (text.startsWith('bestmove')) {
          this.listeners.delete(collect)
          const final = sorted(lines)
          onUpdate?.({ lines: final, depth: maxDepth, done: true })
          resolve(final)
        }
      }

      this.listeners.add(collect)
      this.send(`setoption name MultiPV value ${multipv}`)
      this.send('ucinewgame')
      this.send(`position fen ${fen}`)
      this.send(movetimeMs ? `go movetime ${movetimeMs}` : `go depth ${depth}`)
    })
  }

  dispose() {
    this.generation++
    this.worker?.terminate()
    this.worker = null
    this.ready = null
    this.listeners.clear()
  }
}

function sorted(map: Map<number, EngineLine>): EngineLine[] {
  return [...map.values()].sort((a, b) => a.multipv - b.multipv)
}

function parseInfo(text: string): EngineLine | null {
  const tok = text.split(/\s+/)
  const at = (k: string) => {
    const i = tok.indexOf(k)
    return i === -1 ? null : tok[i + 1]
  }

  const pvIndex = tok.indexOf('pv')
  if (pvIndex === -1) return null
  const pv = tok.slice(pvIndex + 1).filter(Boolean)
  if (!pv.length) return null

  const depth = Number(at('depth') ?? 0)
  if (!depth) return null

  const scoreIndex = tok.indexOf('score')
  let cp: number | null = null
  let mate: number | null = null
  if (scoreIndex !== -1) {
    const kind = tok[scoreIndex + 1]
    const value = Number(tok[scoreIndex + 2])
    if (kind === 'cp') cp = value
    else if (kind === 'mate') mate = value
  }

  return { multipv: Number(at('multipv') ?? 1), depth, cp, mate, pv }
}

/** Human-readable eval, always from White's point of view. */
export function formatEval(line: EngineLine, sideToMove: 'w' | 'b'): string {
  const flip = sideToMove === 'b' ? -1 : 1
  if (line.mate !== null) {
    const m = line.mate * flip
    return `#${m > 0 ? '' : '-'}${Math.abs(line.mate)}`
  }
  if (line.cp === null) return '--'
  const pawns = (line.cp * flip) / 100
  return `${pawns >= 0 ? '+' : ''}${pawns.toFixed(2)}`
}

/** Win probability for White, 0..1. Standard logistic fit on centipawns. */
export function winProbability(line: EngineLine, sideToMove: 'w' | 'b'): number {
  const flip = sideToMove === 'b' ? -1 : 1
  if (line.mate !== null) return line.mate * flip > 0 ? 1 : 0
  if (line.cp === null) return 0.5
  return 1 / (1 + Math.exp((-0.00368208 * line.cp * flip)))
}
