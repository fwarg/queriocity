import { describe, test, expect } from 'bun:test'
import { escapeCurrencyDollars as esc, prepareMath } from './math-markdown.ts'

describe('escapeCurrencyDollars', () => {
  test('escapes currency amounts', () => {
    expect(esc('Costs $5 and $10.')).toBe('Costs \\$5 and \\$10.')
    expect(esc('From $5-$10 a month')).toBe('From \\$5-\\$10 a month')
  })

  test('leaves inline math alone, also when it starts with a digit', () => {
    for (const s of ['AUC ($0.981$, $0.993$)', 'chance ($0.50$)', 'ranks $1/1, 1/3 \\rightarrow (1, 0.33)$.', 'with $x^2$ here']) {
      expect(esc(s)).toBe(s)
    }
  })

  test('leaves display math, code and escaped dollars alone', () => {
    for (const s of ['$$1 + 1$$ costs $', 'run `echo $1 $2`', '```\nprice=$5\n```', 'already \\$5']) {
      expect(esc(s)).toBe(s)
    }
  })
})

describe('prepareMath', () => {
  test('turns LaTeX delimiters into dollars', () => {
    expect(prepareMath('AUC \\(0.981\\) vs \\( x^2 \\).')).toBe('AUC $0.981$ vs $x^2$.')
    expect(prepareMath('Sum:\\[\n\\sum_i x_i = $5\n\\]done')).toBe('Sum:\n$$\n\\sum_i x_i = $5\n$$\ndone')
  })

  test('leaves code alone', () => {
    for (const s of ['`\\(x\\)`', '```\n\\[x\\]\n```']) expect(prepareMath(s)).toBe(s)
  })
})
