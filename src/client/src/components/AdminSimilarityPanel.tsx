import { useState } from 'react'
import { fetchSimilarityReport, type SimilarityReport } from '../lib/api.ts'
import { errorMessage } from '../lib/errors.ts'
import { useT } from '../lib/i18n.tsx'

/** Rows shown before "Show all": a library of 40 can produce well over a thousand pairs. */
const INITIAL_ROWS = 150

/** Every resource against its nearest neighbours, scored as "Similar content" scores them, so its
 *  two thresholds (System settings) can be set from a real library rather than guessed. */
export function AdminSimilarityPanel() {
  const t = useT()
  const [report, setReport] = useState<SimilarityReport | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [showAll, setShowAll] = useState(false)

  async function run() {
    setRunning(true)
    setError('')
    try { setReport(await fetchSimilarityReport()); setShowAll(false) }
    catch (err: unknown) { setError(errorMessage(t, err, 'Could not compute similarities')) }
    finally { setRunning(false) }
  }

  const shown = (p: SimilarityReport['pairs'][number]) => report && (report.reranker && p.relevance != null
    ? p.relevance >= report.minRelevance
    : !report.reranker && p.cosine >= report.minSimilarity)
  const rows = report ? (showAll ? report.pairs : report.pairs.slice(0, INITIAL_ROWS)) : []

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-gray-500">
        Scores your own library (the {report?.limit ?? 40} most recent resources) the way the <em>Similar content</em> box does:
        each resource against its nearest neighbours by cosine similarity, then — when a reranker is configured — the nearest
        twelve judged by the reranker on title and summary. Pairs are directional: <em>from</em> is the resource being viewed.
        Add resources you know are related, run this, and set the thresholds in System settings between the related and
        unrelated pairs. Takes one reranker call per resource.
      </p>
      <button onClick={run} disabled={running} className="self-start px-3 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-sm">
        {running ? 'Scoring…' : report ? 'Run again' : 'Run'}
      </button>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {report && (
        <>
          <p className="text-xs text-gray-400">
            {report.resources} resources, {report.pairs.length} pairs.{' '}
            {report.reranker
              ? <>Decided by the reranker: shown at relevance ≥ {report.minRelevance}. Cosine (≥ {report.minSimilarity}) applies only if the reranker fails.</>
              : <>No reranker configured: shown at cosine ≥ {report.minSimilarity}.</>}
          </p>
          <div className="flex flex-col divide-y divide-gray-800 border border-gray-800 rounded">
            <div className="flex items-center gap-2 px-2 py-1.5 text-[11px] uppercase tracking-wide text-gray-500">
              <span className="flex-1">From → to</span>
              <span className="w-14 text-right">Cosine</span>
              {report.reranker && <span className="w-16 text-right">Reranker</span>}
            </div>
            {rows.map((p, i) => (
              <div key={i} className={`flex items-center gap-2 px-2 py-1.5 text-xs ${shown(p) ? 'text-gray-200' : 'text-gray-500'}`}>
                <span className="flex-1 min-w-0 break-words">
                  {shown(p) && <span className="text-emerald-400" title="Would be shown">● </span>}
                  {p.from.title} <span className="text-gray-600">→</span> {p.to.title}
                </span>
                <span className="w-14 text-right tabular-nums">{p.cosine.toFixed(3)}</span>
                {report.reranker && <span className="w-16 text-right tabular-nums">{p.relevance == null ? '–' : p.relevance.toFixed(3)}</span>}
              </div>
            ))}
          </div>
          {!showAll && report.pairs.length > INITIAL_ROWS && (
            <button onClick={() => setShowAll(true)} className="self-start text-xs text-blue-400 hover:underline">
              Show all {report.pairs.length}
            </button>
          )}
        </>
      )}
    </div>
  )
}
