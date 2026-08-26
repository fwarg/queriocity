const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff

/** Drops a half-character left at either end by slicing.
 *
 *  A JS string index counts UTF-16 code units, so an emoji is two of them and `slice` will happily
 *  cut between them. The orphan survives every later step — until `JSON.stringify` writes it out
 *  verbatim and the embedding server rejects the request with "invalid high surrogate in string",
 *  failing the whole batch. One emoji at an unlucky offset in one document therefore fails the
 *  entire ingest, which is how this was found: a GitHub README, dense with emoji.
 *
 *  Dropping is lossless in context — chunks overlap, so the character appears whole in the
 *  neighbouring chunk. */
function trimOrphanSurrogates(text: string): string {
  let start = 0
  let end = text.length
  if (isLowSurrogate(text.charCodeAt(start))) start++
  if (end > start && isHighSurrogate(text.charCodeAt(end - 1))) end--
  return start === 0 && end === text.length ? text : text.slice(start, end)
}

/** Split text into overlapping chunks at paragraph/sentence boundaries. */
export function semanticChunk(text: string, size: number, overlap: number, minLen = 0): string[] {
  const segments = text
    .split(/\n\n+/)
    .flatMap(para => para.split(/(?<=[.!?])\s+/))
    .map(s => s.trim())
    .filter(Boolean)

  const chunks: string[] = []
  let buf = ''

  for (const seg of segments) {
    if (seg.length > size) {
      // Oversized segment: flush buf, char-split with overlap
      if (buf.length >= minLen) chunks.push(buf)
      for (let i = 0; i < seg.length; i += size - overlap) {
        const c = trimOrphanSurrogates(seg.slice(i, i + size))
        if (c.length >= minLen) chunks.push(c)
      }
      buf = trimOrphanSurrogates(seg.slice(-Math.min(overlap, seg.length)))
      continue
    }
    const next = buf ? buf + ' ' + seg : seg
    if (next.length > size) {
      if (buf.length >= minLen) chunks.push(buf)
      const seed = buf.length > overlap ? trimOrphanSurrogates(buf.slice(-overlap)) : buf
      buf = seed ? seed + ' ' + seg : seg
    } else {
      buf = next
    }
  }
  if (buf.length >= minLen) chunks.push(buf)
  return chunks
}
