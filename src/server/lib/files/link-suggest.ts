import { generateText } from 'ai'
import { sqlite } from '../db.ts'
import { getSmallModel, SMALL_MODEL_INPUT_CHARS } from '../llm.ts'
import { relatedResources, type RelatedThresholds } from './related.ts'
import { addSeeAlso, saveNote } from './notes.ts'
import { wikilinkFor } from '../../../shared/wikilinks.ts'

/** AI-suggested links for a note. Candidates are its similar resources (embeddings, reranked and
 *  thresholded, as in "Similar content"); the small model then picks the ones worth linking and,
 *  where it can, the phrase in the note to link from — Zettelkasten-style, in context. Nothing is
 *  written until the user accepts; a dismissal is remembered. */

export interface LinkSuggestion {
  targetId: string
  title: string
  /** Exact text in the note to turn into the link; null means "add under See also". */
  phrase: string | null
  /** One short sentence on why, for the reviewer. */
  reason: string
}

const SYSTEM = `You help organise a personal knowledge base of linked notes.
Given a NOTE and numbered CANDIDATE notes, choose the candidates the note should link to: ones a reader of the note would genuinely want to follow. Skip loosely related ones.
For each chosen candidate give:
- "phrase": a short exact phrase copied verbatim from the NOTE text where the link belongs (2-6 words, no markdown), or "" when no phrase fits;
- "reason": one short sentence, in the note's language.
Respond with ONLY a JSON array: [{"n":1,"phrase":"...","reason":"..."}]. An empty array is a fine answer.`

/** Room for the note itself in the prompt; candidates take the rest. */
const NOTE_SHARE = 0.6

/** Suggestions for one of the user's notes, or [] when it has no plausible links. */
export async function suggestLinks(userId: string, noteId: string, thresholds: RelatedThresholds): Promise<LinkSuggestion[]> {
  const note = sqlite.query("SELECT filename AS title, body FROM uploaded_files WHERE id = ? AND user_id = ? AND kind = 'note'").get(noteId, userId) as { title: string; body: string } | null
  if (!note) throw new Error('Not found')
  const dismissed = new Set((sqlite.query('SELECT dst_id AS id FROM link_dismissals WHERE src_id = ?').all(noteId) as Array<{ id: string }>).map(r => r.id))
  const candidates = (await relatedResources(userId, noteId, thresholds)).related.filter(r => !r.linked && !dismissed.has(r.id))
  if (!candidates.length) return []

  const picked = await pickWithModel(note, candidates).catch(e => {
    console.warn(`  [links] suggestion model failed, offering similar content as is: ${e instanceof Error ? e.message : e}`)
    return null
  })
  // Without a usable model answer, the similar resources themselves are the suggestions.
  if (!picked) return candidates.map(c => ({ targetId: c.id, title: c.filename, phrase: null, reason: '' }))
  return picked.flatMap(p => {
    const c = candidates[p.n - 1]
    if (!c) return []
    const phrase = p.phrase && findPhrase(note.body, p.phrase) >= 0 ? p.phrase : null
    return [{ targetId: c.id, title: c.filename, phrase, reason: p.reason }]
  })
}

async function pickWithModel(note: { title: string; body: string }, candidates: Array<{ id: string; filename: string }>): Promise<Array<{ n: number; phrase: string; reason: string }>> {
  const summaries = candidates.map((c, i) => {
    const row = sqlite.query('SELECT summary FROM uploaded_files WHERE id = ?').get(c.id) as { summary: string | null } | null
    return `${i + 1}. ${c.filename}${row?.summary ? ` — ${row.summary}` : ''}`
  })
  const noteChars = Math.floor(SMALL_MODEL_INPUT_CHARS * NOTE_SHARE)
  const { text } = await generateText({
    model: getSmallModel(),
    system: SYSTEM,
    prompt: `NOTE: ${note.title}\n${note.body.slice(0, noteChars)}\n\nCANDIDATES:\n${summaries.join('\n')}`,
    maxOutputTokens: 600,
    abortSignal: AbortSignal.timeout(60_000),
  })
  const json = text.replace(/```(?:json)?/g, '').trim()
  const start = json.indexOf('[')
  if (start === -1) return []
  const parsed = JSON.parse(json.slice(start, json.lastIndexOf(']') + 1)) as Array<{ n?: unknown; phrase?: unknown; reason?: unknown }>
  return parsed.flatMap(p => typeof p.n === 'number'
    ? [{ n: p.n, phrase: typeof p.phrase === 'string' ? p.phrase.trim() : '', reason: typeof p.reason === 'string' ? p.reason.trim() : '' }]
    : [])
}

/** Where `phrase` occurs in the note's prose — not in code, an existing link or a heading — or -1.
 *  Exact case first, then any case. */
export function findPhrase(body: string, phrase: string): number {
  if (!phrase) return -1
  const blank = (m: string) => ' '.repeat(m.length)
  const prose = body
    .replace(/```[\s\S]*?```/g, blank)
    .replace(/`[^`\n]*`/g, blank)
    .replace(/\[\[[^\]]*\]\]/g, blank)
    .replace(/\[[^\]]*\]\([^)]*\)/g, blank)
    .replace(/^#{1,6} .*$/gm, blank)
  const exact = prose.indexOf(phrase)
  return exact >= 0 ? exact : prose.toLowerCase().indexOf(phrase.toLowerCase())
}

/** Writes an accepted suggestion: the phrase becomes `[[Title|phrase]]` (or `[[Title]]` when they
 *  match), or, with no phrase found, the link goes under `heading` ("See also"). */
export async function acceptLink(userId: string, noteId: string, targetId: string, phrase: string | null, heading: string): Promise<void> {
  const note = sqlite.query("SELECT filename AS title, body FROM uploaded_files WHERE id = ? AND user_id = ? AND kind = 'note'").get(noteId, userId) as { title: string; body: string } | null
  const target = sqlite.query('SELECT filename AS title FROM uploaded_files WHERE id = ? AND user_id = ?').get(targetId, userId) as { title: string } | null
  if (!note || !target) throw new Error('Not found')
  const at = phrase ? findPhrase(note.body, phrase) : -1
  if (at < 0) return addSeeAlso(userId, noteId, targetId, heading)
  const found = note.body.slice(at, at + phrase!.length)
  const link = found.toLowerCase() === target.title.trim().toLowerCase()
    ? wikilinkFor(target.title)
    : `${wikilinkFor(target.title).slice(0, -2)}|${found.replace(/[[\]|]/g, ' ')}]]`
  const body = note.body.slice(0, at) + link + note.body.slice(at + found.length)
  await saveNote(userId, { id: noteId, title: note.title, body }, { describe: false })
}

/** Remembers that the user does not want this link suggested again. */
export function dismissLink(userId: string, noteId: string, targetId: string): void {
  const owns = sqlite.query('SELECT COUNT(*) AS n FROM uploaded_files WHERE user_id = ? AND id IN (?, ?)').get(userId, noteId, targetId) as { n: number }
  if (owns.n < 2) throw new Error('Not found')
  sqlite.run('INSERT OR IGNORE INTO link_dismissals (src_id, dst_id) VALUES (?, ?)', [noteId, targetId])
}
