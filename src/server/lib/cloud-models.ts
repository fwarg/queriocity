/** Resolves a user's per-message model pick — cloud, or a larger model on the local network — into
 *  the models a turn runs on. Everything that could refuse the pick is checked here, so a refused
 *  pick falls back to the default models with a reason. */

import { localTurnModels, type TurnModels } from './llm.ts'
import { loadCatalogue, cloudTarget } from './llm-catalogue.ts'
import { getLlmAccess, userSpend, providerSpend, meteredUsage } from './llm-usage.ts'
import { isLocalEndpoint } from './space-lock.ts'
import type { AnswerModel, CloudModel, CloudProvider, ModelFallbackReason, PickableModel } from '../../shared/llm-catalogue.ts'


const FALLBACK_MESSAGES: Record<ModelFallbackReason, string> = {
  locked: 'This space is locked, so the answer stays on the default local model.',
  mode: 'The chosen model does not apply to this mode; answered with the default model.',
  unavailable: 'The chosen model is not available; answered with the default model.',
  not_allowed: 'Choosing models is not enabled for your account; answered with the default model.',
  unacknowledged: 'Cloud models need your confirmation first that the message leaves this server; answered with the default model.',
  budget: 'Your monthly budget for this provider is used up; answered with the default model.',
  cap: 'The monthly limit for this provider is reached; answered with the default model.',
}

export interface ResolvedModels {
  models: TurnModels
  /** The catalogue entry the turn runs on, and its provider, when the pick was honoured. */
  cloud?: CloudModel
  provider?: CloudProvider
  /** Set when a pick was refused. */
  fallback?: { reason: ModelFallbackReason; message: string }
  /** A thinking-only pick switches thinking on for this turn, whatever the user's setting. */
  forceThinking: boolean
}

interface PickRequest {
  userId: string
  modelId?: string
  focusMode: 'flash' | 'balanced' | 'thorough' | 'image'
  locked: boolean
  /** The user has confirmed that a cloud model is sent the whole prompt. */
  cloudAcknowledged: boolean
}

/** The turn's models: the defaults, or the picked model in the slots its role allows. */
export async function resolveTurnModels({ userId, modelId, focusMode, locked, cloudAcknowledged }: PickRequest): Promise<ResolvedModels> {
  const models = localTurnModels()
  if (!modelId) return { models, forceThinking: false }
  const refuse = (reason: ModelFallbackReason): ResolvedModels => {
    console.log(`  [cloud] pick "${modelId}" refused for user ${userId}: ${reason}`)
    return { models, forceThinking: false, fallback: { reason, message: FALLBACK_MESSAGES[reason] } }
  }
  if (focusMode === 'image') return refuse('mode')

  const catalogue = await loadCatalogue()
  const entry = catalogue.models.find(m => m.id === modelId)
  const provider = entry && catalogue.providers.find(p => p.id === entry.providerId)
  const target = cloudTarget(catalogue, modelId)
  if (!entry?.enabled || !provider?.enabled || !target) return refuse('unavailable')
  if (locked && !allowedWhenLocked(provider)) return refuse('locked')
  if (entry.role === 'thinking' && focusMode !== 'thorough') return refuse('mode')

  const access = getLlmAccess(userId)
  const budget = access.budgets[provider.id]
  if (!access.cloudEnabled || budget === undefined) return refuse('not_allowed')
  // Enforced here as well as asked in the client, so no client path can send to the cloud unconfirmed.
  if (provider.kind === 'cloud' && !cloudAcknowledged) return refuse('unacknowledged')
  const spendRefusal = provider.kind === 'cloud' && overSpend(userId, provider, budget)
  if (spendRefusal) return refuse(spendRefusal)

  // Local providers run on your own hardware: nothing to meter.
  const cloud = provider.kind === 'cloud' ? { ...target, onUsage: meteredUsage(userId, entry) } : target
  const usesChat = entry.role !== 'thinking'
  const usesThinking = entry.role !== 'chat'
  console.log(`  [cloud] turn on ${provider.id}/${entry.model} for user ${userId} (${provider.kind}, ${entry.role})`)
  return {
    models: {
      chat: usesChat ? cloud : models.chat,
      // Flash follows a chat pick, by decision.
      flash: usesChat ? cloud : models.flash,
      thinking: usesThinking ? cloud : models.thinking,
    },
    cloud: entry,
    provider,
    forceThinking: entry.role === 'thinking',
  }
}

/** The picked model as stored with the answer and named to the client; undefined for the defaults. */
export const answerModelOf = ({ cloud, provider }: ResolvedModels): AnswerModel | undefined =>
  cloud && provider ? { id: cloud.id, label: cloud.label, kind: provider.kind, provider: provider.label } : undefined

/** A locked space keeps its documents on this network, so only a local provider that is on it qualifies. */
const allowedWhenLocked = (p: CloudProvider) => p.kind === 'local' && isLocalEndpoint(p.baseURL)

/** Checked before the turn only: one turn may overshoot by its own cost, bounded by its output caps. */
function overSpend(userId: string, provider: CloudProvider, budget: number): ModelFallbackReason | null {
  if (userSpend(userId, provider.id) >= budget) return 'budget'
  if (capReached(provider)) return 'cap'
  return null
}

const capReached = (p: CloudProvider) => p.monthlyCap > 0 && providerSpend(p.id) >= p.monthlyCap

/** The models a user may pick now: enabled, keyed, granted, and — for cloud — with budget and cap left. */
export async function pickableModels(userId: string): Promise<PickableModel[]> {
  const access = getLlmAccess(userId)
  if (!access.cloudEnabled) return []
  const catalogue = await loadCatalogue()
  return catalogue.models.flatMap(m => {
    const provider = catalogue.providers.find(p => p.id === m.providerId)
    const budget = provider && access.budgets[provider.id]
    if (!m.enabled || !provider?.enabled || budget === undefined || !cloudTarget(catalogue, m.id)) return []
    if (provider.kind === 'local') return [toPickable(m, provider, undefined)]
    const remaining = budget - userSpend(userId, provider.id)
    return remaining > 0 && !capReached(provider) ? [toPickable(m, provider, remaining)] : []
  })
}

const toPickable = (m: CloudModel, p: CloudProvider, remaining: number | undefined): PickableModel => ({
  id: m.id, label: m.label, role: m.role, providerId: p.id, providerLabel: p.label, kind: p.kind,
  ...(remaining !== undefined && { remaining, currency: p.currency }),
  allowedWhenLocked: allowedWhenLocked(p),
})
