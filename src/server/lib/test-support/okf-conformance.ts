/** Checks an exported bundle against OKF v0.2 §11 conformance, standing in for a validator OKF does
 *  not ship: every concept has parseable frontmatter with a non-empty `type`, and reserved files
 *  follow §8 (index.md) — no frontmatter except `okf_version` at the root, headed sections of
 *  `* [Title](url) - description` entries. Index links must resolve too: soft guidance in the spec,
 *  but a broken one here is our bug. */

/** The text files of a stored (uncompressed) zip, as lib/zip.ts writes it. */
export function readStoredZip(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const decoder = new TextDecoder()
  const files = new Map<string, string>()
  let at = 0
  while (view.getUint32(at, true) === 0x04034b50) {
    const size = view.getUint32(at + 18, true)
    const nameLength = view.getUint16(at + 26, true)
    const start = at + 30 + nameLength + view.getUint16(at + 28, true)
    files.set(decoder.decode(bytes.subarray(at + 30, at + 30 + nameLength)), decoder.decode(bytes.subarray(start, start + size)))
    at = start + size
  }
  return files
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---(?:\n|$)/
/** CommonMark allows balanced parentheses in a link destination: `[x](x%20(2).md)`. */
const ENTRY = /^\* \[[^\]]+\]\(((?:[^()\s]|\([^()\s]*\))+)\)(?: - .+)?$/

/** Every conformance problem found, as `path: problem`; empty when the bundle conforms. */
export function okfViolations(files: Map<string, string>): string[] {
  const problems: string[] = []
  for (const [path, text] of files) {
    if (!path.endsWith('.md')) continue
    const name = path.split('/').pop()
    const found = name === 'index.md' ? indexProblems(path, text, files)
      : name === 'log.md' ? ['log.md is not produced, so its structure is not checked']
      : conceptProblems(text)
    problems.push(...found.map(p => `${path}: ${p}`))
  }
  return problems
}

function conceptProblems(text: string): string[] {
  const match = FRONTMATTER.exec(text)
  if (!match) return ['no frontmatter block']
  let meta: unknown
  try { meta = Bun.YAML.parse(match[1]) } catch (e) { return [`frontmatter is not YAML: ${(e as Error).message}`] }
  const type = (meta as { type?: unknown } | null)?.type
  return typeof type === 'string' && type.trim() ? [] : ['no non-empty type']
}

function indexProblems(path: string, text: string, files: Map<string, string>): string[] {
  const problems: string[] = []
  const match = FRONTMATTER.exec(text)
  if (match) {
    const keys = Object.keys((Bun.YAML.parse(match[1]) ?? {}) as object)
    if (path !== 'index.md' || keys.some(k => k !== 'okf_version')) problems.push(`frontmatter other than a root okf_version: ${keys.join(', ')}`)
  }
  const lines = text.slice(match?.[0].length ?? 0).split('\n').filter(l => l.trim())
  if (!lines[0]?.startsWith('#')) problems.push('does not start with a section heading')
  const dir = path.slice(0, -'index.md'.length)
  for (const line of lines.filter(l => !l.startsWith('#'))) {
    const href = ENTRY.exec(line)?.[1]
    if (!href) problems.push(`not an index entry: ${line}`)
    else if (!resolves(dir + decodeURI(href), files)) problems.push(`entry links nowhere: ${href}`)
  }
  return problems
}

/** A file in the bundle, or a directory holding one. */
const resolves = (target: string, files: Map<string, string>) =>
  target.endsWith('/') ? [...files.keys()].some(p => p.startsWith(target)) : files.has(target)
