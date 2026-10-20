/** A user's settings: the schema the settings route validates against, and the type both sides use.
 *  The client imports the type only, so zod stays out of its bundle. */

import { z } from 'zod'
import { LANG_CODES } from './i18n/index.ts'
import { THEMES } from './theme.ts'

const VALID_TIMEZONES = new Set(Intl.supportedValuesOf('timeZone'))

export const userSettingsSchema = z.object({
  customPrompt: z.string().max(2000).optional(),
  showThinking: z.object({ balanced: z.boolean(), thorough: z.boolean() }).optional(),
  useThinking: z.boolean().optional(),
  useSpaceRag: z.boolean().optional(),
  useChatRag: z.boolean().optional(),
  fontSize: z.number().min(12).max(22).optional(),
  theme: z.enum(THEMES).optional(),
  timezone: z.string().refine(v => !v || VALID_TIMEZONES.has(v), 'Invalid timezone').optional(),
  querySuggestions: z.boolean().optional(),
  followUpSuggestions: z.boolean().optional(),
  /** Off by default: when disabled neither the block nor the save_user_fact tool is added, so
   *  prompt size and tool count are unchanged for anyone who has not opted in. */
  userMemory: z.boolean().optional(),
  /** Visible "AI-generated" caption burned into downloaded images. On by default — the AI Act's
   *  disclosure duty (Art 50(4)) falls on whoever deploys the app, and only a visible mark
   *  survives a platform stripping the file's metadata. Metadata marking is unconditional. */
  imageWatermark: z.boolean().optional(),
  /** UI language. Absent for everyone who signed up before the selector existed — the client
   *  falls back to the browser's language rather than assuming English. */
  language: z.enum(LANG_CODES).optional(),
  /** The user has confirmed they understand a cloud model is sent everything in the prompt. Their
   *  own consent, so it lives with their settings; cloud picks are refused until it is given. */
  cloudAcknowledged: z.boolean().optional(),
})

export type UserSettings = z.infer<typeof userSettingsSchema>

/** Stored settings, keeping each field that is still valid and dropping the rest. Field by field
 *  rather than all-or-nothing: one value written by an older version must not cost the user every
 *  other setting. Keys the schema no longer knows are dropped too. */
export function parseUserSettings(raw: unknown): UserSettings {
  const stored = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const valid: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(userSettingsSchema.shape)) {
    const parsed = field.safeParse(stored[key])
    if (parsed.success && parsed.data !== undefined) valid[key] = parsed.data
  }
  return valid as UserSettings
}
