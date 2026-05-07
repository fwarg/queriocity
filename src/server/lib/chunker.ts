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
        const c = seg.slice(i, i + size)
        if (c.length >= minLen) chunks.push(c)
      }
      buf = seg.slice(-Math.min(overlap, seg.length))
      continue
    }
    const next = buf ? buf + ' ' + seg : seg
    if (next.length > size) {
      if (buf.length >= minLen) chunks.push(buf)
      const seed = buf.length > overlap ? buf.slice(-overlap) : buf
      buf = seed ? seed + ' ' + seg : seg
    } else {
      buf = next
    }
  }
  if (buf.length >= minLen) chunks.push(buf)
  return chunks
}
