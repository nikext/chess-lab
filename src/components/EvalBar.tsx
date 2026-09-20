export function EvalBar({ whiteProb, height }: { whiteProb: number; height?: number }) {
  const pct = Math.max(0, Math.min(1, whiteProb)) * 100
  return (
    <div className="evalbar" style={{ height }} title={`White win probability ${pct.toFixed(0)}%`}>
      <div className="white" data-testid="eval-white" style={{ height: `${pct}%` }} />
      <div className="tick" />
    </div>
  )
}
