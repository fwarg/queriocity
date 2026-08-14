/** TemplateSelector looks its copy up by the ids in templates.ts, assembling keys at runtime — so
 *  the compiler cannot tell it a template is missing its catalog entries. This does.
 *
 *  It fails on the case that would otherwise ship: someone adds a sixth template and sees the raw
 *  key `template.foo.name` rendered where its name should be. */

import { describe, expect, test } from 'bun:test'
import { TEMPLATES } from './templates.ts'
import { en } from '@shared/i18n/en.ts'

const has = (key: string) => key in en

describe('built-in templates', () => {
  for (const template of TEMPLATES) {
    test(`${template.id} has its name and description`, () => {
      expect(has(`template.${template.id}.name`)).toBe(true)
      expect(has(`template.${template.id}.desc`)).toBe(true)
    })

    test(`${template.id} has copy for every field`, () => {
      for (const field of template.fields) {
        expect({ field: field.id, label: has(`template.${template.id}.${field.id}.label`) })
          .toEqual({ field: field.id, label: true })
        // Placeholder keys exist only where there is a placeholder — an empty one would be an
        // empty catalog string, which i18n.test.ts rejects on purpose.
        expect({ field: field.id, placeholder: has(`template.${template.id}.${field.id}.ph`) })
          .toEqual({ field: field.id, placeholder: !!field.placeholder })
      }
    })
  }

  test('the catalog carries no copy for a template that no longer exists', () => {
    const ids = new Set(TEMPLATES.map(t => t.id))
    const orphans = Object.keys(en)
      .filter(k => k.startsWith('template.'))
      .map(k => k.split('.')[1])
      // The selector's own chrome lives under `template.` too, one segment deep.
      .filter(id => !ids.has(id) && !(`template.${id}` in en))
    expect([...new Set(orphans)]).toEqual([])
  })
})
