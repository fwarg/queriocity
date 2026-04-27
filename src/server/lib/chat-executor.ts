import { streamText } from 'ai'
import { runResearcher } from './researcher.ts'
import { runWriter } from './writer.ts'
import { reformulateLLM } from './reformulate.ts'
import { db, chatSessions, messages, users, parseSettings, getAppSetting } from './db.ts'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { webSearch, webSearchMulti, type SearchResult } from './searxng.ts'
import { getFlashModel, getChatModel } from './llm.ts'
import { buildMemoryBlock, extractMemoriesPostHoc } from './memory.ts'
import { ThinkExtractor } from './think-extractor.ts'
import { indexContents } from './chat-indexer.ts'

const FLASH_SYSTEM = `Answer in at most 5 sentences using only your training knowledge. Be direct and factual.
Do not search the web. If you cannot answer confidently, say so briefly.
Always respond in the same language the user used.`

const RESEARCHER_NOTES_CAP = 12000

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
  focusMode: 'flash' | 'balanced' | 'thorough'
  spaceId?: string
  feedItems?: SearchResult[]
}): Promise<void> {
  const msgs = [{ role: 'user' as const, content: promptText }]
  const now = new Date()

  await db.insert(chatSessions)
    .values({ id: sessionId, title, createdAt: now, updatedAt: now, userId, spaceId: spaceId ?? null })
    .onConflictDoUpdate({ target: chatSessions.id, set: { updatedAt: now } })
  await db.insert(messages).values({ id: randomUUID(), sessionId, role: 'user', content: promptText, createdAt: now })

  let fullContent = ''
  const sources: SearchResult[] = []

  if (focusMode === 'flash') {
    const [userRow, memoryBudget] = await Promise.all([
      db.select({ settings: users.settings }).from(users).where(eq(users.id, userId)).get(),
      spaceId ? getAppSetting('memory_token_budget', '1000').then(Number) : Promise.resolve(0),
    ])
    const parsedSettings = parseSettings(userRow?.settings ?? '{}')
    const customPrompt = parsedSettings.customPrompt as string | undefined
    const { block: memBlock } = spaceId ? await buildMemoryBlock(spaceId, memoryBudget, 0, promptText) : { block: '' }
    const system = FLASH_SYSTEM
      + (customPrompt ? `\n\nAdditional instructions:\n${customPrompt}` : '')
      + (memBlock ? '\n\n' + memBlock : '')
    const result = streamText({ model: getFlashModel(), system, messages: msgs, maxTokens: 200 })
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') fullContent += part.textDelta
    }
  } else {
    // When RSS feed items are pre-fetched, skip web search and inject them directly
    const { initialQueries, initialResults } = feedItems?.length
      ? { initialQueries: ['latest news from selected RSS feeds'], initialResults: feedItems }
      : await reformulateAndSearch(promptText, focusMode)
    const [userRow, memoryBudget, ragBudget] = await Promise.all([
      db.select({ settings: users.settings }).from(users).where(eq(users.id, userId)).get(),
      spaceId ? getAppSetting('memory_token_budget', '1000').then(Number) : Promise.resolve(0),
      getAppSetting('space_rag_budget', '500').then(Number),
    ])
    const parsedSettings = parseSettings(userRow?.settings ?? '{}')
    const customPrompt = parsedSettings.customPrompt as string | undefined
    const effectiveRag = (parsedSettings.useSpaceRag !== false) ? ragBudget : 0
    const { block: memoryBlock } = spaceId
      ? await buildMemoryBlock(spaceId, memoryBudget, effectiveRag, promptText)
      : { block: '' }

    if (focusMode === 'thorough') {
      const researcherResult = runResearcher({
        messages: msgs, focusMode, userId, model: getChatModel(), abortSignal: AbortSignal.timeout(300_000),
        initialQueries, initialResults, customPrompt, hasFiles: false, spaceId, sessionId, memoryBlock,
      })
      let researcherNotes = ''
      const { sources: rs } = await collectStream(researcherResult, s => { researcherNotes += s })
      sources.push(...rs)

      const writerResult = runWriter(rs, msgs, researcherNotes.slice(0, RESEARCHER_NOTES_CAP), AbortSignal.timeout(300_000))
      const writerExtractor = new ThinkExtractor()
      for await (const part of writerResult.fullStream) {
        if (part.type === 'text-delta') {
          const { text } = writerExtractor.process(part.textDelta)
          if (text) fullContent += text
        }
      }
      const { text: wt } = writerExtractor.flush()
      if (wt) fullContent += wt
    } else {
      sources.push(...(initialResults ?? []))
      const researcherResult = runResearcher({
        messages: msgs, focusMode, userId, model: getChatModel(), abortSignal: AbortSignal.timeout(300_000),
        initialQueries, initialResults, customPrompt, hasFiles: false, spaceId, sessionId, memoryBlock,
        maxStepsOverride: 6,
      })
      const { text, sources: rs } = await collectStream(researcherResult, () => {})
      fullContent = text
      sources.push(...rs)
    }
  }

  const savedAt = new Date()
  await db.insert(messages).values({
    id: randomUUID(), sessionId, role: 'assistant', content: fullContent,
    sources: JSON.stringify(sources.map(s => ({ title: s.title, url: s.url }))),
    createdAt: savedAt,
  })
  await db.update(chatSessions).set({ updatedAt: savedAt }).where(eq(chatSessions.id, sessionId))

  if (spaceId && fullContent) {
    extractMemoriesPostHoc(spaceId, sessionId, promptText, fullContent).catch(e => console.error('[monitor-memory]', e))
    indexContents(sessionId, [promptText, fullContent]).catch(e => console.error('[monitor-index]', e))
  }
}

async function reformulateAndSearch(
  query: string,
  focusMode: 'balanced' | 'thorough',
): Promise<{ initialQueries?: string[]; initialResults?: SearchResult[] }> {
  try {
    const queryReformulation = await getAppSetting('query_reformulation', 'true').then(v => v === 'true')
    if (!queryReformulation) {
      const results = await webSearch(query, 6)
      return { initialQueries: [query], initialResults: results }
    }
    const msgs = [{ role: 'user' as const, content: query }]
    const countEach = focusMode === 'thorough' ? 10 : 6
    const queries = await reformulateLLM(msgs, focusMode)
    if (queries.length === 0) return {}
    const maxQueries = focusMode === 'thorough' ? 3 : 2
    const results = await webSearchMulti(queries.slice(0, maxQueries), countEach)
    return { initialQueries: queries, initialResults: results }
  } catch (e) {
    console.error('[monitor-reformulate]', e)
    return {}
  }
}

async function collectStream(
  researcherResult: { fullStream: AsyncIterable<unknown> },
  onText: (text: string) => void,
): Promise<{ text: string; sources: SearchResult[] }> {
  let text = ''
  let reasoning = ''
  const sources: SearchResult[] = []
  for await (const _part of researcherResult.fullStream) {
    const part = _part as { type: string; toolName?: string; result?: unknown; textDelta?: string }
    if (part.type === 'tool-result' && part.toolName === 'web_search') {
      sources.push(...(part.result ?? []) as SearchResult[])
    } else if (part.type === 'text-delta') {
      text += part.textDelta ?? ''
      onText(part.textDelta ?? '')
    } else if (part.type === 'reasoning') {
      reasoning += part.textDelta ?? ''
    }
  }
  // Fallback: if the model emitted only reasoning and no text, use the reasoning as content
  if (!text && reasoning) {
    text = reasoning
    onText(reasoning)
  }
  return { text, sources }
}
