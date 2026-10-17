import { AsyncLocalStorage } from 'node:async_hooks'
import { sqlite } from '../db.ts'

/** Confidential resources and collections: only a locked turn may read them.
 *
 *  Two words for two things. *Confidential* labels content — a resource, or a collection, which makes
 *  every resource in it confidential — and can be removed at any time. *Locked* describes where
 *  content may be read: a locked space or chat has no web, no image generation and local models
 *  only, and stays locked. A turn is locked when its space or chat is, or when it reads something
 *  confidential by name (a picked collection, a pinned or attached resource); the chat route then
 *  locks the chat for good, since its history holds what it read. Retrieval in an unlocked turn
 *  leaves confidential resources out, and records which, so the answer can say so. */

/** SQL that is true for a confidential resource; `col` names the resource id column. A collection's
 *  `offline` flag marks it confidential. Aliases are prefixed so they cannot shadow the caller's. */
export const confidentialSql = (col: string) =>
  `(${col} IN (SELECT cnf_f.id FROM uploaded_files cnf_f WHERE cnf_f.confidential = 1)
    OR ${col} IN (SELECT cnf_sf.file_id FROM space_files cnf_sf JOIN spaces cnf_s ON cnf_s.id = cnf_sf.space_id
                  WHERE cnf_s.kind = 'collection' AND cnf_s.offline = 1))`

/** An `AND` clause leaving confidential resources out, or nothing when the turn may read them. */
export const withoutConfidential = (col: string, includeConfidential: boolean) =>
  includeConfidential ? '' : `AND NOT ${confidentialSql(col)}`

const marks = (ids: string[]) => ids.map(() => '?').join(',')

/** Names of the confidential collections and resources among these — what a turn reading them is
 *  locked by, and what the chat's banner names. */
export function readsConfidential({ collectionIds = [], fileIds = [] }: { collectionIds?: string[]; fileIds?: string[] }): string[] {
  const collections = collectionIds.length
    ? sqlite.prepare(`SELECT name FROM spaces WHERE id IN (${marks(collectionIds)}) AND kind = 'collection' AND offline = 1`).all(...collectionIds) as Array<{ name: string }>
    : []
  const files = fileIds.length
    ? sqlite.prepare(`SELECT f.filename AS name FROM uploaded_files f WHERE f.id IN (${marks(fileIds)}) AND ${confidentialSql('f.id')}`).all(...fileIds) as Array<{ name: string }>
    : []
  return [...collections, ...files].map(r => r.name)
}

/** A chat's `locked_by` column: the names of what locked it, stored as a JSON array. */
export function parseLockedBy(json: string | null | undefined): string[] {
  try {
    const names: unknown = JSON.parse(json ?? '[]')
    return Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string') : []
  } catch {
    return []
  }
}

// Which confidential resources a turn's searches left out. Per turn through async context rather
// than a parameter on every search: the searches sit several calls deep, tools included.
const leftOut = new AsyncLocalStorage<Set<string>>()

/** Runs `fn` collecting, into `into`, the confidential resources its searches leave out. */
export const trackLeftOut = <T>(into: Set<string>, fn: () => Promise<T>): Promise<T> => leftOut.run(into, fn)

/** Whether anything is collecting — searches skip the extra query when nothing would read it. */
export const trackingLeftOut = (): boolean => leftOut.getStore() !== undefined

/** Records confidential resources a search left out. */
export function noteLeftOut(fileIds: Iterable<string>): void {
  const store = leftOut.getStore()
  if (store) for (const id of fileIds) store.add(id)
}
