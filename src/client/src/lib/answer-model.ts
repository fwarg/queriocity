import type { AnswerModel } from '@shared/llm-catalogue.ts'
import type { TFunction } from './i18n.tsx'
import { formatCost } from './money.ts'

/** The sentence naming the model that wrote an answer, where a cloud one sent it, and what it cost. */
export function describeAnswerModel(model: AnswerModel, t: TFunction): string {
  const { label, provider = '', via } = model
  const named = model.kind === 'default' ? t('answer.byDefaultModel', { label })
    : model.kind !== 'cloud' ? t('answer.byModel', { label })
      : via ? t('answer.byCloudModelVia', { label, provider, via })
        : t('answer.byCloudModel', { label, provider })
  return model.cost !== undefined ? `${named} ${t('answer.cost', { amount: formatCost(model.cost), currency: model.currency ?? '' })}` : named
}

/** The short badge on an answer: the model, marked default or naming the cloud provider it went to. */
export function answerModelBadge(model: AnswerModel, t: TFunction): string {
  if (model.kind === 'default') return t('message.defaultBadge', { label: model.label })
  if (model.kind !== 'cloud') return model.label
  const provider = model.provider ?? ''
  return model.via ? t('message.cloudBadgeVia', { provider, via: model.via }) : t('message.cloudBadge', { provider })
}
