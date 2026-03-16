import { generateText } from 'ai'
import { getChatModel } from '../llm.ts'

const VISION_PROMPT = 'Extract all text and describe the content of this image in detail. Focus on any text, data, or key visual elements.'

/** Describe/OCR an image. Uses vision LLM; falls back to tesseract.js. */
export async function extractImageText(buffer: ArrayBuffer, mimeType: string): Promise<string> {
  try {
    return await visionLLM(buffer, mimeType)
  } catch {
    return tesseractFallback(buffer)
  }
}

async function visionLLM(buffer: ArrayBuffer, mimeType: string): Promise<string> {
  const base64 = Buffer.from(buffer).toString('base64')
  const { text } = await generateText({
    model: getChatModel(),
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', image: `data:${mimeType};base64,${base64}` },
          { type: 'text', text: VISION_PROMPT },
        ],
      },
    ],
  })
  return text
}

async function tesseractFallback(buffer: ArrayBuffer): Promise<string> {
  const { createWorker } = await import('tesseract.js')
  const worker = await createWorker('eng')
  try {
    const { data } = await worker.recognize(Buffer.from(buffer))
    return data.text
  } finally {
    await worker.terminate()
  }
}
