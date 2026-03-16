import * as pdfjs from 'pdfjs-dist'

// Suppress worker warning in Node/Bun
pdfjs.GlobalWorkerOptions.workerSrc = ''

/** Extract all text from a PDF buffer, chunked by page. */
export async function extractPdfChunks(buffer: ArrayBuffer): Promise<string[]> {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise
  const chunks: string[] = []

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    const text = content.items
      .filter(item => 'str' in item)
      .map(item => (item as { str: string }).str)
      .join(' ')
      .trim()
    if (text) chunks.push(text)
  }

  return chunks
}
