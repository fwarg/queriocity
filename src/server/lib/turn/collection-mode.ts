import { generateText } from 'ai'
import { languageModel, modelTarget } from '../llm.ts'
import { withoutThinking } from '../files/collection-digests.ts'
import { splitAttachments, type CollectionMode } from '../../../shared/context.ts'
import { userQueryOf, type TurnContext, type TurnSink } from './context.ts'

/** Auto: the small model picks how a message reads the picked collections — one short call, before
 *  anything else is read. Said in the footer, so the user learns how it decides and can override. */

/** A choice is quick or not worth waiting for: excerpts are the safe default. */
const CHOOSE_TIMEOUT_MS = 20_000

const CHOOSE_SYSTEM = `You decide how to answer a message about a collection of documents. Reply with one word — excerpts, whole or explore — then " - " and a reason of at most 12 words.
excerpts: the answer is a fact or passage found in one or a few places in the documents.
whole: the message is about the collection as a whole — summarise, compare, report on, or review something against all of it.
explore: a targeted question across the documents — which of them do or say something, where something is discussed, or checking specific claims (for instance of an attached draft) against them.
A message asking which documents or papers discuss something is explore, also when it asks to summarise what they say.`

export type ChosenMode = Exclude<CollectionMode, 'auto'>

export interface ModeChoice {
  mode: ChosenMode
  reason: string
}

/** The mode a turn reads its collections in: as asked, or chosen when the turn asked for auto. */
export async function collectionModeFor(ctx: TurnContext, sink: TurnSink): Promise<ChosenMode> {
  const asked = ctx.collectionMode ?? 'excerpts'
  if (asked !== 'auto') return asked
  await sink.emit({ type: 'status', text: 'Choosing how to read the collection…' })
  const choice = await chooseMode(userQueryOf(ctx.msgs), ctx.collections.length, ctx.abortSignal)
  console.log(`  [collection] auto chose ${choice.mode} — ${choice.reason}`)
  await sink.emit({ type: 'collection_mode', mode: choice.mode, reason: choice.reason })
  return choice.mode
}

/** The small model's choice for this message; excerpts when it cannot say. */
export async function chooseMode(message: string, collections: number, abortSignal?: AbortSignal): Promise<ModeChoice> {
  const { text, attachments } = splitAttachments(message)
  const prompt = `Collections picked: ${collections}${attachments ? '\nThe user attached a document to the message.' : ''}\nMessage: ${text.slice(0, 2000)}`
  try {
    const { text: reply } = await generateText({
      model: languageModel(modelTarget('small')),
      system: CHOOSE_SYSTEM,
      prompt,
      maxOutputTokens: 60,
      abortSignal: abortSignal ? AbortSignal.any([abortSignal, AbortSignal.timeout(CHOOSE_TIMEOUT_MS)]) : AbortSignal.timeout(CHOOSE_TIMEOUT_MS),
    })
    return parseChoice(withoutThinking(reply))
  } catch (e) {
    if (abortSignal?.aborted) throw e
    console.error('  [collection] auto choice failed, using excerpts:', e)
    return { mode: 'excerpts', reason: 'the choice could not be made' }
  }
}

/** `explore - a targeted question` → the mode and reason; excerpts when the reply names no mode. */
export function parseChoice(reply: string): ModeChoice {
  const match = reply.trim().match(/^\W*(excerpts|whole|explore)\b\W*(.*)$/is)
  if (!match) return { mode: 'excerpts', reason: 'the choice could not be read' }
  return { mode: match[1].toLowerCase() as ChosenMode, reason: match[2].trim().slice(0, 120) }
}
