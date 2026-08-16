import { eq } from 'drizzle-orm'
import { db, uploadedFiles, getAppSetting } from '../db.ts'
import { generateText } from 'ai'
import { getSmallModel, SMALL_MODEL_INPUT_CHARS } from '../llm.ts'

/** A one-line summary and a few topics per resource, so a library of two hundred documents can be
 *  read at a glance instead of by filename.
 *
 *  Best-effort by design: every caller writes the resource row first and calls this afterwards, and
 *  a failure here leaves both columns null. Nothing reads them but the list and the detail panel. */

export interface ResourceDescription {
  summary: string
  topics: string[]
}

const SYSTEM = `You describe a document for a research library.
Respond with ONLY a JSON object:
{"summary":"one sentence, max 25 words, stating what the document is and what it covers","topics":["topic","topic","topic"]}
Give 3 to 5 topics, each one to three words, in the language the document is written in.`

/** True unless an admin has turned summarising off — read per call, like every other app setting. */
export const resourceSummaryEnabled = async (): Promise<boolean> =>
  (await getAppSetting('resource_summary', 'true')) === 'true'

export async function summariseResource(text: string): Promise<ResourceDescription | null> {
  const { text: reply } = await generateText({
    model: getSmallModel(),
    system: SYSTEM,
    prompt: text.slice(0, SMALL_MODEL_INPUT_CHARS),
    maxOutputTokens: 300,
    abortSignal: AbortSignal.timeout(60_000),
  })
  // Same tolerant extraction as the memory reconciler: small models fence their JSON as often as not.
  const json = reply.replace(/```(?:json)?/g, '').trim()
  const start = json.indexOf('{')
  if (start === -1) return null
  const parsed = JSON.parse(json.slice(start, json.lastIndexOf('}') + 1)) as Partial<ResourceDescription>

  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : ''
  if (!summary) return null
  const topics = (Array.isArray(parsed.topics) ? parsed.topics : [])
    .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    .map(t => t.trim())
    .slice(0, 5)
  return { summary, topics }
}

/** Summarise a stored resource and write the result to its row. Never throws. */
export async function describeResource(fileId: string, text: string): Promise<void> {
  if (!await resourceSummaryEnabled()) return
  try {
    const described = await summariseResource(text)
    if (!described) return
    await db.update(uploadedFiles)
      .set({ summary: described.summary, topics: JSON.stringify(described.topics) })
      .where(eq(uploadedFiles.id, fileId))
  } catch (e) {
    console.warn(`  [summarise] skipped for ${fileId}: ${e instanceof Error ? e.message : e}`)
  }
}
