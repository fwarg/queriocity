import { streamText, type ToolSet } from 'ai'
import { runResearcher } from './researcher.ts'
import { runWriter } from './writer.ts'
import { reformulateLLM } from './reformulate.ts'
import { db, chatSessions, messages, users, parseSettings, getAppSetting } from './db.ts'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { webSearch, webSearchMulti, type SearchResult, type SearchApiBudget } from './searxng.ts'
import { getFlashModel, getChatModel } from './llm.ts'
import { buildMemoryBlock, extractMemoriesPostHoc, userMemoryBlockIfEnabled, joinMemoryBlocks } from './memory.ts'
import { ThinkExtractor } from './think-extractor.ts'
import { indexContents } from './chat-indexer.ts'
import { drainResearcherStream, nullStream, type ResearcherStreamPart } from './researcher-stream.ts'
import { rerankSearchResults } from './reranker.ts'
import { DEFAULT_MAX_URL_CONTEXT_CHARS } from './fetch-url.ts'
import { FLASH_SYSTEM, FLASH_MAX_TOKENS, RESEARCHER_NOTES_CAP, EMPTY_ANSWER_MESSAGE, runSynthesisFallback } from './answer.ts'

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
    const { block: scopedBlock } = spaceId ? await buildMemoryBlock(spaceId, memoryBudget, 0, promptText) : { block: '' }
    const memBlock = joinMemoryBlocks(
      await userMemoryBlockIfEnabled(userId, parsedSettings, promptText),
      scopedBlock,
    )
    const system = FLASH_SYSTEM
      + (customPrompt ? `\n\nAdditional instructions:\n${customPrompt}` : '')
      + (memBlock ? '\n\n' + memBlock : '')
    const result = streamText({ model: getFlashModel(), system, messages: msgs, maxOutputTokens: FLASH_MAX_TOKENS })
    // getFlashModel() is the full chat model unless FLASH_MODEL=small, so the same <think> markup
    // the other paths strip can appear here too.
    const flashExtractor = new ThinkExtractor()
    for await (const part of result.stream) {
      if (part.type === 'text-delta') fullContent += flashExtractor.process(part.text).text
    }
    fullContent += flashExtractor.flush().text
  } else {
    // Shared per-run allowance for paid keyed-API fallback searches (pre-search + researcher).
    const apiBudget: SearchApiBudget = { remaining: parseInt(process.env.SEARCH_API_MAX_PER_REQUEST ?? '3', 10) }

    // When RSS feed items are pre-fetched, skip web search and inject them directly
    const { initialQueries, initialResults } = feedItems?.length
      ? { initialQueries: ['latest news from selected RSS feeds'], initialResults: feedItems }
      : await reformulateAndSearch(promptText, focusMode, undefined, apiBudget)
    const [userRow, memoryBudget, ragBudget, urlContextChars, fetchSummarize, compressHistory] = await Promise.all([
      db.select({ settings: users.settings }).from(users).where(eq(users.id, userId)).get(),
      spaceId ? getAppSetting('memory_token_budget', '1000').then(Number) : Promise.resolve(0),
      getAppSetting('space_rag_budget', '500').then(Number),
      getAppSetting('fetch_max_url_context_chars', String(DEFAULT_MAX_URL_CONTEXT_CHARS)).then(Number),
      getAppSetting('fetch_summarize_overflow', 'false').then(v => v === 'true'),
      getAppSetting('compress_history_overflow', 'false').then(v => v === 'true'),
    ])
    const parsedSettings = parseSettings(userRow?.settings ?? '{}')
    const customPrompt = parsedSettings.customPrompt as string | undefined
    const effectiveRag = (parsedSettings.useSpaceRag !== false) ? ragBudget : 0
    const { block: scopedBlock } = spaceId
      ? await buildMemoryBlock(spaceId, memoryBudget, effectiveRag, promptText)
      : { block: '' }
    const memoryBlock = joinMemoryBlocks(
      await userMemoryBlockIfEnabled(userId, parsedSettings, promptText),
      scopedBlock,
    )

    if (focusMode === 'thorough') {
      const researcherResult = await runResearcher({
        messages: msgs, focusMode, userId, model: getChatModel(), abortSignal: AbortSignal.timeout(300_000),
        initialQueries, initialResults, customPrompt, hasFiles: false, spaceId, sessionId, memoryBlock, userMemoryEnabled: parsedSettings.userMemory === true, fetchSummarize, urlContextChars, compressHistory, apiBudget,
      })
      let researcherNotes = ''
      const { sources: rs } = await collectStream(researcherResult, s => { researcherNotes += s })
      sources.push(...rs)

      const writerResult = runWriter(rs, msgs, researcherNotes.slice(0, RESEARCHER_NOTES_CAP), AbortSignal.timeout(300_000), { customPrompt, memoryBlock })
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
        initialQueries, initialResults, customPrompt, hasFiles: false, spaceId, sessionId, memoryBlock, userMemoryEnabled: parsedSettings.userMemory === true, fetchSummarize, urlContextChars, compressHistory,
        maxStepsOverride: 6, apiBudget,
      })
      const { text, sources: rs, finishReason } = await collectStream(researcherResult, () => {})
      fullContent = text
      sources.push(...rs)

      // Same two failure shapes the route handles: the researcher spent its steps on tool calls
      // (any accumulated text is preamble, not an answer), or it produced only markup that the
      // extractor dropped. Either way there is nothing to save without this pass.
      if (finishReason === 'tool-calls' || !fullContent.trim()) {
        console.warn(`  [monitor-executor] no answer (finish=${finishReason}, ${fullContent.length} chars) — running no-tool synthesis fallback`)
        fullContent = ''
        const fallback = runSynthesisFallback({
          results: rs,
          messages: msgs,
          memoryBlock,
          abortSignal: AbortSignal.timeout(120_000),
        })
        const fallbackExtractor = new ThinkExtractor()
        for await (const part of fallback.stream) {
          if (part.type === 'text-delta' && part.text) fullContent += fallbackExtractor.process(part.text).text
        }
        fullContent += fallbackExtractor.flush().text
      }
    }
  }

  // Nothing survived. Save the failure rather than an empty assistant message, which reads in the
  // monitor UI as a run that succeeded and found nothing to say.
  if (!fullContent.trim()) {
    console.error('  [monitor-executor] empty answer after fallback — saving failure notice')
    fullContent = EMPTY_ANSWER_MESSAGE
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
    // reformulateLLM caps the list for the mode (and may add the raw query as a safety net), so
    // it is used as returned — slicing here again would drop that safety net.
    const queries = await reformulateLLM(msgs, focusMode)
    if (queries.length === 0) return {}
    const results = await webSearchMulti(queries, countEach, categories, undefined, apiBudget)
    return { initialQueries: queries, initialResults: await rerankSearchResults(query, results) }
  } catch (e) {
    console.error('[monitor-reformulate]', e)
    return {}
  }
}

/** Non-interactive counterpart of the route's drain: same extraction, no client attached.
 *  Delegates rather than reimplementing — the private copy this replaced had no ThinkExtractor,
 *  so monitor answers were saved with <think> and <tool_call> markup intact. */
async function collectStream<TOOLS extends ToolSet>(
  researcherResult: { stream: AsyncIterable<ResearcherStreamPart<TOOLS>> },
  onText: (text: string) => void,
): Promise<{ text: string; sources: SearchResult[]; finishReason: string }> {
  let text = ''
  const sources: SearchResult[] = []
  const finishReason = await drainResearcherStream(researcherResult, {
    stream: nullStream,
    showThinking: false,
    emitSearchStatus: () => {},
    extractor: new ThinkExtractor(),
    onText: (t) => { text += t; onText(t) },
    onSources: (results) => { sources.push(...results) },
  })
  return { text, sources, finishReason }
}
