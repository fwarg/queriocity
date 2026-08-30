/** Recover a tool call a weak model wrote into its prose instead of emitting as a real call.
 *
 *  gemma-4 behind LiteLLM intermittently answers image mode in LangChain's ReAct-JSON shape —
 *  `{ "action": "generate_image", "action_input": "{'prompt': '...'}" }` — as ordinary assistant
 *  text. The AI SDK's tool-call parser never sees it, so the blob streams to the user as the whole
 *  reply and nothing is generated. This finds such a blob, pulls the arguments out of it (the inner
 *  payload is often a Python-dict repr rather than JSON, and its string values carry unescaped
 *  apostrophes, so a plain JSON.parse is not enough), and returns the slice of text that held it so
 *  the caller can strip it from the visible reply.
 *
 *  It also catches a second shape: a model that writes its own markdown image pointing at an
 *  external "prompt-to-image" service (`![alt](https://image.pollinations.ai/prompt/…)`) instead of
 *  calling the tool. That renders — so it looks like it worked — but the picture never came from the
 *  local stack and the full prompt is shipped to a third party every time the note is displayed.
 */

export interface LeakedToolCall {
  action: string
  input: Record<string, unknown>
  /** Exact substring of the source text that held the call, for removal from the visible reply. */
  source: string
}

const ACTION_KEYS = ['action', 'tool', 'tool_name', 'name']
const INPUT_KEYS = ['action_input', 'tool_input', 'input', 'arguments', 'parameters']

/** Top-level `{...}` spans, counting braces but ignoring any inside a double-quoted JSON string.
 *  Single quotes are not treated as delimiters — the ReAct wrapper is valid JSON at the outer
 *  level and its Python-dict payload lives inside one double-quoted string. */
function objectSpans(text: string): string[] {
  const spans: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0 && start !== -1) {
        spans.push(text.slice(start, i + 1))
        start = -1
      } else if (depth < 0) {
        depth = 0
      }
    }
  }
  return spans
}

function pick(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (k in obj) return obj[k]
  return undefined
}

/** Parse a payload that may be JSON, a JSON string wrapping JSON, or a one-level Python-dict repr
 *  whose string values contain unescaped apostrophes (`'the fox's fur'`). */
export function parseLooseArgs(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value !== 'string') return null
  const s = value.trim()
  try {
    const parsed = JSON.parse(s)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch { /* fall through to the loose parse */ }

  const body = s.replace(/^\{/, '').replace(/\}$/, '')
  // Key positions: 'key':  or  "key":  at the start of an entry.
  const keyRe = /(['"])([\w-]+)\1\s*:\s*/g
  const marks: Array<{ name: string; valueStart: number; matchStart: number }> = []
  let m: RegExpExecArray | null
  while ((m = keyRe.exec(body))) {
    marks.push({ name: m[2], valueStart: m.index + m[0].length, matchStart: m.index })
  }
  if (marks.length === 0) return null
  const out: Record<string, unknown> = {}
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].matchStart : body.length
    out[marks[i].name] = convertScalar(body.slice(marks[i].valueStart, end))
  }
  return out
}

function convertScalar(raw: string): unknown {
  const v = raw.trim().replace(/,\s*$/, '').trim()
  if (v.length >= 2 && ((v[0] === "'" && v.at(-1) === "'") || (v[0] === '"' && v.at(-1) === '"'))) {
    return v.slice(1, -1)
  }
  if (v === 'true' || v === 'True') return true
  if (v === 'false' || v === 'False') return false
  if (v === 'null' || v === 'None') return null
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v)
  return v
}

/** Find a tool call the model wrote as text. `actions` is the set of accepted tool names;
 *  `fallbackAction` (optional) names the tool to assume when a bare argument object is found with
 *  no action wrapper — e.g. `{"prompt": "..."}` on its own. Returns null when nothing matches. */
export function findLeakedToolCall(
  text: string,
  actions: string[],
  fallbackAction?: string,
): LeakedToolCall | null {
  // Explicit ReAct scaffolding first: `Action: name` / `Action Input: {...}`. Checked ahead of the
  // bare-object fallback below, which would otherwise claim the argument object for the wrong tool.
  const react = text.match(/Action\s*:\s*([\w-]+)\s*[\r\n]+\s*Action\s*Input\s*:\s*(\{[\s\S]*?\}|.+)/i)
  if (react && actions.includes(react[1])) {
    const input = parseLooseArgs(react[2].trim())
    if (input) return { action: react[1], input, source: react[0] }
  }

  for (const span of objectSpans(text)) {
    let obj: Record<string, unknown> | null = null
    try {
      const parsed = JSON.parse(span)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) obj = parsed
    } catch { /* try a regex extraction below */ }

    if (obj) {
      const rawAction = pick(obj, ACTION_KEYS)
      if (typeof rawAction === 'string' && actions.includes(rawAction.trim())) {
        const input = parseLooseArgs(pick(obj, INPUT_KEYS))
        if (input) return { action: rawAction.trim(), input, source: span }
      }
      // Bare argument object, no wrapper.
      if (fallbackAction && rawAction === undefined && typeof obj.prompt === 'string') {
        return { action: fallbackAction, input: obj, source: span }
      }
      continue
    }

    // Span was not valid JSON (unescaped quote in the payload, say). Pull the fields out directly.
    const am = span.match(/["']?(?:action|tool|tool_name|name)["']?\s*:\s*["']([\w-]+)["']/i)
    if (am && actions.includes(am[1])) {
      const im = span.match(/["']?(?:action_input|tool_input|input|arguments|parameters)["']?\s*:\s*(\{[\s\S]*\}|"[\s\S]*")\s*\}?\s*$/i)
      const input = im ? parseLooseArgs(im[1].replace(/^"|"$/g, '')) : null
      if (input) return { action: am[1], input, source: span }
    }
  }

  return null
}

/** Remove a leaked tool call and any ReAct scaffolding lines from a reply meant for the user.
 *  Pass `source` (from {@link findLeakedToolCall}) to strip that exact slice; the regex sweep runs
 *  regardless, so a source that no longer matches verbatim (whitespace normalised upstream, say) is
 *  still caught. */
export function stripLeakedToolCall(text: string, source?: string): string {
  let t = source && text.includes(source) ? text.split(source).join('') : text
  t = t.replace(/^\s*(?:Thought|Action|Action Input|Observation|Final Answer)\s*:.*$/gim, '')
  // A JSON action object anywhere in the reply, plus anything trailing it (the model rarely writes
  // useful prose after leaking a call).
  t = t.replace(/\{\s*["']?(?:action|tool|tool_name|name)["']?\s*:\s*["'][\w-]+["'][\s\S]*\}[\s\S]*$/i, '')
  return t.replace(/\n{3,}/g, '\n\n').trim()
}

/** A markdown image the model wrote into its own text. In a mode that inserts its images after the
 *  fact, any `![...](...)` in the model's output is a leak. */
export interface LeakedImageMarkdown {
  alt: string
  url: string
  /** Best guess at the intended prompt: the decoded prompt segment of the URL, else the alt text. */
  prompt: string
  /** The full `![...](...)` substring, for removal from the visible reply. */
  source: string
}

const imageMdRe = () => /!\[([^\]]*)\]\(\s*([^\s)]+)\s*\)/g

/** Pull the prompt out of a hallucinated image URL — pollinations.ai puts it in `/prompt/<text>`,
 *  others in a `?prompt=` / `?text=` query param. Models often append `&width=…` onto the path
 *  with no `?`, so trim a trailing render-option run. */
function promptFromImageUrl(url: string): string {
  try {
    const u = new URL(url)
    const seg = u.pathname.match(/\/prompt\/(.+)$/)
    if (seg) {
      return decodeURIComponent(seg[1])
        .replace(/[?&](?:width|height|nologo|seed|model|enhance|private|referrer)=.*$/i, '')
        .trim()
    }
    const q = u.searchParams.get('prompt') ?? u.searchParams.get('text')
    if (q) return q.trim()
  } catch { /* not a parseable URL */ }
  return ''
}

/** Markdown images the model wrote itself, excluding any whose URL `isLocal` accepts (those are
 *  ours, or a real earlier render the model is legitimately referencing). */
export function findLeakedImageMarkdown(
  text: string,
  isLocal: (url: string) => boolean,
): LeakedImageMarkdown[] {
  const out: LeakedImageMarkdown[] = []
  for (const m of text.matchAll(imageMdRe())) {
    const [source, alt, url] = m
    if (isLocal(url)) continue
    out.push({ alt, url, prompt: promptFromImageUrl(url) || alt, source })
  }
  return out
}

/** Remove every model-written markdown image whose URL `isLocal` rejects. */
export function stripLeakedImageMarkdown(text: string, isLocal: (url: string) => boolean): string {
  return text
    .replace(imageMdRe(), (full, _alt, url) => (isLocal(url) ? full : ''))
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Coerce string-valued numerics (`"30"`) to numbers for the named keys, leaving everything else
 *  untouched. A model that writes a call as text tends to quote every value, so the recovered
 *  arguments would fail a `z.number()` check without this. */
export function coerceNumericArgs(
  input: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input }
  for (const k of keys) {
    const v = out[k]
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) out[k] = Number(v)
  }
  return out
}
