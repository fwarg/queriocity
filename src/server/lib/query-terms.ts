/** Shared query-comparison helpers, used to suppress redundant searches (researcher.ts) and to
 *  judge whether a reformulated query still resembles what the user asked (reformulate.ts). */

// Jaccard overlap above which two queries are treated as the same search. Balanced gets only two
// tool rounds, so a query that merely rephrases one already run costs a quarter of the mode's
// entire search budget. Tuned high deliberately: suppressing a genuine refinement is worse than
// allowing a near-duplicate, so this only catches queries that are substantively the same.
export const QUERY_DUPLICATE_THRESHOLD = parseFloat(process.env.QUERY_DUPLICATE_THRESHOLD ?? '0.8')

// Ignored when comparing queries: they carry no topical signal, so two queries differing only in
// stopwords are the same search. Kept deliberately short — a long list starts eating real terms.
const QUERY_STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'in', 'on', 'to', 'for', 'is', 'are', 'was', 'were',
  'what', 'how', 'why', 'did', 'do', 'does', 'happened', 'it', 'its',
])

/** Content words of a query, lowercased and stripped of punctuation, for overlap comparison. */
export function queryTerms(query: string): Set<string> {
  return new Set(
    query.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)
      .filter(w => w.length > 1 && !QUERY_STOPWORDS.has(w)),
  )
}

/** Jaccard similarity of two queries' content words. 1 = same terms, 0 = nothing in common. */
export function querySimilarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const t of a) if (b.has(t)) shared++
  return shared / (a.size + b.size - shared)
}

/** True when the query splits a word from `reference` across a space — the small model turning
 *  "DOGE" into "do ge", which searches as two meaningless tokens and was observed in production.
 *  Requires that neither half stands on its own in the reference, so genuine compounds
 *  ("healthcare" → "health care") are not flagged. */
export function hasMangledToken(query: string, reference: string): boolean {
  const refTerms = queryTerms(reference)
  const words = query.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean)
  for (let i = 0; i < words.length - 1; i++) {
    const [a, b] = [words[i], words[i + 1]]
    if (refTerms.has(a + b) && !refTerms.has(a) && !refTerms.has(b)) return true
  }
  return false
}
