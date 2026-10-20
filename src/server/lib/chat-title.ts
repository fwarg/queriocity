import { generateText } from 'ai'
import { sqlite, getAppSettingSync } from './db.ts'
import { getSmallModel } from './llm.ts'

/** Chat titles: built from the first question and what the chat reads, at no cost; then, only when
 *  that title is weak, replaced by the small model's from the first exchange (`refineChatTitle`). */

export const SESSION_TITLE_MAX = 60
/** Room kept for the question when a scope prefixes it. */
const SCOPE_MAX = 30
/** Fewer words than this and a question says too little to name the chat. */
const MIN_WORDS = 3
/** What the small model reads of the first question and answer. */
const EXCERPT_CHARS = 1500

/** Openings that say nothing about the topic, English and Swedish. */
const FILLER = /^(please|can you|could you|would you|i want( you)? to|i'd like( you)? to|help me( to)?|kan du|skulle du kunna|jag vill( att du)?|snälla)[\s,]+/i

export interface TitleScope {
  documentIds: string[]
  collections: string[]
  attachedFileIds?: string[]
  recipeName?: string
}

/** `scope`: what prefixes the title, kept by the refined one; null when no refinement is due. */
export interface InitialTitle { title: string; scope: string | null }

/** The question as typed: attached text (after `---\n[`) removed, filler openings stripped, one line. */
export function questionOf(content: string): string {
  let q = content.split(/\n\n---\n\[/)[0].replace(/\s+/g, ' ').trim()
  for (let prev = ''; prev !== q;) { prev = q; q = q.replace(FILLER, '') }
  return q.charAt(0).toUpperCase() + q.slice(1)
}

/** `text` cut at a word boundary to `max` characters, with an ellipsis when cut. */
export function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return (space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:–-]+$/, '') + '…'
}

const titlesOf = (table: 'spaces' | 'uploaded_files', column: 'name' | 'filename', ids: string[]): string[] =>
  ids.flatMap(id => {
    const row = sqlite.query(`SELECT ${column} AS t FROM ${table} WHERE id = ?`).get(id) as { t: string } | null
    return row ? [row.t] : []
  })

const named = (names: string[]) => names.length > 2 ? `${names[0]} +${names.length - 1}` : names.join(', ')

/** What the chat reads, named: its document, its collections, its recipe — or, for a question too
 *  short to say much ("Summarise this"), the first attached resource. Ids are already owner-checked. */
function scopeLabel(scope: TitleScope, shortQuestion: boolean): string {
  const documents = titlesOf('uploaded_files', 'filename', scope.documentIds)
  if (documents.length) return named(documents)
  const collections = titlesOf('spaces', 'name', scope.collections)
  if (collections.length) return named(collections)
  if (scope.recipeName) return scope.recipeName
  return shortQuestion ? titlesOf('uploaded_files', 'filename', (scope.attachedFileIds ?? []).slice(0, 1))[0] ?? '' : ''
}

/** The title a new chat starts with. Weak — cut short, or a question of a few words — it is marked for
 *  the small model to replace, unless the admin turned that off. */
export function initialChatTitle(content: string, scope: TitleScope): InitialTitle {
  const question = questionOf(content)
  const short = question.split(' ').filter(Boolean).length < MIN_WORDS
  const label = cutAtWord(scopeLabel(scope, short), SCOPE_MAX)
  const room = SESSION_TITLE_MAX - (label ? label.length + 2 : 0)
  const body = cutAtWord(question, room)
  const title = label && body ? `${label}: ${body}` : label || body || 'Chat'
  const weak = question.length > room || short
  return { title, scope: weak && getAppSettingSync('chat_title_model', 'true') === 'true' ? label : null }
}

/** The model's reply as a title: first line, without quotes, markup, a "Title:" label or a final stop. */
export function cleanTitle(raw: string): string {
  return (raw.trim().split('\n')[0] ?? '')
    .replace(/^(title|titel)\s*:\s*/i, '')
    .replace(/^[\s"'“”‘’«»*#_`]+|[\s"'“”‘’«»*_`.]+$/g, '')
    .trim()
}

/** Output: the title alone; cleanTitle takes the first line and strips quotes, "Title:" and a final full stop. */
const TITLE_SYSTEM = `Write a title for a chat, from its first question and the start of its answer. At most 8 words, naming the topic, in the language of the question. No quotes, no final full stop, nothing else.`

/** Replaces a weak title with the small model's, once: the mark is cleared before the call, so a
 *  repeated request does nothing. A title the user renamed meanwhile is kept. Returns the title now. */
export async function refineChatTitle(sessionId: string, userId: string): Promise<string | null> {
  // Read, then cleared on the same condition: RETURNING would give the cleared scope.
  const marked = sqlite.query('SELECT title, auto_title_scope AS scope FROM chat_sessions WHERE id = ? AND user_id = ? AND auto_title_scope IS NOT NULL')
    .get(sessionId, userId) as { title: string; scope: string } | null
  const claimed = marked && sqlite.run('UPDATE chat_sessions SET auto_title_scope = NULL WHERE id = ? AND auto_title_scope IS NOT NULL', [sessionId]).changes ? marked : null
  const current = () => (sqlite.query('SELECT title FROM chat_sessions WHERE id = ? AND user_id = ?').get(sessionId, userId) as { title: string } | null)?.title ?? null
  if (!claimed) return current()
  const first = (role: string) => (sqlite.query('SELECT content FROM messages WHERE session_id = ? AND role = ? ORDER BY created_at LIMIT 1')
    .get(sessionId, role) as { content: string } | null)?.content ?? ''
  try {
    const { text } = await generateText({
      model: getSmallModel(),
      system: TITLE_SYSTEM,
      prompt: `Question: ${questionOf(first('user')).slice(0, EXCERPT_CHARS)}\n\nAnswer: ${first('assistant').slice(0, EXCERPT_CHARS)}`,
      maxOutputTokens: 40,
      abortSignal: AbortSignal.timeout(20_000),
    })
    const topic = cleanTitle(text)
    if (!topic) return claimed.title
    const room = SESSION_TITLE_MAX - (claimed.scope ? claimed.scope.length + 2 : 0)
    const title = (claimed.scope ? `${claimed.scope}: ` : '') + cutAtWord(topic, room)
    sqlite.run('UPDATE chat_sessions SET title = ? WHERE id = ? AND title = ?', [title, sessionId, claimed.title])
    console.log(`  [title] ${JSON.stringify(claimed.title)} → ${JSON.stringify(title)}`)
  } catch (e) {
    console.error('  [title] failed:', e)
  }
  return current()
}
