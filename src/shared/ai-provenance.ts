/** Machine-readable marking of AI-generated images, for EU AI Act Art 50(2).
 *
 *  Shared between server and client: the server marks images as they are written, and the client
 *  re-marks them after the optional caption canvas pass, which discards all metadata.
 *
 *  The marking carries IPTC DigitalSourceType — the field the industry converged on for this — as
 *  XMP: an iTXt chunk for PNG, a `<metadata>` element for SVG. Nothing here decodes the image; the
 *  PNG chunk is spliced into the byte stream, so a malformed file passes through untouched rather
 *  than being corrupted. */

/** IPTC DigitalSourceType for media created wholly by a generative model. Editing a generated
 *  image keeps this value; `compositeWithTrainedAlgorithmicMedia` would apply only if a real
 *  photograph could be used as the base, which the edit tool does not allow. */
const TRAINED_ALGORITHMIC_MEDIA =
  'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia'

const XMP_KEYWORD = 'XML:com.adobe.xmp'
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** Namespace for the one property with no standard home. `xmp:CreatorTool` means the software, so
 *  the generating model needs somewhere else to live; there is no agreed XMP field for it yet. */
const QUERIOCITY_NS = 'https://github.com/fredrikwarg/queriocity/ns/1.0/'

function escapeXml(value: string): string {
  return value.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!)
}

/** The prompt is deliberately absent: it would travel with any shared image and expose what the
 *  user asked for. Art 50 asks for provenance, not for the input. */
function xmpPacket(creatorTool: string, model?: string): string {
  // Named in CreatorTool too — that field is free text, and plenty of readers show only it.
  const tool = model ? `${creatorTool} (model: ${model})` : creatorTool
  const modelProperty = model ? `\n   <q:GenerativeModel>${escapeXml(model)}</q:GenerativeModel>` : ''
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:q="${QUERIOCITY_NS}">
   <photoshop:DigitalSourceType>${TRAINED_ALGORITHMIC_MEDIA}</photoshop:DigitalSourceType>
   <xmp:CreatorTool>${escapeXml(tool)}</xmp:CreatorTool>${modelProperty}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`
}

let crcTable: Uint32Array | null = null

/** CRC-32/ISO-HDLC, as PNG specifies. Written out rather than taken from a runtime API so that
 *  server and browser share one implementation. */
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c
    }
  }
  let crc = 0xffffffff
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** Build a complete PNG chunk: length, type, data, CRC. */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type)
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(typeBytes, 4)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/** An uncompressed iTXt chunk body: keyword, compression flag and method, empty language and
 *  translated-keyword fields, then UTF-8 text. */
function itxtBody(keyword: string, text: string): Uint8Array {
  const enc = new TextEncoder()
  const kw = enc.encode(keyword)
  const body = enc.encode(text)
  const out = new Uint8Array(kw.length + 5 + body.length)
  out.set(kw, 0)
  // kw NUL, compression flag 0, compression method 0, language NUL, translated keyword NUL
  out.set([0, 0, 0, 0, 0], kw.length)
  out.set(body, kw.length + 5)
  return out
}

function isPng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((b, i) => bytes[i] === b)
}

/** Byte offset just past IHDR, where an ancillary chunk may legally go. -1 if this is not a PNG. */
function afterIhdr(png: Uint8Array): number {
  if (png.length < 8 || !isPng(png)) return -1
  const ihdrLength = new DataView(png.buffer, png.byteOffset).getUint32(8)
  const end = 8 + 12 + ihdrLength
  return end > png.length ? -1 : end
}

function spliceChunk(png: Uint8Array, marker: Uint8Array): Uint8Array {
  const insertAt = afterIhdr(png)
  if (insertAt < 0) return png
  const out = new Uint8Array(png.length + marker.length)
  out.set(png.subarray(0, insertAt), 0)
  out.set(marker, insertAt)
  out.set(png.subarray(insertAt), insertAt + marker.length)
  return out
}

/** Insert the AI-provenance XMP chunk into a PNG, returning the original bytes if it is not one. */
export function markPng(png: Uint8Array, creatorTool: string, model?: string): Uint8Array {
  return spliceChunk(png, chunk('iTXt', itxtBody(XMP_KEYWORD, xmpPacket(creatorTool, model))))
}

/** The provenance chunk from an already-marked PNG, whole and ready to re-insert, or null.
 *
 *  Re-encoding an image (the caption canvas) drops it, and regenerating it from scratch would lose
 *  whatever the server recorded — the generating model above all, which the browser never learns.
 *  Carrying the original chunk across keeps the marking faithful to what actually produced it. */
export function extractProvenanceChunk(png: Uint8Array): Uint8Array | null {
  if (afterIhdr(png) < 0) return null
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const expected = new TextEncoder().encode(`${XMP_KEYWORD}\0`)
  for (let i = 8; i + 12 <= png.length;) {
    const length = view.getUint32(i)
    const type = String.fromCharCode(...png.subarray(i + 4, i + 8))
    if (i + 12 + length > png.length) return null
    if (type === 'iTXt') {
      const data = png.subarray(i + 8, i + 8 + length)
      const keywordMatches = expected.every((b, n) => data[n] === b)
      // Other XMP packets can ride along; only ours declares the IPTC source type.
      if (keywordMatches && new TextDecoder().decode(data).includes(TRAINED_ALGORITHMIC_MEDIA)) {
        return png.slice(i, i + 12 + length)
      }
    }
    if (type === 'IEND') break
    i += 12 + length
  }
  return null
}

/** Re-apply a chunk taken from `extractProvenanceChunk`, falling back to a fresh marking. */
export function reapplyProvenance(png: Uint8Array, original: Uint8Array | null, creatorTool: string): Uint8Array {
  return original ? spliceChunk(png, original) : markPng(png, creatorTool)
}

/** Add the same provenance to a model-authored SVG, as an XMP `<metadata>` element.
 *
 *  Returns the input unchanged if it does not open with an `<svg>` tag — the models emit these
 *  inline in answers, so malformed ones do reach here. */
export function markSvg(svg: string, creatorTool: string, model?: string): string {
  const openTag = svg.match(/<svg\b[^>]*>/i)
  if (!openTag) return svg
  const at = openTag.index! + openTag[0].length
  return `${svg.slice(0, at)}\n<metadata>${xmpPacket(creatorTool, model)}</metadata>${svg.slice(at)}`
}
