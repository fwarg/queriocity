#!/usr/bin/env bun
/**
 * Research eval: runs the real turn pipeline (pre-search, researcher, writer) headless over
 * questions with known answers, and scores correctness, citation validity and search effort.
 *
 * Usage: bun run scripts/research-eval.ts [--file F] [--mode balanced|thorough] [--runs N]
 *          [--ids a,b] [--category C] [--out DIR] [--db PATH] [--timeout SECONDS]
 *
 * Models and search come from the same environment the server uses (.env). The database is an
 * empty in-memory one unless --db is given, so admin search settings are at their defaults; to
 * measure with your own, pass --db a *copy* of the production database — it is migrated in place.
 *
 * Writes DIR/report.json (scores and summaries) and DIR/traces/<run>-<id>.json, in the same shape
 * as the traces answer feedback stores (lib/feedback.ts). Run twice before trusting a difference:
 * the per-run summaries show how much the score moves on its own.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { parseArgs } from 'util'
import { randomUUID } from 'crypto'

const { values: args } = parseArgs({
  options: {
    file: { type: 'string', default: 'scripts/eval/research-questions.jsonl' },
    mode: { type: 'string', default: 'balanced' },
    runs: { type: 'string', default: '1' },
    ids: { type: 'string' },
    category: { type: 'string' },
    out: { type: 'string', default: join('eval-results', new Date().toISOString().replace(/[:.]/g, '-')) },
    db: { type: 'string' },
    timeout: { type: 'string', default: '600' },
  },
})
if (args.mode !== 'balanced' && args.mode !== 'thorough') throw new Error('--mode must be balanced or thorough')
const focusMode = args.mode

// Before anything that reaches lib/db.ts, which opens DB_PATH on import.
process.env.DB_PATH = args.db ?? ':memory:'
const { runTurn, createSink } = await import('../src/server/lib/turn/index.ts')
const { nullStream } = await import('../src/server/lib/researcher-stream.ts')
const { localTurnModels } = await import('../src/server/lib/llm.ts')
const { TraceRecorder } = await import('../src/server/lib/feedback.ts')
const { EMPTY_ANSWER_MESSAGE } = await import('../src/server/lib/answer.ts')
const { parseEvalItems, containsAnswer, citationStats, traceStats, judgeAnswer, breakdown } = await import('../src/server/lib/research-eval.ts')
type EvalItem = import('../src/server/lib/research-eval.ts').EvalItem
type ItemScore = import('../src/server/lib/research-eval.ts').ItemScore

const ids = args.ids ? new Set(args.ids.split(',')) : null
const items = parseEvalItems(readFileSync(args.file!, 'utf8'))
  .filter(i => (!ids || ids.has(i.id)) && (!args.category || i.category === args.category))
const runs = Math.max(1, parseInt(args.runs!, 10) || 1)
mkdirSync(join(args.out!, 'traces'), { recursive: true })

/** One question through the pipeline, as a first message in a new chat. */
async function evaluate(item: EvalItem, run: number): Promise<ItemScore> {
  const recorder = new TraceRecorder({ question: item.question, priorMessages: 0, focusMode })
  const base = { id: item.id, category: item.category, run }
  try {
    const result = await runTurn({
      userId: 'eval', sid: randomUUID(), msgs: [{ role: 'user', content: item.question }], pinned: new Set(),
      models: localTurnModels(), focusMode, locked: false, settings: {}, collections: [],
      abortSignal: AbortSignal.timeout(parseInt(args.timeout!, 10) * 1000),
    }, recorder.wrap(createSink(nullStream)))
    const trace = recorder.toTrace(result.content)
    writeFileSync(join(args.out!, 'traces', `${run}-${item.id}.json`), JSON.stringify(trace, null, 2))
    // The pipeline reports its own failure as this text; scoring it would count an outage as a wrong answer.
    if (result.content === EMPTY_ANSWER_MESSAGE) throw new Error('the turn produced no answer (model unreachable or failing?)')
    return {
      ...base,
      contains: containsAnswer(result.content, item),
      judge: await judgeAnswer(item, result.content),
      ...citationStats(result.content, result.sources.length),
      sources: result.sources.length,
      ...traceStats(trace),
      elapsedMs: trace.elapsedMs,
    }
  } catch (e) {
    return { ...base, contains: false, judge: null, citations: 0, validCitations: 0, sources: 0, searchQueries: 0, pagesRead: 0, elapsedMs: 0, error: String(e) }
  }
}

const scores: ItemScore[] = []
for (let run = 1; run <= runs; run++) {
  for (const item of items) {
    const s = await evaluate(item, run)
    scores.push(s)
    const verdict = s.error ? `ERROR ${s.error}` : `judge=${s.judge ?? '?'} contains=${s.contains} cites=${s.validCitations}/${s.citations} searches=${s.searchQueries} ${Math.round(s.elapsedMs / 1000)}s`
    console.log(`[run ${run}] ${item.id}: ${verdict}`)
  }
}

const report = { mode: focusMode, file: args.file, runs, db: process.env.DB_PATH, scores, ...breakdown(scores) }
writeFileSync(join(args.out!, 'report.json'), JSON.stringify(report, null, 2))
console.log('\nOverall:', report.overall)
console.log('By category:', report.byCategory)
if (runs > 1) console.log('By run:', report.byRun)
console.log(`\nReport: ${join(args.out!, 'report.json')}`)
process.exit(0)
