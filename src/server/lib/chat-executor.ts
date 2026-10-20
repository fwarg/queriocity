import { db, chatSessions, messages, users, parseSettings } from './db.ts'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import type { SearchResult } from './search/index.ts'
import { localTurnModels } from './llm.ts'
import { extractMemoriesPostHoc, toMemorySources } from './memory/index.ts'
import { CitationNormalizer } from './citation-normalizer.ts'
import { indexContents } from './chat-indexer.ts'
import { nullStream } from './researcher-stream.ts'
import { EMPTY_ANSWER_MESSAGE } from './answer.ts'
import { runTurn, createSink, type TurnContext } from './turn/index.ts'
import { defaultAnswerModel } from './cloud-models.ts'

/** Flash is not offered: it never searches, so a fixed prompt on a schedule would repeat itself. */
export const MONITOR_MODES = ['balanced', 'thorough'] as const
export type MonitorMode = typeof MONITOR_MODES[number]

const MONITOR_TIMEOUT_MS = 300_000
const MONITOR_MAX_STEPS = 6

/** Run a single-message chat non-interactively and save the session to DB. */
export async function executeChatAndSave({
  sessionId,
  userId,
  title,
  promptText,
  focusMode,
  spaceId,
  feedItems,
}: {
  sessionId: string
  userId: string
  title: string
  promptText: string
  focusMode: MonitorMode
  spaceId?: string
  feedItems?: SearchResult[]
}): Promise<void> {
  const msgs = [{ role: 'user' as const, content: promptText }]
  const now = new Date()

  await db.insert(chatSessions)
    .values({ id: sessionId, title, createdAt: now, updatedAt: now, userId, spaceId: spaceId ?? null })
    .onConflictDoUpdate({ target: chatSessions.id, set: { updatedAt: now } })
  await db.insert(messages).values({ id: randomUUID(), sessionId, role: 'user', content: promptText, createdAt: now })

  const userRow = await db.select({ settings: users.settings }).from(users).where(eq(users.id, userId)).get()
  const settings = parseSettings(userRow?.settings ?? '{}')
  // Monitors always run on the local models, whatever the user may pick for interactive chats,
  // and thorough monitors stay on the chat model rather than the thinking one.
  const models = localTurnModels()
  const ctx: TurnContext = {
    userId, sid: sessionId, msgs, pinned: new Set(), focusMode, spaceId, locked: false,
    models: { ...models, thinking: models.chat },
    settings, customPrompt: settings.customPrompt as string | undefined, collections: [],
    abortSignal: AbortSignal.timeout(MONITOR_TIMEOUT_MS),
    monitor: { feedItems, maxStepsOverride: focusMode === 'balanced' ? MONITOR_MAX_STEPS : undefined },
  }
  // No client and no approval prompt: the researcher refuses any outbound request the egress guard flags.
  const result = await runTurn(ctx, createSink(nullStream))

  // Normalised again as a final pass: it also strips any trailing reference list the model added
  // against instructions, and is idempotent over text the turn already normalised.
  const normalizer = new CitationNormalizer()
  let fullContent = normalizer.process(result.content) + normalizer.flush()

  // Nothing survived. Save the failure rather than an empty assistant message, which reads in the
  // monitor UI as a run that succeeded and found nothing to say.
  if (!fullContent.trim()) {
    console.error('  [monitor-executor] empty answer after fallback — saving failure notice')
    fullContent = EMPTY_ANSWER_MESSAGE
  }

  const savedAt = new Date()
  await db.insert(messages).values({
    id: randomUUID(), sessionId, role: 'assistant', content: fullContent,
    sources: JSON.stringify(result.sources),
    // Monitors always answer on the default chat model.
    model: JSON.stringify(defaultAnswerModel(models.chat)),
    createdAt: savedAt,
  })
  await db.update(chatSessions).set({ updatedAt: savedAt }).where(eq(chatSessions.id, sessionId))

  if (spaceId && fullContent) {
    extractMemoriesPostHoc(spaceId, sessionId, promptText, fullContent, toMemorySources(result.sources)).catch(e => console.error('[monitor-memory]', e))
    indexContents(sessionId, [promptText, fullContent]).catch(e => console.error('[monitor-index]', e))
  }
}
