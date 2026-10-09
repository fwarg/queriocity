import { sqlite, getAppSetting, setAppSetting } from '../db.ts'

/** Links notes saved from answers before the chat of origin was recorded back to that chat, by
 *  matching the note's opening text against the user's own answers. */

const DONE_FLAG = 'note_origin_backfill_done'
/** Compared prefix; long enough to be unique, short enough to survive later edits further down. */
const KEY_CHARS = 200
/** Notes shorter than this say too little to match safely. */
const MIN_KEY_CHARS = 80

/** Text reduced to what survives turning an answer into a note: citation markers, link syntax,
 *  markdown punctuation and whitespace differences are dropped. */
export function answerKey(text: string): string {
  return text
    .split(/\n---\n/)[0]
    .replace(/\[\\?\[[^\]]*\\?\]\]\([^)]*\)/g, '')   // old-form `[\[1\]](url)` markers
    .replace(/\[(?:F|C)?\d+(?:,\s*\d+)*\]/g, '')     // [1], [1, 2], [F1]
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')         // [text](url) → text
    .replace(/[*_`#>|-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, KEY_CHARS)
}

/** One-off at startup (flagged once done): every note with no chat of origin whose opening matches
 *  exactly one of its owner's answers gets that chat and message. Returns how many were linked. */
export async function backfillNoteOrigins(): Promise<number> {
  if (await getAppSetting(DONE_FLAG, 'false') === 'true') return 0
  const notes = sqlite.query(`
    SELECT id, user_id AS userId, body FROM uploaded_files
    WHERE kind = 'note' AND origin_session_id IS NULL AND body IS NOT NULL
  `).all() as Array<{ id: string; userId: string; body: string }>
  let linked = 0
  for (const userId of new Set(notes.map(n => n.userId))) {
    const answers = answersByKey(userId)
    for (const note of notes.filter(n => n.userId === userId)) {
      const key = answerKey(note.body)
      if (key.length < MIN_KEY_CHARS) continue
      const match = answers.get(key)
      if (!match || match === 'ambiguous') continue
      sqlite.run('UPDATE uploaded_files SET origin_session_id = ?, origin_message_id = ? WHERE id = ?', [match.sessionId, match.messageId, note.id])
      linked++
    }
  }
  await setAppSetting(DONE_FLAG, 'true')
  if (linked) console.log(`  [notes] linked ${linked} older note(s) to the chat they were saved from`)
  return linked
}

/** The user's answers by key; a key two answers share is marked ambiguous and never matched. */
function answersByKey(userId: string): Map<string, { sessionId: string; messageId: string } | 'ambiguous'> {
  const rows = sqlite.query(`
    SELECT m.id AS messageId, m.session_id AS sessionId, m.content FROM messages m
    JOIN chat_sessions c ON c.id = m.session_id WHERE c.user_id = ? AND m.role = 'assistant'
  `).all(userId) as Array<{ messageId: string; sessionId: string; content: string }>
  const out = new Map<string, { sessionId: string; messageId: string } | 'ambiguous'>()
  for (const r of rows) {
    const key = answerKey(r.content)
    if (key.length < MIN_KEY_CHARS) continue
    out.set(key, out.has(key) ? 'ambiguous' : { sessionId: r.sessionId, messageId: r.messageId })
  }
  return out
}
