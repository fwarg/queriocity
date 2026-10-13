import { useState, useCallback } from 'react'
import { fetchPickableModels } from '../lib/api.ts'
import type { PickableModel } from '@shared/llm-catalogue.ts'

type FocusMode = 'flash' | 'balanced' | 'thorough' | 'image'

/** Whether a model can answer in this mode and space: image never, thinking models in thorough only. */
export const modelFits = (m: PickableModel, focusMode: FocusMode, locked: boolean) =>
  focusMode !== 'image' && (m.role !== 'thinking' || focusMode === 'thorough') && (!locked || m.allowedWhenLocked)

/** The per-message model pick: what the user may choose from, and the choice for the next message. */
export function useModelPicker(focusMode: FocusMode, locked: boolean, enabled: boolean) {
  const [models, setModels] = useState<PickableModel[]>([])
  const [picked, setPicked] = useState('')

  /** Budgets shrink with every answer, so the caller refetches the list after each one. */
  const refresh = useCallback(() => {
    if (!enabled) { setModels([]); return }
    fetchPickableModels().then(setModels).catch(() => setModels([]))
  }, [enabled])

  const reset = useCallback(() => setPicked(''), [])

  const available = models.filter(m => modelFits(m, focusMode, locked))
  // A pick that no longer fits (mode switched, budget spent) is dropped rather than sent and refused.
  const effective = available.some(m => m.id === picked) ? picked : ''
  return { available, picked: effective, setPicked, reset, refresh }
}
