import { useState, useCallback } from 'react'
import { fetchPickableModels } from '../lib/api.ts'
import { useConfirm } from '../components/confirm.tsx'
import { useT } from '../lib/i18n.tsx'
import type { PickableModel } from '@shared/llm-catalogue.ts'

type FocusMode = 'flash' | 'balanced' | 'thorough' | 'image'

/** Whether a model can answer in this mode and space: image never, thinking models in thorough only. */
export const modelFits = (m: PickableModel, focusMode: FocusMode, locked: boolean) =>
  focusMode !== 'image' && (m.role !== 'thinking' || focusMode === 'thorough') && (!locked || m.allowedWhenLocked)

interface Options {
  focusMode: FocusMode
  locked: boolean
  enabled: boolean
  /** The user has already confirmed that cloud models are not private. */
  cloudAcknowledged: boolean
  /** Stores that confirmation with the user's settings. */
  onAcknowledge: () => Promise<void>
}

/** The per-message model pick: what the user may choose from, and the choice for the next message. */
export function useModelPicker({ focusMode, locked, enabled, cloudAcknowledged, onAcknowledge }: Options) {
  const t = useT()
  const confirm = useConfirm()
  const [models, setModels] = useState<PickableModel[]>([])
  const [picked, setPicked] = useState('')

  /** Budgets shrink with every answer, so the caller refetches the list after each one. */
  const refresh = useCallback(() => {
    if (!enabled) { setModels([]); return }
    fetchPickableModels().then(setModels).catch(() => setModels([]))
  }, [enabled])
  const reset = useCallback(() => setPicked(''), [])

  /** The first cloud pick asks once whether the user accepts that the prompt leaves the server. */
  const choose = async (id: string) => {
    const model = models.find(m => m.id === id)
    if (model?.kind === 'cloud' && !cloudAcknowledged) {
      if (!await confirm({ message: t('model.ackMessage'), confirmLabel: t('model.ackConfirm') })) return
      await onAcknowledge()
    }
    setPicked(id)
  }

  const available = models.filter(m => modelFits(m, focusMode, locked))
  // A pick that no longer fits (mode switched, budget spent) is dropped rather than sent and refused.
  const effective = available.some(m => m.id === picked) ? picked : ''
  return { available, picked: effective, choose, reset, refresh }
}
