/** The badge and sentence naming the model behind an answer, for each kind of model. */

import { describe, test, expect } from 'bun:test'
import { translate } from '@shared/i18n/index.ts'
import type { TFunction } from './i18n.tsx'
import { describeAnswerModel, answerModelBadge, answerFooterNote } from './answer-model.ts'

const t: TFunction = (key, vars) => translate('en', key, vars)

describe('answer model labels', () => {
  test('mark the default model as such', () => {
    const model = { id: 'gemma4-26b', label: 'Gemma4-26B', kind: 'default' as const }
    expect(answerModelBadge(model, t)).toBe('Default (Gemma4-26B)')
    expect(describeAnswerModel(model, t)).toBe('Model: default (Gemma4-26B).')
  })

  test('name a local pick plainly, and a cloud one by where it went and what it cost', () => {
    expect(answerModelBadge({ id: 'big', label: 'Big local', kind: 'local', provider: 'Box' }, t)).toBe('Big local')
    const cloud = { id: 'g', label: 'GLM', kind: 'cloud' as const, provider: 'Cortecs', via: 'entrim', cost: 0.000025, currency: 'EUR' }
    expect(answerModelBadge(cloud, t)).toBe('Cloud · Cortecs via entrim')
    expect(describeAnswerModel(cloud, t)).toBe('Model: GLM (cloud — this message was sent to Cortecs, which passed it to entrim). Cost: 0.000025 EUR.')
    // The footer keeps just the model; the rest is on the badge and in its tooltip.
    expect(answerFooterNote(cloud, t)).toBe('Model: GLM.')
  })

  test('put the tokens in the tooltip, with reasoning and estimates when there are any', () => {
    const local = { id: 'g', label: 'Gemma', kind: 'default' as const, tokens: { input: 48213, output: 9120, reasoning: 2300, calls: 6 } }
    expect(describeAnswerModel(local, t)).toBe('Model: default (Gemma). Tokens: 48.2k in, 9.1k out (2.3k reasoning) · 6 calls.')
    const cut = { ...local, tokens: { input: 900, output: 40, calls: 1, estimated: true } }
    expect(describeAnswerModel(cut, t)).toBe('Model: default (Gemma). Tokens: 900 in, 40 out · 1 call. Partly estimated: a call was cut off.')
  })
})
