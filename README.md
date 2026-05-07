<p align="center"><img src="doc/Queriocity_logo_o.png" width="50%"></p>

# Queriocity

> *Where **quer**y meets **curio**sity — and every answer carries its **cit**ations.*

Queriocity is a self-hosted, LLM-powered research assistant. It connects a local (or
OpenAI-compatible) language model to a private SearXNG search instance, stores your
conversation history and uploaded documents locally in SQLite, and serves everything
through a single Bun process.

![Queriocity screenshot](doc/queriocity_screen.png)

---

## Contents

- [User guide](#user-guide)
  - [What is Queriocity](#what-is-queriocity)
  - [Chats](#chats)
    - [Searching chats](#searching-chats)
  - [Research modes](#research-modes)
  - [Files](#files)
  - [Prompt templates](#prompt-templates)
    - [Prompt Studio](#prompt-studio)
  - [Settings](#settings)
  - [Image generation](#image-generation)
  - [Spaces](#spaces)
  - [Monitors](#monitors)
- [Installation guide](#installation-guide)
  - [Requirements](#requirements)
  - [Installation](#installation)
  - [Environment variables](#environment-variables)
  - [Running](#running)
  - [Docker](#docker)
  - [Example deployment](#example-deployment)
- [Admin guide](#admin-guide)
  - [User management](#user-management)
  - [System settings](#system-settings)
  - [Importing from Claude AI](#importing-from-claude-ai)
  - [Backup](#backup)
- [Architecture overview](#architecture-overview)
- [Dependencies and licenses](#dependencies-and-licenses)
- [License](#license)

---

# User guide

## What is Queriocity

Queriocity is a private research assistant you run on your own hardware. It is designed for:

- **Research questions** — ask anything and get a cited answer backed by live web search
- **Document Q&A** — attach PDFs, images, or text files and interrogate them in conversation
- **Persistent knowledge base** — upload documents to your library so the assistant can draw on them across many conversations
- **Contextual workspaces** — group related chats into spaces with shared memory and file references

## Chats

Start a chat from the sidebar. Type a question and choose a [research mode](#research-modes) before sending. Follow-up questions resolve pronouns and references automatically ("When was it founded?" after asking about a company works as expected). Chats can be assigned to a [space](#spaces) at any time from the chat header.

The first message in a chat can be collapsed to save space — useful when the prompt is long or contains an attachment. Click the **▾** icon in the top-right corner of the message to collapse it; click the truncated preview to expand it again. When opening a monitor run session the first message (the recurring query) is collapsed by default.

The **Chats** view lists all your conversations with infinite scroll. Use the **Active / Created** toggle in the top-right to sort by most recently active or by creation date.

### Searching chats

The search box at the top of the Chats view searches both **chat titles and message content** across your full history. Results appear after a short debounce and are capped at 100 matches. The sidebar also has a quick title-only filter for the currently loaded chats.

### Searching within a chat

Press **Ctrl+F** (or click the 🔍 icon in the chat header) to open an in-chat search bar. Matching messages are highlighted with a yellow ring and the active match scrolls into view. Use **▲ ▼**, **Enter** / **Shift+Enter** to navigate between matches; **Escape** closes the bar. Text matches are also highlighted inline in user messages.

## Research modes

Queriocity runs every chat request in one of four modes, selectable per message in the chat input bar. A fifth **Image** mode is available when `IMAGE_BASE_URL` is configured — see [Image generation](#image-generation).

### Flash

Bypasses all search infrastructure entirely. The model answers directly from its training
knowledge with no web search, no query reformulation, and no tool calls. Responses are
capped at ~5 sentences. Use this for quick factual questions where latency matters
and web freshness is not needed. Attachments are disabled in this mode. Query length is
capped at 200 characters.

The model used in flash mode can be overridden via `FLASH_MODEL=small` to use the 
small/reformulation model instead of the main chat model.

### Balanced *(default)*

A small model first rewrites the user's question into an optimized search query, which is
executed before the main model starts. For example, "what's the latest on the mars mission?"
might become `NASA Mars mission 2026 latest news`. The main model then
receives pre-fetched results and may issue one more round of searches (up to 2 queries at a
time) before answering. Answers include inline citations `[1][2]` and are always in the same
language as the user's question.

Query reformulation can be disabled in **Admin > System settings > Search** for setups where small-model latency is a concern — the raw user query is then sent directly to search.

- 1 LLM-reformulated pre-fetched query (or raw query when reformulation is disabled)
- Up to 3 LLM steps; up to 2 parallel search queries per step
- 8 results per web-search query

### Thorough

A two-phase pipeline. Phase 1 is a dedicated **researcher** run: the model explores the
topic from multiple angles, calling `web_search` (up to 3 queries per call) up to 5 times
in total, finishing by calling a `done` tool. Phase 2 is a separate **writer** pass
that receives all deduplicated sources and synthesises a final, well-structured answer.
Slower, but significantly more comprehensive. Responses are always in the same language as
the user's question.

- Up to 3 pre-fetched queries (10 results each)
- Up to 5 LLM steps in the researcher; up to 3 search queries per step
- Separate writer model pass for the final answer
- If `RERANK_MODEL` is configured, accumulated sources are reranked by relevance before the writer pass, improving synthesis quality



---

## Files

There are two distinct ways to bring file content into a conversation.

### Chat attachment (ephemeral)

Click the **paperclip** icon next to the message box and pick a file. The file is sent to
the server, its text is extracted (PDF text layer, OCR for images, plain text for
everything else), and up to the configured character limit (default 20 000, ~5 000 tokens) of that text are injected into the message
you are about to send. The file is **not stored** — it lives only in that one message.

The character limit is configurable in **Admin > System settings > Attachments**.

Use this when you want to ask a one-off question about a document: *"Summarise this
contract"*, *"What are the key findings in this paper?"*

Supported: PDF, plain text, and images (via vision LLM with Tesseract OCR fallback)

> When a file is attached to the message, reformulation and pre-search are skipped entirely
> in all research modes. The model reads the file content directly and decides autonomously whether
> any web search is needed.

### Library upload (persistent, vector-searchable)

Open the **Files** view in the sidebar. Upload a file there and it is ingested into the
library: the text is chunked, each chunk is embedded with the configured embedding model,
and the chunks + embeddings are stored in SQLite (via the `sqlite-vec` extension).

In balanced and thorough modes, if you have files in your library, relevant excerpts are automatically retrieved and injected as context (see also 'spaces' where the behaviour is a bit different). The model also has access to an `uploads_search` tool in every conversation and can semantically search your library at any time — even without you mentioning the file
explicitly.

The library is useful for building a personal knowledge base of PDFs, notes, or research papers that the assistant can draw on across many conversations.

Max upload size: 50 MB.

---

## Prompt templates

Click the **template icon** (grid icon) in the chat input bar to open the template picker. Templates assemble a structured prompt from a short form — no need to craft the wording yourself. Each template also sets the suggested research mode automatically.

| Template | Suggested mode | Description |
|---|---|---|
| Research deep-dive | Thorough | Structured report on a topic from a specific angle |
| Compare & Analyze | Balanced | Side-by-side comparison with a recommendation |
| Explain / Teach | Flash | Concept explanation tailored to a chosen audience |
| Latest news on | Balanced | Current developments on a topic with implications |
| Draw / Illustrate | Image | Image generation with style, lighting, and quality controls (requires `IMAGE_BASE_URL`) |

Fill in the required fields (marked `*`), adjust optional ones, and click **Use template** to populate the chat input. You can edit the assembled text before sending.

Custom templates you create in [Prompt Studio](#prompt-studio) appear below the built-in ones under a **Custom** heading.

### Prompt Studio

Prompt Studio is a built-in editor for creating and iterating on your own prompt templates. Access it from the **"Create custom template"** button at the bottom of the template picker.

**Workflow:**

1. Write a prompt in the editor. Use `{{placeholder}}` syntax to mark variable parts — e.g. `Explain {{concept}} to a {{audience}} in under {{words}} words.`
2. The Studio automatically detects your placeholders and shows a **Test values** panel with one input per field.
3. Fill in test values (or leave them blank — unfilled placeholders default to the field name so the run still makes sense), pick a mode, and click **▶ Run** to see the output stream in.
4. Iterate: edit the prompt, adjust values, run again.
5. When satisfied, give the template a name and click **Save template**.

Saved templates appear in the template picker under **Custom**. Each card has **Edit** (pencil) and **Delete** (trash) buttons on hover. Editing re-opens Prompt Studio pre-filled with the existing template.

Templates are stored per user in the database and persist across sessions.

---

## Settings

Open **Settings** from the bottom of the sidebar. Settings are saved per user.

| Setting | Description |
|---|---|
| **Custom system prompt** | Text appended to the assistant's instructions on every request. Use it to set a persona, preferred language, citation style, or standing instructions. |
| **Show search process** | Display search queries and result snippets in a collapsed block before the answer. Toggleable separately for Balanced and Thorough modes. |
| **Model thinking** | Use the `THINKING_MODEL` for the researcher phase in Thorough mode. Requires a reasoning-capable model (e.g. Qwen3). Falls back to the chat model if `THINKING_MODEL` is not configured. |
| **Space RAG** | When chatting in a space, retrieve relevant past messages and document excerpts semantically on top of the fixed memory block. |
| **Chat RAG** | When chatting outside a space, automatically retrieve relevant excerpts from your uploaded file library and inject them as context. |
| **Font size** | UI font size: Small (15 px), Normal (17 px), Large (19 px), XL (21 px). Sizes scale up automatically on narrow viewports. |
| **Timezone** | IANA timezone (e.g. `Europe/Stockholm`) used when scheduling monitors at a specific hour of the day. Defaults to server time (UTC in Docker) if not set. |

---

## Image generation

When `IMAGE_BASE_URL` is configured, Queriocity gains a dedicated **Image** mode for generating and editing images using a local diffusion server. The model has three tools:

- **`web_search`** — automatically researches specialized or unfamiliar subjects before generating, so the image prompt can be enriched with accurate visual context
- **`generate_image`** — creates a new image from a text description
- **`edit_image`** — modifies a previously generated image based on a new description

The model decides whether to search first based on topic familiarity. If it does, a one-sentence summary of what was learned appears above the image.

### Usage

Select **Image** mode and describe what you want:

> *"Draw a mountain landscape at sunset"*
> *"Generate a portrait of a robot reading a book, high quality"*
> *"Make it raining"* — (edits the most recently generated image)

The model calls the appropriate tool automatically. While the image is being generated, a **"Generating image…"** or **"Editing image…"** status indicator is shown. When done, the image is displayed inline with a **Download PNG** link.

### Quality hints

The model maps quality keywords to inference step counts:

| Hint in your message | Steps |
|---|---|
| *draft*, *quick*, *fast* | ~15 |
| *(none / default)* | ~25 |
| *high quality*, *detailed*, *best* | ~40 |

You can also request a specific resolution: *"512×512"*, *"1024×576"*, etc.

### Image storage

Generated images are stored on the server (per user) and served via `/images/<user-id>/<filename>.png`. They are tied to the conversation and deleted when the chat is deleted.

### Requirements

A diffusion server that exposes OpenAI-compatible `/v1/images/generations` and `/v1/images/edits` endpoints is required. [ComfyUI](https://github.com/comfyanonymous/ComfyUI) with the openai-compatible API, [A1111](https://github.com/AUTOMATIC1111/stable-diffusion-webui) with the `--api` flag, or any server that implements the OpenAI image API will work.

Set `IMAGE_BASE_URL` in your environment to enable the feature (see [Environment variables](#environment-variables)).

---

## Spaces

**Spaces** are named workspaces that group related chats together. Each space has:

- A persistent **memory store** — facts extracted from conversations, injected into future system prompts
- A **chat history index** — full message content embedded for semantic retrieval
- **Tagged files** — library documents linked to the space for contextual retrieval

### Assigning chats to spaces

Chats can be assigned or reassigned to spaces from the chat header or space detail view. When a chat is first assigned to a space, memories are retroactively extracted and the chat history is indexed for RAG. Auto-extracted memories follow the chat if it is moved or removed.

### RAG (retrieval-augmented generation)

When a space has a RAG budget configured (Admin > System settings), each request performs semantic retrieval on top of the fixed memory block:

- **Chat history RAG** — past messages in the space are chunked and embedded. The chunks most relevant to the current query are injected as `## Relevant past conversations` in the system prompt, surfacing details that weren't captured by memory extraction.
- **Tagged file RAG** — if library files are tagged to the space (see below), relevant excerpts are injected as `## Relevant document excerpts`. The model can also call the `uploads_search` tool on demand for the full personal library.

Space RAG can be toggled per user in **Settings** (see [Settings](#settings)).

#### Chat index

For RAG over chat history to work, messages must be indexed. New messages are indexed automatically after each response. When a chat is first assigned to a space its history is indexed retroactively. The space sidebar shows **Chat index: N/M sessions** — click **Rebuild index** to (re-)index all chats at any time.

### Tagged files

Any file in your library can be tagged to a space from the space detail view. Tagged files are searched semantically on every request in that space (within the RAG budget), injecting relevant excerpts as additional context. This is useful for persistent reference material — specs, style guides, background documents — that should inform all conversations in the space.

### How memory works

- After each assistant response, the small model extracts noteworthy facts, preferences, and decisions and saves them to the space.
- Memories are injected into the system prompt up to the configured token budget (newest first).
- You can view, add, edit, and delete individual memories in the space detail view.

### Memory compaction and management

The memory panel header exposes several actions:

- **Compact** — feeds all memories to the small model, which merges near-duplicates and removes redundant entries. No-ops if already within the target token budget.
- **Recreate all** — clears all auto-extracted memories and re-runs extraction across all chats. Manual memories are preserved. Shows live `Processing (x/y)` progress.
- **Clear all** — deletes all memories in the space (with confirmation).
- **Dream** — optional nightly scheduled pass. Configured by an administrator in Admin > System settings (hour, threshold, target). This mode either compacts any space whose memories exceed the size threshold, or (in deep dream mode) recreates memories from chats using a more capable thinking model for increased memory quality.

Individual chats in a space also have a **Recreate memories** action that re-extracts memories for that chat only.

---

## Monitors

**Monitors** are scheduled queries that run automatically on a recurring interval and store their results as chat sessions. Open the **Monitors** view from the sidebar to manage them.

Each monitor has:

- A **prompt** — the query sent to the model on each run
- A **research mode** — Flash, Balanced, or Thorough
- A **schedule** — how often to run (e.g. every 6 hours, daily, weekly)
- An optional **run time** — for daily/weekly monitors, the hour of day to run (e.g. 02:00)
- A **keep count** — rolling window; older runs are pruned automatically once the limit is reached (default 3)
- An optional **space** — associates the run with a space so its context and memories are available

### Creating a monitor

Click **New monitor** in the Monitors view. The editor has two tabs:

**General** — fill in the prompt, pick a mode and interval, and save. The first run fires after one full interval — use **Run now** (▶) to get an immediate result.

**News sources** — optionally select RSS feeds from a curated catalog of global news outlets. Sources are grouped by region (Americas, Europe, Asia, Africa, Middle East, Oceania) and topic (Technology, Finance, Science & Nature, Culture & Arts, Sports). Each source shows its name, topic, type, and ownership. Use the **all / none** shortcuts to select entire groups at once.

When news sources are selected:
- Feeds are fetched at run time and injected as context, bypassing web search
- Each article carries metadata (source name, topic, type, ownership, region) which the model can reference in its output
- The prompt textarea shows a suggested starter prompt; click **↑ Use suggested prompt** to pre-fill it
- The total volume of feed content is bounded by the **RSS feed character budget** (Admin > System settings); items per feed and content length per item scale automatically to stay within that budget

The news feed catalog is defined in `docker/data/global_news_rss_feeds.json`. Edit that file and rebuild the Docker image to add, remove, or update sources.

### Run history

Each monitor card shows the last run time and next scheduled run. Click the **›** chevron to expand the run history. Each run is a link that opens the full chat session — you can ask follow-up questions, download the response, or use it like any other chat. Once the keep count is exceeded, the oldest run is deleted permanently.

If you add follow-up messages to a monitor run, that session is kept permanently and graduates to a regular chat — it will no longer be pruned.

### Schedule

Interval quick-picks (1 hour, 6 hours, daily, weekly) are available, as well as a free-form picker (any number of hours or days, minimum 1 hour). For daily and weekly intervals you can additionally pick a **Run at** hour so the monitor fires at a predictable time of day rather than inheriting the creation time.

The run hour is interpreted in your configured timezone (set in **Settings → Timezone**). If no timezone is configured, server time is used (UTC in Docker).

The schedule can be changed at any time — the next run is rescheduled from the moment of the edit.

### Global monitors

Admins can create **global monitors** visible to all users. Users subscribe to them from the "Browse global monitors" section at the bottom of the Monitors view. Each subscriber receives their own independent copy of every run — results are not shared between users. Global monitors are created and managed in the **Monitors** view (admin section at the bottom) or in the **Admin panel**.

---

# Installation guide

## Requirements

| Dependency                           | Purpose                     |
| --------------------------------------| -----------------------------|
| [Bun](https://bun.sh) ≥ 1.1          | Runtime & package manager   |
| [SearXNG](https://docs.searxng.org/) | Private meta-search backend |
| Ollama or any OpenAI-compatible API  | Language model serving      |

## Installation

```bash
git clone https://github.com/fwarg/queriocity.git
cd queriocity
bun install
```

### Database

```bash
bun run db:generate   # generate migrations from schema
bun run db:migrate    # apply migrations (creates queriocity.db)
```

## Environment variables

Create a `.env` file (or set variables in your shell):

```dotenv
# ── Unified base URL (optional shorthand) ────────────────────────────────────
# If all your models are served from the same endpoint (e.g. LiteLLM, Ollama),
# set BASE_URL and BASE_PROVIDER once. Every service falls back to these unless
# overridden by its own *_BASE_URL / *_PROVIDER vars.
BASE_URL=http://host.docker.internal:8000/v1     # Set your url/port, e.g. localhost, host.docker.internal (if using docker on Linux, etc)
BASE_PROVIDER=openai                             # "openai" or "ollama"; default: openai

# ── LLM: chat model ──────────────────────────────────────────────────────────
# Base chat model
# CHAT_PROVIDER=ollama                        # falls back to BASE_PROVIDER
# CHAT_BASE_URL=http://localhost:11434/api    # falls back to BASE_URL
# CHAT_API_KEY=sk-placeholder
CHAT_MODEL=qwen3.5-instruct                      # Model name/alias from your LLM endpoint
# FLASH_MODEL=small                              # Optional. Set to "small" to use SMALL_MODEL for flash mode instead of CHAT_MODEL

# ── LLM: thinking/reasoning model (researcher phase) ─────────────────────────
# Optional. When set, used for the researcher phase in thorough mode when the
# "Use thinking model" setting is enabled in the UI. Falls back to CHAT_* if unset.
# THINKING_PROVIDER=openai
# THINKING_BASE_URL=
# THINKING_API_KEY=
THINKING_MODEL=qwen3.5-thinking

# ── LLM: small model (query reformulation) ───────────────────────────────────
# Optional. Use a fast 1–3 B model for best latency. Falls back to CHAT_* if unset.
# SMALL_PROVIDER=ollama
# SMALL_BASE_URL=http://localhost:11434/api
SMALL_MODEL=qwen3.5-small

# ── LLM: embedding model ─────────────────────────────────────────────────────
# EMBED_PROVIDER=ollama
# EMBED_BASE_URL=http://localhost:11434/api   # falls back to CHAT_BASE_URL
EMBED_MODEL=nomic-embed-text
EMBED_DIMENSIONS=1536                       # must match the model's output size

# ── Reranker (optional) ───────────────────────────────────────────────────────
# When RERANK_MODEL is set, a cross-encoder reranker reorders accumulated sources
# by relevance before the thorough-mode writer pass, and reorders library search
# results. RERANK_BASE_URL defaults to BASE_URL if unset.
# RERANK_BASE_URL=http://localhost:8097
RERANK_MODEL=qwen3-reranker

# ── Image generation (optional) ──────────────────────────────────────────────
# When set, Flash mode gains generate_image and edit_image tools.
# Point to any OpenAI-compatible diffusion server (ComfyUI, A1111, etc.).
# IMAGE_BASE_URL=http://localhost:8188   # base URL of diffusion server
# IMAGE_MODEL=                           # optional model name/alias sent to the server

# ── SearXNG ───────────────────────────────────────────────────────────────────
SEARXNG_URL=http://localhost:4000  # url to your searxng instance
# SEARXNG_ENGINES=                            # comma-separated engine list; blank = SearXNG defaults

# ── Server ────────────────────────────────────────────────────────────────────
PORT=3000                                   # not used in Docker (see docker/compose.yml)
DB_PATH=queriocity.db                       # path to SQLite database file (for docker see docker/compose.yml))
JWT_SECRET=change-me-in-production-32chars!!
ALLOWED_ORIGIN=http://localhost:3000        # CORS allowed origin; defaults to * (lock this in production)

# ── Embedding reset (optional) ───────────────────────────────────────────────
# Set to true when changing EMBED_DIMENSIONS to allow the embedding tables to be
# wiped and recreated. WARNING: all uploaded file embeddings will be deleted.
# ALLOW_EMBED_RESET=true

# ── Reformulate context limits ────────────────────────────────────────────────
# The small model receives recent conversation history so it can resolve
# pronouns and follow-up references ("it", "that company", etc.) when
# rewriting queries. These caps bound how much history is injected, keeping
# the small model's context short for latency. (~4 chars ≈ 1 token)
REFORMULATE_USER_CTX=400                  # max chars of prior user turns
REFORMULATE_ASSISTANT_CTX=1000            # max chars of prior assistant turns

# ── Chat context window ───────────────────────────────────────────────────────
# Context window size of the chat/thinking model in tokens. When a conversation
# grows beyond 80 % of this limit, the oldest messages are dropped so the
# request always fits. Set to match your model. (~4 chars ≈ 1 token)
# CONTEXT_TOKEN_LIMIT=32768               # default: 8192
```

## Running

**Development** (hot-reload server + Vite dev server):

```bash
bun run dev           # server only (port 3000)
bun run dev:client    # Vite client (port 5173, proxies /api → 3000)
# or both at once:
bun run start
```

**Production**:

```bash
bun run build:client  # compile React app into dist/client/
bun run serve         # serve API + static files on a single port
```

Open `http://localhost:3000`. The first user to register becomes an admin.

---

## Docker

### Build

```bash
docker compose -f docker/compose.yml build
```

### Configure

Copy `docker/env.template` to `docker/env.local` and fill in your values:

```bash
cp docker/env.template docker/env.local
# edit docker/env.local
```

Key differences from the bare-metal config:

- `DB_PATH=/data/queriocity.db` — the container writes the database to `/data`; mount a host directory there for persistence.
- If your LLM servers (Ollama, llama.cpp, SearXNG, etc.) run on the **host machine**, replace `localhost` with `host.docker.internal` in all `*_BASE_URL` and `SEARXNG_URL` values.
- `PORT` is not used in Docker — the container always listens on port 3000 internally. The external port is set in `docker/compose.yml` (`"8012:3000"` by default).

`docker/env.local` is excluded from the Docker image via `.dockerignore`.

### Run

```bash
docker compose -f docker/compose.yml up -d
```

The app is available at `http://localhost:8012` (or whatever external port is set in `compose.yml`).

The database is stored in `docker/data/queriocity.db` on the host — a plain file you can
inspect, back up, or copy directly. The `docker/data/` directory is excluded from git, so
create it before the first run:

```bash
mkdir -p docker/data
```

To stop without losing data:

```bash
docker compose -f docker/compose.yml down
```

If you prefer a Docker-managed volume instead, replace the `volumes:` block in `compose.yml`:

```yaml
# replace this:
    volumes:
      - ./data:/data

# with this:
    volumes:
      - queriocity-data:/data

volumes:
  queriocity-data:
```

The data will then live under `/var/lib/docker/volumes/docker_queriocity-data/` and is
managed by Docker rather than appearing as a regular directory.

`extra_hosts: host.docker.internal:host-gateway` is set in the compose file and is required
on Linux to make `host.docker.internal` resolve to the host. Docker Desktop on macOS/Windows
adds this automatically.

`user: "${UID:-1000}:${GID:-1000}"` runs the container process as your host user's UID/GID
(defaulting to 1000:1000). This ensures files written to the `./data` volume are owned by
your user rather than root, so you can read, copy, and back up the database without `sudo`.

The schema is created automatically on first start — no separate migration step needed.

---

## Example deployment

Queriocity needs three external services: a **web search backend** (SearXNG), and one or more **model servers** (an openai compatible such as llama.cpp or ollama for local use).

A practical setup could be using a **proxy layer** (e.g. LiteLLM) to give all your models a single unified endpoint while having multiple loaded models using their own separate model servers. This guide walks through an example self-hosted stack on Linux using Docker for SearXNG and LiteLLM, and bare-metal llama.cpp for the models.

### 1. SearXNG

The only required change from the default SearXNG config is to enable JSON output, which Queriocity's search calls depend on.

Create a `settings.yml` with at minimum:

```yaml
search:
  formats:
    - html
    - json
```

Run with Docker:

```bash
docker run -d \
  --name searxng \
  -p 4000:8080 \
  -v $(pwd)/searxng:/etc/searxng \
  searxng/searxng
```

Set `SEARXNG_URL=http://localhost:4000` in your Queriocity env. If Queriocity runs in Docker too, use `http://host.docker.internal:4000`.

### 2. llama.cpp model servers

Run a `llama-server` in OpenAI-compatible mode for each model. Each model needs its own port. All models need to fit in vram simultaneously for this example setup.

```bash
# Large instruct model (main chat + researcher)
# Add --mmproj /models/my-instruct-mmproj.gguf to enable vision (image attachments).
# The mmproj file is a separate download alongside the main model weights.
# Also add --image-min-tokens 1024 for Qwen-VL models (improves grounding accuracy).
# In LiteLLM, set supports_vision: true on this model entry.
llama-server \
  --model /models/my-instruct-model.gguf \
  --alias my-chat-model \
  --host 0.0.0.0 --port 8095 \
  --ctx-size 65536 \
  --n-gpu-layers 99 \
  --threads 8

# Small/fast model (query reformulation)
llama-server \
  --model /models/my-small-model.gguf \
  --alias my-small-model \
  --host 0.0.0.0 --port 8093 \
  --ctx-size 4096 \
  --n-gpu-layers 99 \
  --threads 4

# Embedding model
llama-server \
  --model /models/my-embed-model.gguf \
  --alias my-embed-model \
  --host 0.0.0.0 --port 8096 \
  --ctx-size 32768 \
  --n-gpu-layers 99 \
  --embedding
```

**Hybrid thinking models** (e.g. Qwen3.5): You can set it up so that llama.cpp exposes a single server for both thinking and non-thinking variants where you instead control which mode to use via `enable_thinking` in the LiteLLM config (see below) — no separate server flag is needed.

### 3. LiteLLM proxy

LiteLLM maps friendly model names to your llama.cpp backends and exposes a single OpenAI-compatible endpoint. This lets Queriocity use one `BASE_URL` for all models.

**`litellm_config.yaml`**:

```yaml
model_list:
  - model_name: my-chat-model
    litellm_params:
      model: openai/my-chat-model
      api_base: http://host.docker.internal:8095/v1
      api_key: none

  # For hybrid thinking models: two entries pointing at the same server,
  # one with thinking enabled and one without.
  - model_name: my-think-model
    litellm_params:
      model: openai/my-chat-model
      api_base: http://host.docker.internal:8095/v1
      api_key: none
      extra_body:
        chat_template_kwargs:
          enable_thinking: true

  - model_name: my-small-model
    litellm_params:
      model: openai/my-small-model
      api_base: http://host.docker.internal:8093/v1
      api_key: none

  - model_name: my-embed-model
    litellm_params:
      model: openai/my-embed-model
      api_base: http://host.docker.internal:8096/v1
      api_key: none
      mode: embedding
      custom_llm_provider: openai
```

Run LiteLLM via Docker:

```yaml
# docker-compose.yml
services:
  litellm:
    image: docker.litellm.ai/berriai/litellm:main-stable
    ports:
      - "8000:4000"
    volumes:
      - ./litellm_config.yaml:/app/config.yaml
    command: --config /app/config.yaml
    extra_hosts:
      - "host.docker.internal:host-gateway"   # required on Linux
```

```bash
docker compose up -d
```

### 4. Queriocity env

With LiteLLM running on port 8000, configure Queriocity using `BASE_URL` so all models route through it:

```dotenv
BASE_URL=http://localhost:8000/v1    # or host.docker.internal:8000/v1 if in Docker
BASE_PROVIDER=openai

CHAT_MODEL=my-chat-model
SMALL_MODEL=my-small-model
EMBED_MODEL=my-embed-model
EMBED_DIMENSIONS=1536               # match your embedding model's output size

# Optional: dedicated thinking model for thorough mode researcher phase
THINKING_MODEL=my-think-model

SEARXNG_URL=http://localhost:4000

JWT_SECRET=                         # generate with: openssl rand -base64 32
DB_PATH=./queriocity.db
```

See the [Environment variables](#environment-variables) section for the full reference.

> **Note:** Some tuning parameters (attachment character limit, reranker top-N, memory budget, dream compaction settings) are configurable at runtime in **Admin > System settings** without restarting the server.

### Reranker (optional)

llama.cpp supports reranking via the `--reranking` flag. Run a cross-encoder model on its own port:

```bash
llama-server \
  --model /models/my-reranker-model.gguf \
  --alias my-reranker-model
  --host 0.0.0.0 --port 8097 \
  --n-gpu-layers 99 \
  --reranking
```

Add the model to your LiteLLM config:

```yaml
  - model_name: my-reranker-model
    litellm_params:
      model: hosted_vllm/my-reranker-model   # hosted_vllm is a LiteLLM workaround; backend is llama.cpp
      api_base: http://host.docker.internal:8097
      api_key: none
      mode: rerank
```

Then set in your Queriocity env:

```dotenv
RERANK_BASE_URL=http://localhost:8000/v1   # via LiteLLM
RERANK_MODEL=my-reranker-model
```

---

# Admin guide

## User management

- Registration requires an **invite link** generated by an admin in the Admin panel > Users tab.
- Invites can optionally be scoped to a specific email address and expire after a set time.
- Admins can view all users and manage roles.

---

## System settings

The **Admin panel > System settings** tab exposes runtime-configurable parameters without requiring a server restart. Changes take effect immediately.

| Section | Setting | Default | Description |
|---|---|---|---|
| Memory | Token budget | 1000 | Max tokens of fixed space memory injected into each request |
| Memory | RAG budget | 500 | Additional tokens reserved for RAG results (chat history + tagged files); 0 disables RAG |
| Memory | Dream hour | Disabled | Server hour (0–23) to run nightly compaction, or disabled |
| Memory | Dream threshold | 1500 | Compaction triggers when space memory exceeds this many tokens |
| Memory | Dream target | 700 | Token target after compaction |
| Memory | Dream deep | Off | Re-extract memories from source conversations using the thinking model during the dream pass |
| Memory | Extraction context | 6000 | Max characters of conversation fed to the small model when extracting memories |
| Reranking | Top N | 15 | Results kept after reranking (requires `RERANK_MODEL`) |
| Search | Query reformulation | On | Use a small LLM to rewrite queries before searching. Improves relevance at the cost of a small model call. Disable on slow hardware. |
| Search | RSS feed character budget | 50000 | Total characters of news content fetched per monitor run when RSS sources are selected. Items per feed and content length per item scale automatically to fill this budget. Increase for large-context models; decrease for small ones (8K context ≈ 20 000 chars). |
| Attachments | Max context chars | 20000 | Max characters extracted from an attached file and sent as context |

The **RAG context budget** field also has a **Re-index chats** button that queues a background re-index of all chat sessions across all users — useful after changing embedding models or dimensions.

The **Users** tab lets admins manage accounts, roles, and invite links.

---

## Importing from Claude AI

If you have a Claude AI data export you can import your projects and conversation history into Queriocity using the bundled script. Projects are imported as spaces; conversations are imported as unassigned chat sessions (assign them to spaces via the UI afterwards).

**Note:** The Claude AI export format does not include the project↔conversation mapping, so all chats land as unassigned regardless of which project they belonged to in Claude. Conversations with no message text are skipped automatically, and blank titles are generated from the first message.

```bash
# Preview counts without writing anything
DB_PATH=docker/data/queriocity.db bun run scripts/import-claude.ts \
  --data-dir /path/to/claude-export --dry-run

# Run the import
DB_PATH=docker/data/queriocity.db bun run scripts/import-claude.ts \
  --data-dir /path/to/claude-export
```

The script prompts you to select a user when multiple accounts exist in the database. Re-running is safe — all inserts use `INSERT OR IGNORE` on the primary key.

---

## Backup

All persistent data lives in a single SQLite file. Use SQLite's `.backup` command to take a live snapshot without stopping the server:

```bash
sqlite3 /path/to/queriocity.db ".backup /path/to/backup/queriocity-$(date +%Y%m%d).db"
```

This is safe to run against a live database. A simple daily cron script:

```bash
#!/bin/bash
# /etc/cron.daily/queriocity-backup  (chmod 755, no dot in filename)
sqlite3 /home/user/queriocity/docker/data/queriocity.db \
  ".backup /home/user/backups/queriocity-$(date +%Y%m%d).db"
find /home/user/backups -name "queriocity-*.db" -mtime +30 -delete
```

If you use image generation, also back up the `images/` directory alongside the database file.

---

## Architecture overview

```
Browser (React + Vite)
        │  SSE stream
        ▼
Hono server (Bun)
  ├── /api/auth      — register, login (JWT + bcrypt)
  ├── /api/chat      — reformulate → pre-search → researcher → [writer]
  ├── /api/files     — upload/extract/list/delete
  ├── /api/history   — chat sessions + messages + memory lifecycle
  ├── /api/spaces    — spaces, per-space memories, compact, recreate
  ├── /api/admin     — user/invite management, system settings, model test
  ├── /api/images     — serve generated images (per-user, auth-gated)
  ├── /api/templates  — custom prompt templates (CRUD, per-user)
  ├── /api/monitors   — monitors (CRUD, run, subscribe, global)
  ├── /api/feeds      — RSS feed catalog (served from news_feeds.json)
  └── /api/users      — user settings
        │
        ├── SearXNG   (meta-search)
        ├── RSS feeds (fetched at monitor run time from news_feeds.json)
        ├── Ollama / OpenAI-compatible API
        ├── Diffusion server (optional, image generation/editing)
        ├── Reranker API (optional, cross-encoder)
        └── SQLite + sqlite-vec   (queriocity.db)
             ├── chat sessions & messages
             ├── space memories (extracted, manual, compacted)
             ├── chat message chunks + embeddings  (space RAG)
             ├── uploaded file chunks + embeddings (library + space file RAG)
             ├── custom_templates (per-user prompt templates)
             ├── monitors + monitor_subscriptions + monitor_runs
             └── app_settings (runtime-configurable parameters)
```

---

## Dependencies and licenses

All direct runtime dependencies use **MIT** or **Apache 2.0** licenses.

| Package               | License    | Purpose                               |
| -----------------------| ------------| ---------------------------------------|
| `hono`                | MIT        | HTTP server framework                 |
| `@hono/zod-validator` | MIT        | Request validation middleware         |
| `ai` (Vercel AI SDK)  | Apache 2.0 | LLM streaming & tool-call abstraction |
| `@ai-sdk/openai`      | Apache 2.0 | OpenAI-compatible provider adapter    |
| `ollama-ai-provider`  | MIT        | Ollama provider adapter               |
| `zod`                 | MIT        | Schema validation                     |
| `jose`                | MIT        | JWT signing & verification            |
| `bcryptjs`            | MIT        | Password hashing                      |
| `drizzle-orm`         | Apache 2.0 | Type-safe SQLite ORM                  |
| `sqlite-vec`          | MIT        | Vector similarity search in SQLite    |
| `pdf-parse`           | MIT        | PDF text extraction                   |
| `pdfjs-dist`          | Apache 2.0 | PDF rendering (canvas fallback)       |
| `tesseract.js`        | Apache 2.0 | OCR for image attachments             |
| `react` / `react-dom` | MIT        | UI framework                          |
| `react-markdown`      | MIT        | Markdown rendering                    |
| `lucide-react`        | ISC        | Icon library                          |

Dev dependencies (`vite`, `tailwindcss`, `drizzle-kit`, `@vitejs/plugin-react`, Babel
plugins, type stubs) are likewise MIT or Apache 2.0.

This project is licensed under **MIT**. It is compatible with all dependencies listed
above: MIT packages impose no downstream restrictions, and Apache 2.0 packages may be
included in MIT-licensed projects provided their copyright and license notices are
retained (which standard `node_modules` handling already does).

---

## License

MIT — see [LICENSE.md](LICENSE.md)
