import { describe, test, expect } from 'bun:test'
import { markPng, markSvg, extractProvenanceChunk, reapplyProvenance } from './ai-provenance.ts'

// A 1x1 PNG. Chunk order after marking must be IHDR, iTXt, then the original chunks — iTXt is
// ancillary, but decoders only reliably associate XMP with the image when it precedes IDAT.
const TINY_PNG = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
))

/** Walk the chunk list, verifying each CRC as it goes. */
function chunks(png: Uint8Array): Array<{ type: string; data: Uint8Array; crcValid: boolean }> {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const out = []
  for (let i = 8; i < png.length;) {
    const length = view.getUint32(i)
    const type = new TextDecoder().decode(png.subarray(i + 4, i + 8))
    const data = png.subarray(i + 8, i + 8 + length)
    const crc = view.getUint32(i + 8 + length)
    out.push({ type, data, crcValid: Bun.hash.crc32(png.subarray(i + 4, i + 8 + length)) === crc })
    i += 12 + length
    if (type === 'IEND') break
  }
  return out
}

describe('markPng', () => {
  const marked = markPng(TINY_PNG, 'Queriocity 1.2.3')
  const parsed = chunks(marked)

  test('inserts a single iTXt chunk directly after IHDR', () => {
    expect(parsed.map(c => c.type)).toEqual(['IHDR', 'iTXt', 'IDAT', 'IEND'])
  })

  test('writes valid CRCs', () => {
    expect(parsed.every(c => c.crcValid)).toBe(true)
  })

  test('declares IPTC trained-algorithmic-media provenance and the creator tool', () => {
    const text = new TextDecoder().decode(parsed[1]!.data)
    expect(text.startsWith('XML:com.adobe.xmp\0')).toBe(true)
    expect(text).toContain('cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia')
    expect(text).toContain('<xmp:CreatorTool>Queriocity 1.2.3</xmp:CreatorTool>')
  })

  // The prompt would otherwise travel with any image the user shares.
  test('does not embed the generation prompt', () => {
    expect(new TextDecoder().decode(marked)).not.toContain('prompt')
  })

  test('leaves the image data untouched', () => {
    const before = chunks(TINY_PNG).find(c => c.type === 'IDAT')!
    expect(parsed.find(c => c.type === 'IDAT')!.data).toEqual(before.data)
  })

  test('passes through anything that is not a PNG', () => {
    const notPng = new Uint8Array([1, 2, 3, 4])
    expect(markPng(notPng, 'Queriocity')).toBe(notPng)
    expect(markPng(new Uint8Array(0), 'Queriocity')).toHaveLength(0)
  })
})

describe('generating model', () => {
  test('is recorded as its own property and inside the free-text creator tool', () => {
    const text = new TextDecoder().decode(markPng(TINY_PNG, 'Queriocity 1.2.3', 'sdxl-turbo'))
    expect(text).toContain('<q:GenerativeModel>sdxl-turbo</q:GenerativeModel>')
    expect(text).toContain('<xmp:CreatorTool>Queriocity 1.2.3 (model: sdxl-turbo)</xmp:CreatorTool>')
  })

  test('is omitted entirely when the server has no model configured', () => {
    const text = new TextDecoder().decode(markPng(TINY_PNG, 'Queriocity 1.2.3'))
    expect(text).not.toContain('GenerativeModel')
    expect(text).toContain('<xmp:CreatorTool>Queriocity 1.2.3</xmp:CreatorTool>')
  })

  test('escapes characters that would break the XMP packet', () => {
    const text = new TextDecoder().decode(markPng(TINY_PNG, 'Queriocity', 'a<b&c"d'))
    expect(text).toContain('<q:GenerativeModel>a&lt;b&amp;c&quot;d</q:GenerativeModel>')
  })
})

// The caption canvas drops every chunk it does not understand, so the download path lifts the
// original chunk across rather than rebuilding one — the browser never learns the model name.
describe('provenance round-trip through a re-encode', () => {
  const marked = markPng(TINY_PNG, 'Queriocity 1.2.3', 'sdxl-turbo')

  test('extracts the chunk it wrote', () => {
    const extracted = extractProvenanceChunk(marked)
    expect(extracted).not.toBeNull()
    expect(new TextDecoder().decode(extracted!)).toContain('sdxl-turbo')
  })

  test('finds nothing in an unmarked or non-PNG file', () => {
    expect(extractProvenanceChunk(TINY_PNG)).toBeNull()
    expect(extractProvenanceChunk(new Uint8Array([1, 2, 3, 4]))).toBeNull()
  })

  test('re-applying carries the model onto the re-encoded image', () => {
    const reencoded = reapplyProvenance(TINY_PNG, extractProvenanceChunk(marked), 'Queriocity 9.9.9')
    const parsed = chunks(reencoded)
    expect(parsed.map(c => c.type)).toEqual(['IHDR', 'iTXt', 'IDAT', 'IEND'])
    expect(parsed.every(c => c.crcValid)).toBe(true)
    const text = new TextDecoder().decode(parsed[1]!.data)
    expect(text).toContain('sdxl-turbo')
    expect(text).not.toContain('9.9.9')
  })

  test('falls back to a fresh marking when the original had none', () => {
    const text = new TextDecoder().decode(reapplyProvenance(TINY_PNG, null, 'Queriocity 9.9.9'))
    expect(text).toContain('<xmp:CreatorTool>Queriocity 9.9.9</xmp:CreatorTool>')
    expect(text).toContain('trainedAlgorithmicMedia')
  })
})

describe('markSvg', () => {
  test('inserts metadata directly after the opening tag', () => {
    const marked = markSvg('<svg viewBox="0 0 10 10"><rect /></svg>', 'Queriocity 1.2.3')
    expect(marked.startsWith('<svg viewBox="0 0 10 10">\n<metadata>')).toBe(true)
    expect(marked).toContain('digitalsourcetype/trainedAlgorithmicMedia')
    expect(marked.endsWith('<rect /></svg>')).toBe(true)
  })

  // Models emit SVG inline in answers, so truncated and malformed ones do reach here.
  test('leaves anything without an opening svg tag alone', () => {
    expect(markSvg('not markup at all', 'Queriocity')).toBe('not markup at all')
    expect(markSvg('<svg viewBox="0 0 1 1"', 'Queriocity')).toBe('<svg viewBox="0 0 1 1"')
  })
})
