import { useState, useCallback } from 'react'
import { fetchModelChoices } from '../lib/api.ts'
import { useConfirm } from '../components/confirm.tsx'
import { useT } from '../lib/i18n.tsx'
import type { ModelChoices, PickableModel } from '@shared/llm-catalogue.ts'

type FocusMode = 'flash' | 'balanced' | 'thorough' | 'image'

/** Whether a model can answer in this mode and space: image never, thinking models in thorough only. */
export const modelFits = (m: PickableModel, focusMode: FocusMode, locked: boolean) =>
  focusMode !== 'image' && (m.role !== 'thinking' || focusMode === 'thorough') && (!locked || m.allowedWhenLocked)

/** The context the next message's model has, as the meter counts it: the pick's, or the default
 *  model that mode runs on (the thinking model for thorough research when the user has it on). */
function nextBudget(choices: ModelChoices | null, picked: PickableModel | undefined, focusMode: FocusMode, useThinking: boolean) {
  if (picked) return picked.budgetChars
  if (!choices) return undefined
  if (focusMode === 'flash') return choices.defaults.flash
  return focusMode === 'thorough' && useThinking ? choices.defaults.thinking : choices.defaults.chat
}

interface Options {
  focusMode: FocusMode
  locked: boolean
  enabled: boolean
  /** The user's thorough-mode thinking setting, which picks the default model thorough researches on. */
  useThinking: boolean
  /** The user has already confirmed that cloud models are not private. */
  cloudAcknowledged: boolean
  /** Stores that confirmation with the user's settings. */
  onAcknowledge: () => Promise<void>
}

/** The per-message model pick: what the user may choose from, the choice for the next message,
 *  and how much context that message's model has. */
export function useModelPicker({ focusMode, locked, enabled, useThinking, cloudAcknowledged, onAcknowledge }: Options) {
  const t = useT()
  const confirm = useConfirm()
  const [choices, setChoices] = useState<ModelChoices | null>(null)
  const [picked, setPicked] = useState('')

  /** Budgets shrink with every answer, so the caller refetches the list after each one. */
  const refresh = useCallback(() => {
    if (!enabled) { setChoices(null); return }
    fetchModelChoices().then(setChoices).catch(() => setChoices(null))
  }, [enabled])
  const reset = useCallback(() => setPicked(''), [])

  /** The first cloud pick asks once whether the user accepts that the prompt leaves the server. */
  const choose = async (id: string) => {
    const model = choices?.models.find(m => m.id === id)
    if (model?.kind === 'cloud' && !cloudAcknowledged) {
      if (!await confirm({ message: t('model.ackMessage'), confirmLabel: t('model.ackConfirm') })) return
      await onAcknowledge()
    }
    setPicked(id)
  }

  const available = (choices?.models ?? []).filter(m => modelFits(m, focusMode, locked))
  // A pick that no longer fits (mode switched, budget spent) is dropped rather than sent and refused.
  const pickedModel = available.find(m => m.id === picked)
  return {
    available, picked: pickedModel ? picked : '', choose, reset, refresh,
    meterBudget: nextBudget(choices, pickedModel, focusMode, useThinking),
    meterModel: pickedModel?.label,
  }
}
