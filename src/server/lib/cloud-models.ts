/** Resolves a user's per-message model pick — cloud, or a larger model on the local network — into
 *  the models a turn runs on. Everything that could refuse the pick is checked here, so a refused
 *  pick falls back to the default models with a reason. */

import { localTurnModels, displayName, type ModelTarget, type TokenUsage, type TurnModels } from './llm.ts'
import { loadCatalogue, cloudTarget } from './llm-catalogue.ts'
import { getLlmAccess, userSpend, providerSpend, meteredUsage, addAnswerCost } from './llm-usage.ts'
import { isLocalEndpoint } from './space-lock.ts'
import { meterBudgetChars } from './trim-messages.ts'
import type { AnswerModel, CloudModel, CloudProvider, ModelChoices, ModelFallbackReason, PickableModel } from '../../shared/llm-catalogue.ts'


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
  /** Filled in as the turn's calls report it: the first error (any model), and for a cloud pick the
   *  hosting provider and the cost so far. */
  observed: TurnObserved
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
  const observed: TurnObserved = {}
  const onError = (message: string) => { observed.error ??= message }
  // The default models report their errors too: a local server failing is otherwise only in the server log.
  const local = localTurnModels()
  const models: TurnModels = { chat: { ...local.chat, onError }, thinking: { ...local.thinking, onError }, flash: { ...local.flash, onError } }
  if (!modelId) return { models, observed, forceThinking: false }
  const refuse = (reason: ModelFallbackReason): ResolvedModels => {
    console.log(`  [cloud] pick "${modelId}" refused for user ${userId}: ${reason}`)
    return { models, observed, forceThinking: false, fallback: { reason, message: FALLBACK_MESSAGES[reason] } }
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

  // Local providers run on your own hardware: nothing to meter, but their errors are reported.
  const cloud = provider.kind === 'cloud'
    ? {
        ...target,
        onUsage: meteredUsage(userId, entry, provider, {
          onCall: (u, cost) => observeCall(observed, u, cost),
          endpoint: target,
          onCorrection: delta => correctAnswer(observed, delta),
        }),
        onError,
      }
    : { ...target, onError }
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
    observed,
    forceThinking: entry.role === 'thinking',
  }
}

interface TurnObserved {
  via?: string
  cost?: number
  /** The first error a call of this turn failed with, as the provider worded it. */
  error?: string
  /** The stored answer, once saved, so a late cost correction reaches it. */
  messageId?: string
  /** Corrections that arrived before the answer was saved. */
  pendingCorrection?: number
}

/** A stopped call's real cost arrived: correct the stored answer, or hold it until it is stored. */
function correctAnswer(observed: TurnObserved, delta: number) {
  if (observed.messageId) addAnswerCost(observed.messageId, delta)
  else observed.pendingCorrection = (observed.pendingCorrection ?? 0) + delta
}

/** Ties the turn to its stored answer, applying any cost correction that came in first. */
export function attachAnswer(resolved: ResolvedModels, messageId: string) {
  const observed = resolved.observed
  if (!observed) return
  observed.messageId = messageId
  if (observed.pendingCorrection) addAnswerCost(messageId, observed.pendingCorrection)
  observed.pendingCorrection = undefined
}

function observeCall(observed: TurnObserved, u: TokenUsage, cost: number) {
  if (u.routedVia) observed.via = u.routedVia
  observed.cost = (observed.cost ?? 0) + cost
}

/** The picked model as named to the client when the turn starts; undefined for the defaults. */
export const pickedModelOf = ({ cloud, provider, observed }: ResolvedModels): AnswerModel | undefined =>
  cloud && provider ? {
    id: cloud.id, label: cloud.label, kind: provider.kind, provider: provider.label,
    ...(observed?.via && { via: observed.via }),
    ...(observed?.cost !== undefined && { cost: observed.cost, currency: provider.currency }),
  } : undefined

/** The model stored with the answer: the pick, or the default model that wrote it. Flash answers
 *  on the flash model; every other mode's answer is written by the chat model, unless the turn
 *  says otherwise (`answeredBy`). */
export const answerModelOf = (resolved: ResolvedModels, focusMode: string, answeredBy?: ModelTarget): AnswerModel =>
  pickedModelOf(resolved) ?? defaultAnswerModel(answeredBy ?? (focusMode === 'flash' ? resolved.models.flash : resolved.models.chat))

export const defaultAnswerModel = (t: ModelTarget): AnswerModel => ({ id: t.model, label: displayName(t), kind: 'default' })

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
  budgetChars: meterBudgetChars(m.contextTokens),
})

/** The models a user may pick, and the default models' meter budgets for when they pick none. */
export async function modelChoices(userId: string): Promise<ModelChoices> {
  const { flash, chat, thinking } = localTurnModels()
  const describe = (t: ModelTarget) => ({ model: displayName(t), budgetChars: meterBudgetChars(t.contextTokens) })
  return { models: await pickableModels(userId), defaults: { flash: describe(flash), chat: describe(chat), thinking: describe(thinking) } }
}
