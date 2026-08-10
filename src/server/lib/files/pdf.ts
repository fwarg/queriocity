import { PDFParse } from 'pdf-parse'

/** Extract text from a PDF buffer, one chunk per page.
 *
 *  v2 reports pages individually, so this no longer splits the whole document on form feeds —
 *  a heuristic that merged pages whenever the producer omitted the break, and split mid-page
 *  whenever a form feed appeared in the content. */
export async function extractPdfChunks(buffer: ArrayBuffer): Promise<string[]> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) })
  try {
    const { pages } = await parser.getText()
    return pages.map(p => p.text.trim()).filter(p => p.length > 0)
  } finally {
    // Holds a pdf.js worker open otherwise, which keeps the process alive.
    await parser.destroy()
  }
}
