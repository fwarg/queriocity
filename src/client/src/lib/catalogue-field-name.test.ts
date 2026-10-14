/** Save errors from the model catalogue name the field as the admin form does, not as a zod path. */

import { describe, test, expect } from 'bun:test'
import { catalogueFieldName } from './api.ts'

describe('catalogueFieldName', () => {
  test('names a model or provider field by position and label', () => {
    expect(catalogueFieldName(['models', 0, 'id'])).toBe('Model 1, Id: ')
    expect(catalogueFieldName(['providers', 1, 'baseURL'])).toBe('Provider 2, Base URL: ')
  })

  test('falls back to the raw name for a field it has no label for, and to nothing for no path', () => {
    expect(catalogueFieldName(['models', 2, 'somethingNew'])).toBe('Model 3, somethingNew: ')
    expect(catalogueFieldName([])).toBe('')
    expect(catalogueFieldName(undefined)).toBe('')
  })
})
