# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install               # Install dependencies
bun run db:generate       # Generate DB migrations from schema changes
bun run db:migrate        # Apply migrations (creates queriocity.db)

bun run dev               # Hot-reload server on :3000
bun run dev:client        # Vite dev server on :5173 (proxies /api → :3000)
bun run start             # Both server and client in parallel

bun run build:client      # Vite build → dist/client/
bun run serve             # Serve API + static files on :3000
```

No linter or test runner is configured. TypeScript strict mode is the quality gate.

## Architecture

Queriocity is an AI-powered search/chat application (greenfield rewrite of Perplexica). The browser streams answers over SSE from a Hono server backed by SQLite + SearXNG.

```
React + Vite (SSE client)
    ↓
Hono server (Bun)
  ├── /api/auth      JWT + bcrypt login/registration
  ├── /api/chat      Main chat endpoint (4 focus modes)
  ├── /api/files     Upload, OCR/parse, vector index
  ├── /api/history   Chat sessions + message history
  ├── /api/admin     User & invite management
  └── /api/users     Per-user custom instructions
    ↓
SearXNG (meta-search) · LLM API (Ollama / OpenAI-compat) · SQLite + sqlite-vec
```

### Focus modes (`src/server/routes/chat.ts`)

| Mode | Behaviour |
|------|-----------|
| **Flash** | No search; training knowledge only. ~5 sentences. |
| **Fast** | Single pre-search query; model answers directly with optional follow-up. |
| **Balanced** | Small model reformulates query → pre-fetch → main model with up to 2 extra search rounds. |
| **Thorough** | Researcher phase (≤5 rounds × 3 queries) → separate writer synthesis pass. |

### Key modules

- `src/server/routes/chat.ts` — mode dispatch, cache, SSE streaming
- `src/server/lib/researcher.ts` — iterative web search + thinking extraction (thorough/balanced)
- `src/server/lib/writer.ts` — final synthesis for thorough mode
- `src/server/lib/reformulate.ts` — small-LLM query optimization (balanced)
- `src/server/lib/llm.ts` — provider abstraction (Ollama, OpenAI-compatible)
- `src/server/lib/searxng.ts` — SearXNG wrapper
- `src/server/lib/files/` — PDF parsing, OCR (tesseract), chunking, embedding, vector search
- `src/server/lib/db.ts` — Drizzle schema: users, sessions, messages, uploadedFiles, chunks, embeddings

### LLM integration

Uses Vercel AI SDK v4 (`streamText` with tool-calling). Two model roles:
- **Main model** (`CHAT_*` env vars) — answers and reasoning
- **Small model** (`SMALL_*` env vars) — query reformulation, fast tasks

Embeddings use a separate `EMBED_*` endpoint. sqlite-vec is the vector store.

### Environment variables

Required: `CHAT_BASE_URL`, `CHAT_MODEL`, `SMALL_BASE_URL`, `SMALL_MODEL`, `EMBED_BASE_URL`, `EMBED_MODEL`, `SEARXNG_URL`, `PORT`, `DB_PATH`, `JWT_SECRET`, `MAX_ATTACHMENT_CHARS`.

Optional thinking-budget vars control extended reasoning in researcher/writer.

### Database

Schema lives in `src/server/lib/db.ts`. After any schema change: `bun run db:generate && bun run db:migrate`. Migrations go in `drizzle/`.
