/** Resolves a user's per-message cloud model pick into the models a turn runs on. Everything that
 *  could refuse the pick is checked here, so a refused pick falls back to the local models with a reason. */

import { localTurnModels, type TurnModels } from './llm.ts'
import { loadCatalogue, cloudTarget } from './llm-catalogue.ts'
import { getLlmAccess, userSpend, providerSpend, meteredUsage } from './llm-usage.ts'
import type { CloudModel } from '../../shared/llm-catalogue.ts'

/** Why a cloud pick was not honoured; the client words the notice from this. */
export type CloudFallbackReason = 'locked' | 'mode' | 'unavailable' | 'not_allowed' | 'budget' | 'cap'

const FALLBACK_MESSAGES: Record<CloudFallbackReason, string> = {
  locked: 'This space is locked, so the answer stays on the local model.',
  mode: 'The chosen cloud model does not apply to this mode; answered with the local model.',
  unavailable: 'The chosen cloud model is not available; answered with the local model.',
  not_allowed: 'Cloud models are not enabled for your account; answered with the local model.',
  budget: 'Your monthly budget for this provider is used up; answered with the local model.',
  cap: 'The monthly limit for this provider is reached; answered with the local model.',
}

export interface ResolvedModels {
  models: TurnModels
  /** The catalogue entry the turn runs on, when the pick was honoured. */
  cloud?: CloudModel
  /** Set when a pick was refused. */
  fallback?: { reason: CloudFallbackReason; message: string }
  /** A thinking-only pick switches thinking on for this turn, whatever the user's setting. */
  forceThinking: boolean
}

interface PickRequest {
  userId: string
  modelId?: string
  focusMode: 'flash' | 'balanced' | 'thorough' | 'image'
  locked: boolean
}

/** The turn's models: local, or the picked cloud model in the slots its role allows. */
export async function resolveTurnModels({ userId, modelId, focusMode, locked }: PickRequest): Promise<ResolvedModels> {
  const models = localTurnModels()
  if (!modelId) return { models, forceThinking: false }
  const refuse = (reason: CloudFallbackReason): ResolvedModels => {
    console.log(`  [cloud] pick "${modelId}" refused for user ${userId}: ${reason}`)
    return { models, forceThinking: false, fallback: { reason, message: FALLBACK_MESSAGES[reason] } }
  }
  if (locked) return refuse('locked')
  if (focusMode === 'image') return refuse('mode')

  const catalogue = await loadCatalogue()
  const entry = catalogue.models.find(m => m.id === modelId)
  const provider = entry && catalogue.providers.find(p => p.id === entry.providerId)
  const target = cloudTarget(catalogue, modelId)
  if (!entry?.enabled || !provider?.enabled || !target) return refuse('unavailable')
  if (entry.role === 'thinking' && focusMode !== 'thorough') return refuse('mode')

  const access = getLlmAccess(userId)
  const budget = access.budgets[provider.id]
  if (!access.cloudEnabled || budget === undefined) return refuse('not_allowed')
  // Checked before the turn only: one turn may overshoot by its own cost, bounded by its output caps.
  if (userSpend(userId, provider.id) >= budget) return refuse('budget')
  if (provider.monthlyCap > 0 && providerSpend(provider.id) >= provider.monthlyCap) return refuse('cap')

  const cloud = { ...target, onUsage: meteredUsage(userId, entry) }
  const usesChat = entry.role !== 'thinking'
  const usesThinking = entry.role !== 'chat'
  console.log(`  [cloud] turn on ${provider.id}/${entry.model} for user ${userId} (${entry.role})`)
  return {
    models: {
      chat: usesChat ? cloud : models.chat,
      // Flash follows a chat pick, by decision.
      flash: usesChat ? cloud : models.flash,
      thinking: usesThinking ? cloud : models.thinking,
    },
    cloud: entry,
    forceThinking: entry.role === 'thinking',
  }
}
