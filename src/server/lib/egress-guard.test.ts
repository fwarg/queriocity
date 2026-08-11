import { describe, expect, it } from 'bun:test'
import {
  createEgressContext, entropy, inspectQuery, inspectUrl, noteSeenUrl, noteTaint, noteUserText,
} from './egress-guard.ts'

const ctxWith = (opts: { seen?: string[]; taint?: string; user?: string } = {}) => {
  const ctx = createEgressContext()
  for (const u of opts.seen ?? []) noteSeenUrl(ctx, u)
  if (opts.taint) noteTaint(ctx, opts.taint)
  if (opts.user) noteUserText(ctx, opts.user)
  return ctx
}

// A realistic secret, so the taint tests exercise the path an actual leak would take.
const DOCUMENT = 'Internal migration plan. Contact hildegard.brennan@northwind-logistics.example. ' +
  'Warehouse consolidation targets Trondheim and Kaunas before the Q3 handover.'

describe('entropy', () => {
  // Ranks base64 above prose, but only just: the gap is far smaller than the textbook figures
  // suggest, which is why scoring leans on the structural checks instead. Asserted as a
  // relationship rather than a threshold so the test records the real margin.
  it('ranks base64 above prose, by a thin margin', () => {
    const prose = entropy('the quick brown fox jumps over the lazy dog')
    const b64 = entropy('aGVsbG8gd29ybGQgdGhpcyBpcyBiYXNlNjQgcGF5bG9hZA')
    expect(b64).toBeGreaterThan(prose)
    expect(b64 - prose).toBeLessThan(1)
  })
})

describe('inspectUrl — must flag', () => {
  // Prompt rather than block: presigned S3 links, JWTs and media ids are all long opaque tokens,
  // so blocking outright on this signal alone would break legitimate fetches.
  it('a base64 payload in the query string', () => {
    const v = inspectUrl('https://collect.example/p?d=aGVsbG8gd29ybGQgdGhpcyBpcyBhIHNlY3JldCBwYXlsb2Fk', ctxWith())
    expect(v.action).toBe('prompt')
    expect(v.reasons.join(' ')).toContain('encoded-looking')
  })

  it('escalates that same payload to a block once the turn has seen other hosts', () => {
    const ctx = ctxWith({ seen: ['https://news.example/a'] })
    const v = inspectUrl('https://collect.example/p?d=aGVsbG8gd29ybGQgdGhpcyBpcyBhIHNlY3JldCBwYXlsb2Fk', ctx)
    expect(v.action).toBe('block')
  })

  it('a hex payload', () => {
    const v = inspectUrl('https://collect.example/p?d=4e6f72746877696e64204c6f67697374696373205133', ctxWith())
    expect(v.action).not.toBe('allow')
  })

  it('a hostname label used as the payload', () => {
    const v = inspectUrl('https://dGhpcy1pcy1hLXZlcnktbG9uZy1leGZpbC1sYWJlbA.attacker.example/x', ctxWith())
    expect(v.action).toBe('block')
  })

  it('a bare IP destination', () => {
    const v = inspectUrl('https://203.0.113.9/collect?d=plan', ctxWith())
    expect(v.score).toBeGreaterThan(0)
  })

  it('document terms the user never mentioned, even in a short clean URL', () => {
    const ctx = ctxWith({ taint: DOCUMENT, user: 'summarise the attached plan' })
    const v = inspectUrl('https://n.example/s?q=trondheim-kaunas', ctx)
    expect(v.action).toBe('block')
    expect(v.reasons.join(' ')).toContain('terms from documents')
  })

  it('a payload appended to a URL whose origin and path were seen', () => {
    const seen = 'https://news.example/2026/article'
    const ctx = ctxWith({ seen: [seen] })
    const v = inspectUrl(`${seen}?d=aGVsbG8gd29ybGQgdGhpcyBpcyBhIHNlY3JldCBwYXlsb2Fk`, ctx)
    expect(v.action).not.toBe('allow')
  })
})

describe('inspectUrl — must not flag', () => {
  it('a long real article URL that came from a search result', () => {
    const url = 'https://www.theguardian.com/world/2026/aug/09/eu-ai-act-transparency-rules-come-into-force'
    const v = inspectUrl(url, ctxWith({ seen: [url] }))
    expect(v.action).toBe('allow')
  })

  it('pagination of a page already fetched', () => {
    const seen = 'https://docs.example/guide/install'
    const v = inspectUrl(`${seen}?page=2`, ctxWith({ seen: [seen] }))
    expect(v.action).toBe('allow')
  })

  it('a document term the user typed themselves', () => {
    const ctx = ctxWith({ taint: DOCUMENT, user: 'what does the plan say about Trondheim?' })
    const v = inspectUrl('https://news.example/search?q=trondheim', ctx)
    expect(v.action).toBe('allow')
  })

  it('an unseen host when nothing has been seen yet (first fetch of a turn)', () => {
    const v = inspectUrl('https://example.com/about', ctxWith())
    expect(v.action).toBe('allow')
  })
})

describe('inspectQuery', () => {
  it('allows an ordinary multi-word query', () => {
    expect(inspectQuery('eu ai act article 50 transparency obligations', ctxWith()).action).toBe('allow')
  })

  it('flags an encoded blob posing as a query', () => {
    const v = inspectQuery('aGVsbG8gd29ybGQgdGhpcyBpcyBhIHNlY3JldCBwYXlsb2FkIGZyb20gYSBkb2N1bWVudA', ctxWith())
    expect(v.action).toBe('block')
  })

  it('flags a query carrying several unmentioned document terms', () => {
    const ctx = ctxWith({ taint: DOCUMENT, user: 'summarise this' })
    const v = inspectQuery('hildegard brennan northwind logistics kaunas', ctx)
    expect(v.action).toBe('block')
  })

  it('allows a long but linguistic query', () => {
    const q = 'what are the practical differences between the provider and deployer obligations ' +
      'under article 50 of the eu ai act for a self hosted assistant'
    expect(inspectQuery(q, ctxWith()).action).toBe('allow')
  })
})
