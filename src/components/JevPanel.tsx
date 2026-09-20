import { EVAL_LEVELS, rankedMoves, scoreToPawns, type JevRead } from '../lib/jev'

type Props = {
  read: JevRead | null
  loading: boolean
  error: string
  /** Stockfish's best move in SAN, so we can show whether intuition agrees. */
  engineBest?: string | null
}

export function JevPanel({ read, loading, error, engineBest }: Props) {
  if (error) {
    return (
      <div className="panel">
        <h2>Jev · intuition</h2>
        <div className="notice error">{error}</div>
      </div>
    )
  }

  if (!read) {
    return (
      <div className="panel">
        <h2>Jev · intuition</h2>
        <div className="notice info">{loading ? 'Asking Jev…' : 'No reading yet.'}</div>
      </div>
    )
  }

  const top = rankedMoves(read.move, 5)
  const pawns = scoreToPawns(read.evaluation.score)
  const level = EVAL_LEVELS[Math.round(read.evaluation.score)] ?? ''
  const agrees = engineBest && read.move.choice === engineBest
  const danger = read.danger?.noul ?? 0

  return (
    <div className="panel">
      <div className="row spread">
        <h2 style={{ margin: 0 }}>Jev · intuition</h2>
        <span className="small muted mono">
          {read.latencyMs ? `${read.latencyMs} ms` : ''}
          {read.usage ? ` · ${read.usage.input_tokens} tok` : ''}
        </span>
      </div>

      <div className="row" style={{ marginTop: 10, marginBottom: 12 }}>
        <span style={{ fontSize: 21, fontWeight: 650, fontFamily: 'ui-monospace, Menlo, monospace' }}>
          {read.move.choice}
        </span>
        <span className="small muted">{(read.move.confidence * 100).toFixed(0)}% confident</span>
        {engineBest && (
          agrees
            ? <span className="pill good">agrees with Stockfish</span>
            : <span className="pill warn">Stockfish prefers {engineBest}</span>
        )}
      </div>

      <div className="bars">
        {top.map((m) => (
          <div className="bar-row" key={m.san}>
            <span className="san">{m.san}</span>
            <span className="track"><span className="fill" style={{ width: `${m.p * 100}%` }} /></span>
            <span className="pct">{(m.p * 100).toFixed(1)}%</span>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 14 }}>
        <div className="row spread small">
          <span className="muted">Positional read</span>
          <span className="mono">{pawns >= 0 ? '+' : ''}{pawns.toFixed(2)} for White</span>
        </div>
        <div className="small muted" style={{ marginTop: 3 }}>{level}</div>
      </div>

      <div style={{ marginTop: 12 }}>
        <div className="row spread small" style={{ marginBottom: 4 }}>
          <span className="muted">Immediate danger to the side to move</span>
          <span className="mono">{(danger * 100).toFixed(0)}%</span>
        </div>
        <div className="meter">
          <span
            className="fill"
            style={{
              width: `${danger * 100}%`,
              background: danger > 0.6 ? 'var(--danger)' : 'var(--jev)',
            }}
          />
        </div>
      </div>

      <div className="small muted" style={{ marginTop: 12 }}>
        Single forward pass, no search — this is a policy, not an engine.
      </div>
    </div>
  )
}
