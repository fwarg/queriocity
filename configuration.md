# Configuration tips

Practical notes on tuning Queriocity's retrieval: embedding models, prefixes, whether to run a
reranker, and what to set the similarity thresholds in **Admin → Settings** to. The
[README](README.md) has the full environment-variable reference; this file is about choosing values,
and includes measurements for specific models.

- [Embedding prefixes](#embedding-prefixes)
- [Changing the embedding model](#changing-the-embedding-model)
- [Reranker or not](#reranker-or-not)
- [Running without a reranker](#running-without-a-reranker)
- [Similarity thresholds](#similarity-thresholds)
- [Model notes: EmbeddingGemma 2](#model-notes-embeddinggemma-2)

---

## Embedding prefixes

Most current retrieval models are *asymmetric*: they embed a question and the passage that answers
it differently, and only when the input says which is which. Without the marker they still return
vectors of the right size, so nothing fails — retrieval is just quietly worse. Check your model's
card for its prefixes.

Every embedding call in Queriocity has one of three roles, each with its own prefix:

| Variable | Role | Used for |
|---|---|---|
| `EMBED_QUERY_PREFIX` | query | searches, memory recall, the collection agent, checking a new memory against existing ones |
| `EMBED_DOCUMENT_PREFIX` | document | everything stored: file and chat chunks, memories |
| `EMBED_SIMILARITY_PREFIX` | similarity | like-with-like comparison of tag and topic phrases. Defaults to the query prefix |

All three are empty by default, which is right for symmetric models (and for anything like
`nomic-embed-text` where you do not want to change behaviour).

**Keep the double quotes.** Prefixes usually end with a space, and Docker Compose strips trailing
whitespace from an unquoted value in an env file: `EMBED_QUERY_PREFIX=query: ` arrives as `query:`.

```sh
# EmbeddingGemma 2
EMBED_QUERY_PREFIX="task: search result | query: "
EMBED_DOCUMENT_PREFIX="title: none | text: "
EMBED_SIMILARITY_PREFIX="task: sentence similarity | query: "

# Nemotron embed (llama-nemotron-embed-1b-v2), E5
EMBED_QUERY_PREFIX="query: "
EMBED_DOCUMENT_PREFIX="passage: "
```

The EmbeddingGemma 2 strings come from the `prompts` in the model's
`config_sentence_transformers.json` on Hugging Face (`query`, `document`, `SentenceSimilarity`).

## Changing the embedding model

Stored vectors are rebuilt automatically at the next start when any of these change:

- `EMBED_DIMENSIONS`
- `EMBED_MODEL`
- `EMBED_DOCUMENT_PREFIX`

Changing the query or similarity prefix needs no rebuild: those are never stored.

The rebuild drops only the vectors, then re-embeds the chunk text the database already holds. It runs
in the background, so the app is usable meanwhile with partial retrieval. Memories are re-embedded
lazily, the first time each space's memories are read. For scale: 9,600 chat chunks took under three
minutes with EmbeddingGemma 2 on an Intel GPU (llama.cpp SYCL).

Two things to do around a model change:

1. **Back up the database first** (`cp data/queriocity.db{,.bak}` with the app stopped). Going back
   to the old model means another full rebuild.
2. **Recalibrate the similarity thresholds** (below). Cosine scales differ a lot between models, and
   values tuned for one can make another suggest everything or nothing.

## Reranker or not

A reranker re-scores the embedder's top candidates by reading query and document together. It only
helps if it judges relevance better than the embedder that picked the candidates. Measured on two
small BEIR datasets, with each model's recommended prefixes and every reranker re-sorting the
embedder's top 20:

| Pipeline | NFCorpus nDCG@10 | SciFact nDCG@10 | Added per query |
|---|---|---|---|
| **EmbeddingGemma 2** | 0.368 | **0.852** | — |
| + bge-reranker-v2-m3 | 0.366 | 0.778 | ~2.5 s |
| + Qwen3-Reranker-0.6B | **0.379** | 0.765 | ~2.2 s |
| Nemotron embed 1B v2 | 0.322 | 0.682 | — |
| + bge-reranker-v2-m3 | 0.338 | 0.744 | ~2.5 s |
| + Qwen3-Reranker-0.6B | 0.351 | 0.750 | ~2.2 s |

Times are for an Intel GPU, at about 25 query–document pairs per second. SciFact probably flatters
EmbeddingGemma 2 (its score is above what much larger models get, which suggests the dataset was in
its training data), so NFCorpus is the fairer comparison.

**Takeaway:** with EmbeddingGemma 2, a reranker adds at most ~3% for more than two seconds per
query, and bge-reranker makes it worse. Run without one unless a test on your own documents shows a
real gain. With a weaker embedder, a reranker still earns its place.

**If you do use Qwen3-Reranker:** it expects an instruction template around the query and each
document, and neither Queriocity nor OpenVINO Model Server adds it. Without the template, a clearly
relevant document scored 0.09 instead of 0.74 in testing. bge-reranker needs no template.

## Running without a reranker

Leave `RERANK_MODEL` unset (or commented out). Everything keeps working; two things change:

- **Web results are cut, not ranked.** "Top N results" still limits how many sources reach the
  answer. Results from several searches are merged round-robin — every search's best, then every
  search's second best — so the cut keeps something from each query instead of only the first one.
- **The relevance floor becomes a similarity floor.** "Minimum relevance for resources" needs a
  reranker. Without one, **"Minimum similarity for resources (no reranker)"** does the same job using
  the cosine similarity between query and excerpt. It is off (0) by default because its scale depends
  on the embedding model; see the table below.

## Similarity thresholds

Every threshold below is a cosine similarity, and the right value depends on the embedding model.
Old defaults (0.5–0.8) were set for models that spread their scores widely. EmbeddingGemma 2 scores
almost everything high, so at those defaults it would suggest every resource as similar, merge all
notes into one topic, and match unrelated tags.

**Tentative values for EmbeddingGemma 2** (Admin → Settings):

| Setting | Default | EmbeddingGemma 2 | Basis |
|---|---|---|---|
| Top N results | 15 | 15 | Not model-dependent. Raise it if thorough answers seem thin. |
| Minimum relevance for resources | 0 | — | Reranker only. |
| **Minimum similarity for resources (no reranker)** | 0 | **0.65** | Off-topic queries' best hits: 0.55–0.69. On-topic: never below 0.67. See [1](#1-query-to-excerpt). |
| Minimum similarity for "Similar content" | 0.5 | **0.82** | Related documents: median 0.855. Unrelated documents in the same field: median 0.75, 95th percentile 0.82. See [2](#2-document-to-document). |
| Minimum reranker relevance for "Similar content" | 0.5 | — | Reranker only. |
| Topic map similarity | 0.6 | **0.80** | Between unrelated (0.75) and related (0.855) document pairs. See [2](#2-document-to-document). |
| Tag match similarity | 0.8 | **0.92** | Synonyms and translations: 0.89–0.99. Different tags in the same category: at most 0.91. See [3](#3-tag-phrases). |
| Tag placement similarity | 0.6 | **0.86** | Unrelated tags: at most 0.86. Same category: median 0.88. See [3](#3-tag-phrases). |

These are starting points, not answers. Calibrate against your own library:

- **Admin → Similarity** shows the cosine values your related and unrelated notes actually get.
- The server logs the scores behind each decision: `similarities: [...] (floor …)` for retrieval,
  `[related] similarities` for similar content, and a `[tags]` line for every tag suggestion.

### How the values were measured

All measurements use EmbeddingGemma 2 (Q8_0 GGUF, llama.cpp) through the same prefixes Queriocity
sends.

#### 1. Query to excerpt

BEIR NFCorpus (3,633 medical documents, 323 queries) and SciFact (5,183 abstracts, 300 queries),
plus 12 deliberately off-topic questions (bread baking, football, nginx, a Swedish public-transport
question, and so on) searched against the same corpora.

| | Best hit, on-topic | Best hit, off-topic | Off-topic hits kept per query at 0.65 (of 15) |
|---|---|---|---|
| NFCorpus | min 0.673, median 0.795 | 0.551–0.663 | 0.3 |
| SciFact | min 0.718, median 0.847 | 0.569–0.692 | 0.5 |

At 0.65 every on-topic query kept at least one hit. Within an on-topic search the floor does *not*
separate good hits from near misses: in the top 15, relevant hits scored 0.72–0.84 (5th–95th
percentile, NFCorpus) and irrelevant ones 0.68–0.81. What it does is keep excerpts out of the prompt
when nothing in the library is about the question.

The benchmark queries are search-style questions. Real chat messages are longer and messier and may
score a little lower, so watch the `similarities:` log lines for a few days after setting it.

#### 2. Document to document

"Similar content" and the topic map compare stored chunk vectors with each other. Measured on
NFCorpus: pairs of documents both judged highly relevant to the same query (one pair per query)
against 2,000 random pairs.

| | 5th percentile | Median | 95th percentile |
|---|---|---|---|
| Documents on the same question | 0.746 | 0.855 | 0.928 |
| Random documents (same field) | 0.684 | 0.749 | 0.819 |

A single-field medical corpus is a hard case: random pairs share vocabulary. A more varied library
will probably score unrelated pairs lower, which would allow slightly lower thresholds.

#### 3. Tag phrases

36 hand-made pairs of short tag phrases, embedded as the app embeds them (path separators become
spaces, similarity prefix), including a few Swedish ones:

| | Min | Median | Max | Examples |
|---|---|---|---|---|
| Same tag, synonym or translation | 0.889 | 0.975 | 0.991 | rosor / plants roses, bilar / cars |
| Same category, different tag | 0.825 | 0.880 | 0.912 | tulips / plants roses, jazz / music rock |
| Unrelated | 0.796 | 0.824 | 0.858 | tulips / programming python, bilar / recept |

The bands are narrow and overlap a little, so expect the occasional synonym to come out as a new tag,
or a related tag to be suggested at the top level.

## Model notes: EmbeddingGemma 2

- **Size and output:** 271M parameters, 768-dimension vectors, normalised by the server. Smaller
  dimensions (512/256/128) are possible only by truncating client-side; Queriocity does not do that,
  so set `EMBED_DIMENSIONS=768`.
- **llama.cpp version:** the architecture (`gemma-embedding2`) needs a llama.cpp build that includes
  PR #30054, merged 2026-10-06. Older builds fail to load the GGUF.
- **Server flags:** `--embedding --pooling mean`, with `--ctx-size`, `--batch-size` and
  `--ubatch-size` equal (each input must fit one physical batch); up to 8192, 4096 is plenty. Set
  `EMBED_CONTEXT_TOKENS` to the same value.
- **Precision:** the model card warns against FP16 (it can produce NaN or degraded embeddings). On
  the llama.cpp SYCL backend with a Q8_0 file, GPU output matched a CPU run at cosine ≥ 0.9999, so
  that combination is fine.
- **Startup:** on SYCL the server reports "Loading model" (HTTP 503) for about a minute while it
  warms up. Give the container healthcheck a `start_period` of 90 s or so.
- **Speed:** about 42 documents/s when indexing and 90 queries/s on an Intel GPU, roughly three times
  faster than Nemotron embed 1B, with vectors less than half the size (768 vs 2048 dimensions).
