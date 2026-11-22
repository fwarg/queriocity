/** Scoring for scripts/research-eval.ts: runs the real turn pipeline headless over questions with
 *  known answers. Kept apart from the script so the scoring is testable without a model.
 *
 *  Correctness has two measures, reported side by side because each fails differently: `contains`
 *  (the reference or an alias appears in the answer) misses paraphrase and passes "not 1967"; the
 *  judge reads meaning but is a model, with a model's errors. */

import { generateText } from 'ai'
import { splitGroupedCitations } from '../../shared/citations.ts'
import { getChatModel } from './llm.ts'
import type { ResearchTrace } from './feedback.ts'
import type { ProgressStep } from './progress.ts'

export interface EvalItem {
  id: string
  question: string
  answer: string
  aliases?: string[]
  /** Free-form group (`control`, `lookup`, `multihop`…), reported separately: skills that help one
   *  kind of question may hurt another. */
  category?: string
}

export interface ItemScore {
  id: string
  category?: string
  run: number
  contains: boolean
  /** Null when the judge failed or gave no verdict. */
  judge: boolean | null
  citations: number
  /** Citations whose number has a source behind it. */
  validCitations: number
  sources: number
  searchQueries: number
  pagesRead: number
  elapsedMs: number
  error?: string
}

/** Parses the questions file: one JSON object per line; blank lines and `//` comments skipped. */
export function parseEvalItems(text: string): EvalItem[] {
  return text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('//')).map((line, i) => {
    const item = JSON.parse(line) as EvalItem
    if (!item.id || !item.question || !item.answer) throw new Error(`line ${i + 1}: id, question and answer are required`)
    return item
  })
}

const normalize = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/** Whether the reference answer or one of its aliases appears in the answer, as whole words. */
export function containsAnswer(answer: string, item: EvalItem): boolean {
  const text = ` ${normalize(answer)} `
  return [item.answer, ...item.aliases ?? []].some(ref => normalize(ref) && text.includes(` ${normalize(ref)} `))
}

/** Citation markers in the answer, and how many point at a source that exists. */
export function citationStats(answer: string, sourceCount: number): { citations: number; validCitations: number } {
  const numbers = [...splitGroupedCitations(answer).matchAll(/\[(\d+)\]/g)].map(m => Number(m[1]))
  return { citations: numbers.length, validCitations: numbers.filter(n => n >= 1 && n <= sourceCount).length }
}

/** Search queries run and pages read, from the trace's progress steps. */
export function traceStats(trace: ResearchTrace): { searchQueries: number; pagesRead: number } {
  let searchQueries = 0
  let pagesRead = 0
  for (const e of trace.entries) {
    // Narrowed by hand: the event variant's index signature also admits a `step` key.
    const step = 'step' in e ? e.step as ProgressStep : undefined
    if (!step || step.update) continue
    if (step.kind === 'search') searchQueries += step.queries?.length ?? 0
    if (step.kind === 'read') pagesRead += step.hosts?.length ?? 0
  }
  return { searchQueries, pagesRead }
}

const JUDGE_SYSTEM = `You grade answers against a reference. Reply with exactly one word: CORRECT if the candidate answer states the reference answer (paraphrase, extra detail and other units are fine), INCORRECT if it gives a different answer, hedges between several, or does not answer.`

/** The chat model's verdict on the answer; null when it fails or gives none. */
export async function judgeAnswer(item: EvalItem, answer: string): Promise<boolean | null> {
  try {
    const { text } = await generateText({
      model: getChatModel(),
      system: JUDGE_SYSTEM,
      prompt: `Question: ${item.question}\nReference answer: ${item.answer}\n\nCandidate answer:\n${answer.slice(0, 6000)}`,
    })
    // The last verdict word: a reasoning model may say both while thinking aloud.
    const verdict = [...text.toUpperCase().matchAll(/\b(INCORRECT|CORRECT)\b/g)].pop()?.[1]
    return verdict ? verdict === 'CORRECT' : null
  } catch {
    return null
  }
}

export interface EvalSummary {
  items: number
  judgeAccuracy: number | null
  containsAccuracy: number
  citationValidity: number | null
  meanSearchQueries: number
  meanPagesRead: number
  meanElapsedMs: number
  errors: number
}

const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0

/** Averages over scores; the judge's accuracy counts only items it gave a verdict on. */
export function summarize(scores: ItemScore[]): EvalSummary {
  const judged = scores.filter(s => s.judge !== null)
  const cited = scores.reduce((n, s) => n + s.citations, 0)
  return {
    items: scores.length,
    judgeAccuracy: judged.length ? mean(judged.map(s => s.judge ? 1 : 0)) : null,
    containsAccuracy: mean(scores.map(s => s.contains ? 1 : 0)),
    citationValidity: cited ? scores.reduce((n, s) => n + s.validCitations, 0) / cited : null,
    meanSearchQueries: mean(scores.map(s => s.searchQueries)),
    meanPagesRead: mean(scores.map(s => s.pagesRead)),
    meanElapsedMs: mean(scores.map(s => s.elapsedMs)),
    errors: scores.filter(s => s.error).length,
  }
}

/** Summaries overall, per category and per run — per run shows the run-to-run noise. */
export function breakdown(scores: ItemScore[]) {
  const by = (key: (s: ItemScore) => string) => {
    const groups = new Map<string, ItemScore[]>()
    for (const s of scores) groups.set(key(s), [...groups.get(key(s)) ?? [], s])
    return Object.fromEntries([...groups].map(([k, v]) => [k, summarize(v)]))
  }
  return { overall: summarize(scores), byCategory: by(s => s.category ?? 'none'), byRun: by(s => String(s.run)) }
}
