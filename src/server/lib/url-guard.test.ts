import { describe, test, expect } from 'bun:test'
import { assertFetchableUrl, isBlockedAddress, BlockedUrlError } from './url-guard.ts'

const blocked = async (url: string) => {
  try { await assertFetchableUrl(url); return null }
  catch (e) { return e instanceof BlockedUrlError ? e.message : `unexpected: ${e}` }
}

describe('isBlockedAddress', () => {
  test('blocks loopback, private, CGNAT and link-local v4', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.254', '192.168.1.1',
                      '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1']) {
      expect(isBlockedAddress(ip)).toBe(true)
    }
  })

  test('allows ordinary public v4', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '192.169.0.1', '100.63.255.255']) {
      expect(isBlockedAddress(ip)).toBe(false)
    }
  })

  test('blocks loopback, ULA, link-local and v4-mapped v6', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fd00::1', 'fc00::1', 'ff02::1', '::ffff:127.0.0.1']) {
      expect(isBlockedAddress(ip)).toBe(true)
    }
  })

  test('allows public v6 and rejects unparseable input', () => {
    expect(isBlockedAddress('2606:4700:4700::1111')).toBe(false)
    expect(isBlockedAddress('not-an-ip')).toBe(true)
  })
})

describe('assertFetchableUrl', () => {
  test('rejects non-http schemes', async () => {
    expect(await blocked('file:///etc/passwd')).toContain('not allowed')
    expect(await blocked('gopher://example.com/')).toContain('not allowed')
    expect(await blocked('data:text/html,hi')).toContain('not allowed')
  })

  test('rejects malformed URLs', async () => {
    expect(await blocked('not a url')).toBe('malformed URL')
  })

  test('rejects literal internal addresses without needing DNS', async () => {
    expect(await blocked('http://127.0.0.1:11434/api/tags')).toContain('loopback')
    expect(await blocked('http://169.254.169.254/latest/meta-data/')).toContain('loopback')
    expect(await blocked('http://[::1]:3000/')).toContain('loopback')
  })

  test('rejects internal hostnames', async () => {
    expect(await blocked('http://localhost:3000/')).toContain('internal')
    expect(await blocked('http://searxng.internal/search')).toContain('internal')
  })

  test('allows an ordinary public URL', async () => {
    expect(await blocked('https://example.com/page?a=1')).toBeNull()
  })
})
