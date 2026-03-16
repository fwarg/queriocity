import pdfParse from 'pdf-parse'

/** Extract text from a PDF buffer, one chunk per page. */
export async function extractPdfChunks(buffer: ArrayBuffer): Promise<string[]> {
  const { text } = await pdfParse(Buffer.from(buffer))
  // pdf-parse joins all pages; split on form-feed characters (page breaks)
  return text
    .split(/\f/)
    .map(p => p.trim())
    .filter(p => p.length > 0)
}
