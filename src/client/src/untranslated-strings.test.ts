/** Fails when a user-visible string is left as an English literal instead of a catalog key.
 *
 *  The type system guards the catalogs — a key missing from sv.ts will not compile — but it says
 *  nothing about text that never became a key at all. That is the failure this exists for: it
 *  looks correct in review, ships, and shows up as one English line in an otherwise Swedish
 *  screen. Nine of them survived the initial conversion and were found by a user, not by CI.
 *
 *  Scope is the shapes that have actually slipped through: bare JSX text, inline JSX text, the
 *  three attributes a person reads (a `title` tooltip, a `placeholder`, an `aria-label` a screen
 *  reader speaks), copy parked in a data array, and `<option>` children.
 *
 *  Two known gaps, both deliberate. A literal passed to `setStatus(...)` is not caught — widening
 *  that far flags every internal string in the file, and a check people switch off protects
 *  nothing. And only `.tsx` under this directory is read, so copy that lives in a `.ts` data
 *  module is out of reach; the built-in prompt templates are the case that matters there, and
 *  lib/templates-i18n.test.ts covers them by asserting a catalog key per name, field and option. */

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const CLIENT_SRC = join(import.meta.dir)

/** Files whose English text is intentional. */
const SKIPPED_FILES = new Set([
  // Admin-only, left English by decision — see the Languages section in README.md.
  'AdminPanel.tsx',
])

/** Strings that are correct as literals. Keep this list short: every entry is a place the check
 *  cannot help, so an addition should be a considered decision rather than a way past a failure. */
const ALLOWED = new Set([
  'Queriocity',      // the product name, which is not translated
  'https://…',       // a URL placeholder, identical in every language
])

/** Lines that are wholly a comment. Stripped before matching so prose in a JSDoc block — of which
 *  this codebase has a great deal — is not mistaken for text on screen. Only whole-line comments:
 *  cutting at a bare `//` would also cut the middle of every URL. */
const isCommentLine = (line: string) => /^\s*(\/\/|\/\*|\*)/.test(line)

/** JSX text sitting alone on its own line, e.g. a checkbox label:
 *      <span className="…">
 *        Enable space RAG
 *      </span>
 *  Anything starting with `<`, `{`, `?`, `:` or a lowercase letter is code, not copy. */
const BARE_TEXT = /^\s{4,}([A-ZÅÄÖ][a-zA-Z0-9'’ ,.…—–()?!&/-]{3,})$/

/** A wrapped statement can sit alone on a line and start with a capital — `URL.revokeObjectURL(a.href)`
 *  reads as a sentence to the pattern above. Member access and call syntax are what separate them:
 *  prose has ". " or a final ".", never `.word`, and puts a space before an opening bracket. */
const CODE_LIKE = /\.\w|\w\(/

/** JSX text inline between tags, e.g. `<h2 …>Chats</h2>`. */
const INLINE_TEXT = />([A-ZÅÄÖ][^<>{}\n]{3,})</g

/** The attributes a user actually reads. A literal here is always a miss. */
const READABLE_ATTR = /\b(?:placeholder|title|aria-label)="([^"]+)"/g

/** Copy held in a data array and rendered through a variable — `FONT_SIZES = [{ label: 'Small' }]`
 *  reaches the screen as `{label}`, so none of the patterns above see it. This is the shape that
 *  survived both the conversion and the first version of this check. */
const LABEL_PROP = /\b(?:label|description)\s*:\s*'([A-ZÅÄÖ][^']{2,})'/g

/** `<option>` children, which are frequently lowercase ("last 20 chats") and so slip past the
 *  capitalised patterns. Interpolations are cut out first, then what remains must be wordless. */
const OPTION_TEXT = /<option\b[^>]*>([^<]+)</g
const hasWords = (text: string) => /[A-Za-zÅÄÖåäö]{3,}/.test(text.replace(/\{[^}]*\}/g, ''))

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return tsxFiles(path)
    if (!entry.name.endsWith('.tsx') || entry.name.includes('.test.')) return []
    return SKIPPED_FILES.has(entry.name) ? [] : [path]
  })
}

interface Finding { file: string; line: number; text: string }

function findLiterals(path: string): Finding[] {
  const rel = path.slice(CLIENT_SRC.length + 1)
  const found: Finding[] = []
  const record = (line: number, raw: string) => {
    const text = raw.trim()
    if (!ALLOWED.has(text)) found.push({ file: rel, line, text })
  }

  readFileSync(path, 'utf8').split('\n').forEach((line, i) => {
    if (isCommentLine(line)) return
    const bare = BARE_TEXT.exec(line)
    if (bare && !CODE_LIKE.test(bare[1])) record(i + 1, bare[1])
    for (const m of line.matchAll(INLINE_TEXT)) record(i + 1, m[1])
    for (const m of line.matchAll(READABLE_ATTR)) record(i + 1, m[1])
    for (const m of line.matchAll(LABEL_PROP)) record(i + 1, m[1])
    for (const m of line.matchAll(OPTION_TEXT)) if (hasWords(m[1])) record(i + 1, m[1])
  })
  return found
}

describe('user-visible strings', () => {
  const files = tsxFiles(CLIENT_SRC)

  test('there are components to check', () => {
    // Guards the guard: a wrong CLIENT_SRC, or a rename that empties the glob, would make every
    // assertion below pass vacuously.
    expect(files.length).toBeGreaterThan(10)
  })

  for (const path of files) {
    const rel = path.slice(CLIENT_SRC.length + 1)
    test(`${rel} has no untranslated literals`, () => {
      // Compared as a list so a failure prints the file, line and text rather than just a count.
      expect(findLiterals(path)).toEqual([])
    })
  }
})
