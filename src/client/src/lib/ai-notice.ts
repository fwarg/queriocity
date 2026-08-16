import type { TranslationKey } from '@shared/i18n/index.ts'

/** Disclosure that the user is interacting with an AI system — EU AI Act Art 50(1).
 *
 *  Art 50(1) exempts cases where AI involvement is "obvious to a reasonably well-informed"
 *  person, which this arguably is. The exemption is not relied on: the Commission's guidelines
 *  discourage it, and Art 50(5) wants the notice at the first interaction anyway.
 *
 *  Keys rather than strings since the UI became multilingual: Art 50(1) requires the information
 *  be given "in a clear and distinguishable manner", which a notice the reader cannot read is
 *  not. The rationale stays here; the wording lives in the catalogs. */
export const AI_SYSTEM_NOTICE: TranslationKey = 'notice.aiSystem'

/** For the chat view, where the full notice would compete with the input on a phone. */
export const AI_SYSTEM_NOTICE_SHORT: TranslationKey = 'notice.aiSystemShort'
