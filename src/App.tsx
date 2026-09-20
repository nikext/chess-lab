import { useEffect, useRef, useState } from 'react'
import { Engine } from './lib/stockfish'
import { AnalyzeTab } from './components/AnalyzeTab'
import { PlayTab } from './components/PlayTab'

type Tab = 'analyse' | 'play'

export default function App() {
  const engineRef = useRef<Engine>(null as unknown as Engine)
  if (!engineRef.current) engineRef.current = new Engine()

  const [tab, setTab] = useState<Tab>('analyse')

  useEffect(() => {
    const engine = engineRef.current
    engine.init().catch(() => { /* surfaced per-tab */ })
    return () => engine.dispose()
  }, [])

  return (
    <div className="app">
      <header className="top">
        <h1>Chess Lab</h1>
        <span className="sub">Stockfish for strength · Jev for intuition</span>
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'analyse'} onClick={() => setTab('analyse')}>
            Analyse
          </button>
          <button role="tab" aria-selected={tab === 'play'} onClick={() => setTab('play')}>
            Play Jev
          </button>
        </div>
      </header>

      {tab === 'analyse'
        ? <AnalyzeTab engine={engineRef.current} />
        : <PlayTab engine={engineRef.current} />}
    </div>
  )
}
