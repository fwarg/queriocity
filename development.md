# Development notes

## Pre-executing reformulated queries (2026-03-16)

### What changed
Previously, the reformulated queries from the small LLM were injected only as a
hint in the researcher's system prompt ("Begin your research with: ..."). The big
model was free to ignore this and often did, using the raw user message as the
search query instead.

Now the reformulated queries are executed against SearXNG immediately after
reformulation, before the researcher starts. The results are injected into the
message history as a fake tool-call/tool-result exchange. The researcher model
sees these results as already done and continues from there.

### Files changed
- `src/server/routes/chat.ts` — calls `webSearchMulti` with reformulated queries,
  passes `initialResults` to `runResearcher`; thorough mode seeds `allSources`
  with them upfront
- `src/server/lib/researcher.ts` — accepts `initialResults` in `ResearchOptions`;
  when present, prepends a fake `web_search` tool exchange to the messages array;
  removed the system prompt hint

### How to revert
1. In `researcher.ts`: remove `initialResults` from `ResearchOptions`, remove the
   `augmentedMessages` block, restore `messages: messages` in `streamText`, restore
   the system prompt hint:
   ```
   if (initialQueries?.length) {
     system += `\n\nBegin your research with these specific queries: ${initialQueries.join(' | ')}`
   }
   ```
2. In `chat.ts`: remove the `webSearchMulti` call and `initialResults` variable,
   remove `initialResults` from both `runResearcher` calls, revert `allSources`
   initializer to `[]`

### Trade-offs
- Pro: reformulated queries are guaranteed to be used for the first search
- Pro: one fewer LLM tool call (model skips re-searching what it already has)
- Con: if the reformulated query is off, there is no course-correction for that
  first batch — it's already done before the researcher sees the question
- Con: the pre-executed SearXNG call happens sequentially before streaming starts,
  adding latency to the first byte (same wall time overall, but perceived differently)

## Potential future change: force follow-up search in code (balanced mode)

Prompt changes alone haven't been enough to make smaller local models (e.g.
Qwen3-30B-A3B) reliably perform a follow-up search in balanced mode. The model
sees the pre-injected results and answers directly, ignoring the "ALWAYS call
web_search at least once more" instruction.

**Option 1 — Minimum tool-call gate:** In `chat.ts`, track whether the
researcher made at least one real `web_search` call. If the model finishes
without searching, auto-inject a follow-up round (e.g. extract key terms from
the answer and search) before streaming the text to the client.

**Option 2 — Two-pass balanced:** Split balanced into research + writer passes
like thorough mode, using a `done` tool to prevent the researcher from
answering. More expensive but structurally guarantees research happens.
