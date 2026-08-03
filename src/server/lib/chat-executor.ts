import { streamText, type TextStreamPart, type ToolSet } from 'ai'
import { runResearcher } from './researcher.ts'
import { runWriter } from './writer.ts'
import { reformulateLLM } from './reformulate.ts'
import { db, chatSessions, messages, users, parseSettings, getAppSetting } from './db.ts'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { webSearch, webSearchMulti, type SearchResult, type SearchApiBudget } from './searxng.ts'
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
    const result = streamText({ model: getFlashModel(), system, messages: msgs, maxOutputTokens: 200 })
    for await (const part of result.stream) {
      if (part.type === 'text-delta') fullContent += part.text
    }
  } else {
    // Shared per-run allowance for paid keyed-API fallback searches (pre-search + researcher).
    const apiBudget: SearchApiBudget = { remaining: parseInt(process.env.SEARCH_API_MAX_PER_REQUEST ?? '3', 10) }

    // When RSS feed items are pre-fetched, skip web search and inject them directly
    const { initialQueries, initialResults } = feedItems?.length
      ? { initialQueries: ['latest news from selected RSS feeds'], initialResults: feedItems }
      : await reformulateAndSearch(promptText, focusMode, undefined, apiBudget)
    const [userRow, memoryBudget, ragBudget, fetchSummarize, compressHistory] = await Promise.all([
      db.select({ settings: users.settings }).from(users).where(eq(users.id, userId)).get(),
      spaceId ? getAppSetting('memory_token_budget', '1000').then(Number) : Promise.resolve(0),
      getAppSetting('space_rag_budget', '500').then(Number),
      getAppSetting('fetch_summarize_overflow', 'false').then(v => v === 'true'),
      getAppSetting('compress_history_overflow', 'false').then(v => v === 'true'),
    ])
    const parsedSettings = parseSettings(userRow?.settings ?? '{}')
    const customPrompt = parsedSettings.customPrompt as string | undefined
    const effectiveRag = (parsedSettings.useSpaceRag !== false) ? ragBudget : 0
    const { block: memoryBlock } = spaceId
      ? await buildMemoryBlock(spaceId, memoryBudget, effectiveRag, promptText)
      : { block: '' }

    if (focusMode === 'thorough') {
      const researcherResult = await runResearcher({
        messages: msgs, focusMode, userId, model: getChatModel(), abortSignal: AbortSignal.timeout(300_000),
        initialQueries, initialResults, customPrompt, hasFiles: false, spaceId, sessionId, memoryBlock, fetchSummarize, compressHistory, apiBudget,
      })
      let researcherNotes = ''
      const { sources: rs } = await collectStream(researcherResult, s => { researcherNotes += s })
      sources.push(...rs)

      const writerResult = runWriter(rs, msgs, researcherNotes.slice(0, RESEARCHER_NOTES_CAP), AbortSignal.timeout(300_000))
      const writerExtractor = new ThinkExtractor()
      for await (const part of writerResult.stream) {
        if (part.type === 'text-delta') {
          const { text } = writerExtractor.process(part.text)
          if (text) fullContent += text
        }
      }
      const { text: wt } = writerExtractor.flush()
      if (wt) fullContent += wt
    } else {
      sources.push(...(initialResults ?? []))
      const researcherResult = await runResearcher({
        messages: msgs, focusMode, userId, model: getChatModel(), abortSignal: AbortSignal.timeout(300_000),
        initialQueries, initialResults, customPrompt, hasFiles: false, spaceId, sessionId, memoryBlock, fetchSummarize, compressHistory,
        maxStepsOverride: 6, apiBudget,
      })
      const { text, sources: rs, finishReason } = await collectStream(researcherResult, () => {})
      fullContent = text
      sources.push(...rs)

      // Fallback: researcher exhausted all steps on tool calls (any accumulated text is preamble, not an answer)
      if (finishReason === 'tool-calls') {
        console.warn('  [monitor-executor] maxSteps exhausted without answer — running no-tool synthesis fallback')
        const resultsBlock = rs.length > 0
          ? '\n\nSearch results:\n' + rs.map((r, i) => {
              const idx = (r as SearchResult & { index?: number }).index ?? (i + 1)
              return `[${idx}] ${r.title}\n${r.url}\n${r.content.slice(0, 500)}`
            }).join('\n\n')
          : ''
        const fallback = streamText({
          model: getChatModel(),
          system: `Today's date is ${new Date().toISOString().split('T')[0]}. Synthesize the search results below into a direct answer with inline [N] citations using the index values shown. Do NOT say you lack internet access.${resultsBlock}${memoryBlock ? '\n\n' + memoryBlock : ''}`,
          messages: msgs,
          abortSignal: AbortSignal.timeout(120_000),
        })
        for await (const part of fallback.stream) {
          if (part.type === 'text-delta' && part.text) fullContent += part.text
        }
      }
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
  categories?: string,
  apiBudget?: SearchApiBudget,
): Promise<{ initialQueries?: string[]; initialResults?: SearchResult[] }> {
  try {
    const queryReformulation = await getAppSetting('query_reformulation', 'true').then(v => v === 'true')
    if (!queryReformulation) {
      const results = await webSearch(query, 6, categories, undefined, apiBudget)
      return { initialQueries: [query], initialResults: results }
    }
    const msgs = [{ role: 'user' as const, content: query }]
    const countEach = focusMode === 'thorough' ? 10 : 6
    const queries = await reformulateLLM(msgs, focusMode)
    if (queries.length === 0) return {}
    const maxQueries = focusMode === 'thorough' ? 3 : 2
    const results = await webSearchMulti(queries.slice(0, maxQueries), countEach, categories, undefined, apiBudget)
    return { initialQueries: queries, initialResults: results }
  } catch (e) {
    console.error('[monitor-reformulate]', e)
    return {}
  }
}

async function collectStream<TOOLS extends ToolSet>(
  researcherResult: { stream: AsyncIterable<TextStreamPart<TOOLS>> },
  onText: (text: string) => void,
): Promise<{ text: string; sources: SearchResult[]; finishReason: string }> {
  let text = ''
  let reasoning = ''
  let finishReason = 'unknown'
  const sources: SearchResult[] = []
  for await (const part of researcherResult.stream) {
    if (part.type === 'finish' || part.type === 'finish-step') {
      if (part.finishReason) finishReason = part.finishReason
    } else if (part.type === 'tool-result' && part.toolName === 'web_search') {
      // result may be a non-array "search unavailable" message when search is exhausted.
      if (Array.isArray(part.output)) sources.push(...(part.output as SearchResult[]))
    } else if (part.type === 'text-delta') {
      text += part.text
      onText(part.text)
    } else if (part.type === 'reasoning-delta') {
      reasoning += part.text
    }
  }
  // Fallback: if the model emitted only reasoning and no text, use the reasoning as content
  if (!text && reasoning) {
    text = reasoning
    onText(reasoning)
  }
  return { text, sources, finishReason }
}
