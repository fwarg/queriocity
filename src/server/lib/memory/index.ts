/** Space and user memory: what is remembered, how it is recalled into a turn, and how it is kept small.
 *  Importers use this module; the files beside it are split by concern. */
export { type MemorySource, type RankableSource, type MemoryFact, MEMORY_MAX_SOURCES, toMemorySources, pickFallbackSources, retroExtractionInputs, mapFactCitations } from './sources.ts'
export { buildChatFileBlock, buildNotesBlock, buildCollectionBlock } from './context-blocks.ts'
export { type SpaceMemory, getSpaceMemories, embedMemory, deleteMemoryEmbeddings } from './store.ts'
export { type HistoryHit, searchSpaceHistory, type MemoryCandidate, selectMemories, type MemoryBlock, buildMemoryBlock, joinMemoryBlocks } from './recall.ts'
export { getUserMemories, saveUserMemory, deleteUserMemory, buildUserMemoryBlock, isSensitiveFact, isDurableUserFact, suggestUserMemories, userMemoryBlockIfEnabled } from './user.ts'
export { saveMemories, saveMemory, extractMemoriesPostHoc } from './write.ts'
export { compactSpaceMemories, deepDreamSpace, runDream } from './dream.ts'
