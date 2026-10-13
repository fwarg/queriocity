import { z } from 'zod'
import { getAppSetting, setAppSetting } from './db.ts'
import type { ModelTarget } from './llm.ts'
import { EMPTY_CATALOGUE, type CloudModel, type LlmCatalogue } from '../../shared/llm-catalogue.ts'

export const CATALOGUE_SETTING = 'llm_catalogue'

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'lowercase letters, digits and dashes')
const price = z.number().min(0).max(10_000)

/** HTTPS only, so a key is never sent in clear; plain HTTP is allowed to this machine for a local proxy. */
const baseURL = z.string().url().refine(
  u => /^https:\/\//.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(u),
  'must be https (http only for localhost)',
)

/** Restricted to *_API_KEY so the catalogue cannot point a provider at the server's other secrets. */
const apiKeyEnv = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}_API_KEY$/, 'an env var name ending in _API_KEY')

/** Fields the request itself sets; an extra may add to a request but never redirect or reshape it. */
const RESERVED_BODY_KEYS = new Set(['model', 'messages', 'stream', 'stream_options', 'tools', 'tool_choice', 'max_tokens', 'max_completion_tokens', 'response_format'])

const extraBody = z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), z.union([z.string().max(200), z.number(), z.boolean()]))
  .refine(b => Object.keys(b).length <= 10, 'at most 10 fields')
  .refine(b => Object.keys(b).every(k => !RESERVED_BODY_KEYS.has(k)), 'must not set model, messages, tools or output limits')

const providerSchema = z.object({
  id,
  label: z.string().min(1).max(60),
  baseURL,
  apiKeyEnv,
  currency: z.string().regex(/^[A-Z]{3}$/, 'a three-letter currency code'),
  monthlyCap: z.number().min(0).max(1_000_000),
  extraBody: extraBody.optional(),
  enabled: z.boolean(),
})

const modelSchema = z.object({
  id,
  providerId: id,
  model: z.string().min(1).max(200),
  label: z.string().min(1).max(80),
  role: z.enum(['chat', 'thinking', 'both']),
  contextTokens: z.number().int().min(1024).max(4_000_000),
  maxOutputTokens: z.number().int().min(256).max(500_000),
  priceIn: price,
  priceOut: price,
  enabled: z.boolean(),
})

const duplicates = (ids: string[]) => ids.filter((x, i) => ids.indexOf(x) !== i)

export const catalogueSchema = z.object({
  providers: z.array(providerSchema).max(20),
  models: z.array(modelSchema).max(200),
}).superRefine((c, ctx) => {
  for (const dup of duplicates(c.providers.map(p => p.id))) ctx.addIssue({ code: 'custom', message: `duplicate provider id "${dup}"` })
  for (const dup of duplicates(c.models.map(m => m.id))) ctx.addIssue({ code: 'custom', message: `duplicate model id "${dup}"` })
  const known = new Set(c.providers.map(p => p.id))
  for (const m of c.models) {
    if (!known.has(m.providerId)) ctx.addIssue({ code: 'custom', message: `model "${m.id}" names unknown provider "${m.providerId}"` })
  }
})

/** The saved catalogue; empty when nothing is saved or the stored JSON no longer validates. */
export async function loadCatalogue(): Promise<LlmCatalogue> {
  const raw = await getAppSetting(CATALOGUE_SETTING, '')
  if (!raw) return EMPTY_CATALOGUE
  let json: unknown
  try { json = JSON.parse(raw) } catch { json = null }
  const parsed = catalogueSchema.safeParse(json)
  if (parsed.success) return parsed.data
  console.error(`  [llm-catalogue] stored catalogue is invalid, ignoring it: ${parsed.error.issues.map(i => i.message).join('; ')}`)
  return EMPTY_CATALOGUE
}

export const saveCatalogue = (catalogue: LlmCatalogue) => setAppSetting(CATALOGUE_SETTING, JSON.stringify(catalogue))

/** Whether each env var the catalogue names is set, so the admin sees a missing key before a user does. */
export const keyStatus = (catalogue: LlmCatalogue): Record<string, boolean> =>
  Object.fromEntries(catalogue.providers.map(p => [p.apiKeyEnv, !!process.env[p.apiKeyEnv]?.trim()]))

/** A catalogue model as a target the turn can run on; null when unknown or its key is unset. */
export function cloudTarget(catalogue: LlmCatalogue, modelId: string): (ModelTarget & { entry: CloudModel }) | null {
  const entry = catalogue.models.find(m => m.id === modelId)
  const provider = entry && catalogue.providers.find(p => p.id === entry.providerId)
  const apiKey = provider && process.env[provider.apiKeyEnv]?.trim()
  if (!entry || !provider || !apiKey) return null
  return {
    role: entry.role === 'thinking' ? 'thinking' : 'chat',
    provider: 'openai',
    baseURL: provider.baseURL,
    apiKey,
    extraBody: provider.extraBody,
    maxOutputTokens: entry.maxOutputTokens,
    model: entry.model,
    contextTokens: entry.contextTokens,
    configured: true,
    entry,
  }
}
