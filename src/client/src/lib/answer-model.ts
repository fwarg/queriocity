import type { AnswerModel, AnswerTokens } from '@shared/llm-catalogue.ts'
import type { TFunction } from './i18n.tsx'
import { formatCost } from './money.ts'

/** The footer's short note: just the model. Where a cloud answer went shows on the badge itself,
 *  and the details — provider, cost, tokens — in its tooltip. */
export function answerFooterNote(model: AnswerModel, t: TFunction): string {
  return model.kind === 'default' ? t('answer.byDefaultModel', { label: model.label }) : t('answer.byModel', { label: model.label })
}

/** The badge's tooltip: the model, where a cloud one sent it, what it cost, and the tokens it used. */
export function describeAnswerModel(model: AnswerModel, t: TFunction): string {
  const { label, provider = '', via } = model
  const named = model.kind === 'default' ? t('answer.byDefaultModel', { label })
    : model.kind !== 'cloud' ? t('answer.byModel', { label })
      : via ? t('answer.byCloudModelVia', { label, provider, via })
        : t('answer.byCloudModel', { label, provider })
  const cost = model.cost !== undefined ? t('answer.cost', { amount: formatCost(model.cost), currency: model.currency ?? '' }) : ''
  return [named, cost, tokensText(model.tokens, t)].filter(Boolean).join(' ')
}

/** "Tokens: 48.2k in, 9.1k out (2.3k reasoning) · 6 calls." — empty when nothing was counted. */
function tokensText(tokens: AnswerTokens | undefined, t: TFunction): string {
  if (!tokens) return ''
  const reasoning = tokens.reasoning ? ` ${t('answer.tokensReasoning', { reasoning: compact(tokens.reasoning) })}` : ''
  return t('answer.tokens', { input: compact(tokens.input), output: compact(tokens.output), reasoning, count: tokens.calls })
    + (tokens.estimated ? ` ${t('answer.tokensEstimated')}` : '')
}

const compact = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

/** The short badge on an answer: the model, marked default or naming the cloud provider it went to. */
export function answerModelBadge(model: AnswerModel, t: TFunction): string {
  if (model.kind === 'default') return t('message.defaultBadge', { label: model.label })
  if (model.kind !== 'cloud') return model.label
  const provider = model.provider ?? ''
  return model.via ? t('message.cloudBadgeVia', { provider, via: model.via }) : t('message.cloudBadge', { provider })
}
