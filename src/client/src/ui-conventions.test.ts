/** Guards the three UI conventions that a normal review does not catch.
 *
 *  Each of these was a real inconsistency across the views, and each is the kind that comes back:
 *  the next component is written by copying a neighbour, and a neighbour that still has the old
 *  shape spreads it. Typecheck and lint say nothing about any of them.
 *
 *  Scanning source text is crude, and deliberately so — the alternative is rendering every view in
 *  a DOM to assert on styling, which is far more machinery for a weaker guarantee. */

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const CLIENT_SRC = import.meta.dir
const COMPONENTS = join(CLIENT_SRC, 'components')

/** Exempt from the *glyph* rule only: its prose says "3× the cap", a multiplication sign in body
 *  text rather than an affordance. The other rules below apply to it like anything else. */
const NOT_AN_AFFORDANCE = new Set(['AdminPanel.tsx'])

const componentFiles = () => readdirSync(COMPONENTS).filter(f => f.endsWith('.tsx'))

/** Every client `.tsx`, App.tsx included — it holds a third of the UI. */
const allFiles = (): Array<[string, string]> => [
  ...readdirSync(CLIENT_SRC).filter(f => f.endsWith('.tsx')).map(f => [CLIENT_SRC, f] as [string, string]),
  ...componentFiles().map(f => [COMPONENTS, f] as [string, string]),
]

/** Whole-line comments only, in both forms this codebase uses — a JSDoc block and a `{/* … *\/}`
 *  inside JSX. It explains itself at length, and that prose mentions the very glyphs and classes
 *  being banned; cutting at a bare `//` instead would also cut the middle of every URL. */
const isComment = (line: string) => /^\s*(\{?\/\/|\{?\/\*|\*)/.test(line)

function offendingLines(file: string, match: (line: string) => boolean, dir = COMPONENTS) {
  return readFileSync(join(dir, file), 'utf8')
    .split('\n')
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => !isComment(line) && match(line))
    .map(({ line, n }) => `${file}:${n}  ${line}`)
}

describe('UI conventions', () => {
  /** Two characters were in use for the same affordance, U+00D7 in most places and U+2715 in
   *  Modal, SettingsPanel and TemplateSelector — beside a lucide Trash2 whose stroke they do not
   *  match. Both go through the `X` component now. */
  test('no bare × or ✕ glyph: dismiss goes through the lucide X icon', () => {
    const found = componentFiles()
      .filter(f => !NOT_AN_AFFORDANCE.has(f))
      .flatMap(f => offendingLines(f, l => /[×✕]/.test(l)))
    expect(found).toEqual([])
  })

  /** The touch bug: `opacity-0` with no `md:` guard leaves a button invisible on a phone but still
   *  tappable, so it is pressed blind. Six buttons were in that state. RowAction owns the rule,
   *  and this keeps a hand-rolled one from reintroducing it. */
  test('hover-revealed actions are guarded by md:, so they stay visible on touch', () => {
    // `pointer-events-none` exempts a line: an inert hover overlay (the citation preview in
    // MessageList) cannot be pressed blind, because it cannot be pressed at all.
    const found = allFiles().flatMap(([dir, f]) =>
      offendingLines(f, l => /(^|[^:])\bopacity-0 group-hover:/.test(l) && !l.includes('pointer-events-none'), dir))
    expect(found).toEqual([])
  })

  /** `window.confirm` cannot be styled or translated past its message, labels both buttons for
   *  every action alike, and is suppressible by the browser after the first one. Four patterns were
   *  in use — plain confirm(), window.confirm(), an inline two-step, and one hand-built dialog.
   *  useConfirm() is the one that stayed. */
  test('destructive actions ask through useConfirm, not the browser dialog', () => {
    const found = allFiles().flatMap(([dir, f]) =>
      offendingLines(f, l => /(^|[^a-zA-Z._])confirm\(/.test(l) && !l.includes('await confirm('), dir))
      .filter(l => !l.startsWith('confirm.tsx'))
    expect(found).toEqual([])
  })

  /** Every list view runs the full width of the main canvas. Monitors was capped at max-w-2xl,
   *  using a third of a wide screen while its neighbours used all of it. */
  test('MonitorsView does not cap its own width', () => {
    const root = readFileSync(join(COMPONENTS, 'MonitorsView.tsx'), 'utf8')
      .split('\n')
      .find(l => l.includes('flex-1 overflow-y-auto'))
    expect(root).toBeDefined()
    expect(root).not.toContain('max-w-')
  })
})
