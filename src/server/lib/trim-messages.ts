import type { CoreMessage } from 'ai'

const estimate = (s: string) => Math.ceil(s.length / 4)

// Trims oldest messages so estimated tokens fit within maxTokens.
// Pass systemPrompt so its cost is reserved from the budget.
export function trimMessages(messages: CoreMessage[], maxTokens: number, systemPrompt = ''): CoreMessage[] {
  const systemCost = estimate(systemPrompt)
  const budget = maxTokens - systemCost
  if (budget <= 0) {
    console.warn(`[chat] system prompt alone (~${systemCost} tok) exceeds context budget ${maxTokens}`)
    return messages.slice(-1)
  }

  let total = messages.reduce((sum, m) => sum + estimate(JSON.stringify(m)), 0)
  if (total <= budget) return messages

  let start = 0
  while (total > budget && start < messages.length - 1) {
    total -= estimate(JSON.stringify(messages[start]))
    start++
    // Drop orphaned tool results at the front, but never the last message
    while (start < messages.length - 1 && messages[start].role === 'tool') {
      total -= estimate(JSON.stringify(messages[start]))
      start++
    }
  }
  console.warn(`[chat] context trim: dropped first ${start} messages (system ~${systemCost} tok, budget ${budget} tok)`)
  const trimmed = messages.slice(start)
  // Strip any leading tool message left orphaned after its tool-call was dropped
  const firstNonTool = trimmed.findIndex(m => m.role !== 'tool')
  return firstNonTool > 0 ? trimmed.slice(firstNonTool) : trimmed
}
