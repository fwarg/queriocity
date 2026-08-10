import { describe, expect, it } from 'bun:test'
import {
  APPROVAL_TIMEOUT_MS, approvalTimeLeft, awaitApproval, finishRun, settleApproval, startRun,
} from './stream-buffer.ts'

/** The invariant worth protecting: an egress approval only ever resolves true when the user says
 *  so. Every other way out — timeout, the run ending, a stop — must refuse, because an unresolved
 *  or accidentally-true approval sends the request the guard flagged. */
describe('egress approvals', () => {
  it('resolves true only on an explicit allow', async () => {
    const run = startRun('approve-yes', 'u1')
    const pending = awaitApproval(run, 'a1')
    expect(settleApproval(run, 'a1', true)).toBe(true)
    expect(await pending).toBe(true)
  })

  it('resolves false on decline', async () => {
    const run = startRun('approve-no', 'u1')
    const pending = awaitApproval(run, 'a1')
    settleApproval(run, 'a1', false)
    expect(await pending).toBe(false)
  })

  it('refuses everything still parked when the run ends', async () => {
    const run = startRun('approve-end', 'u1')
    const first = awaitApproval(run, 'a1')
    const second = awaitApproval(run, 'a2')
    finishRun(run)
    expect(await first).toBe(false)
    expect(await second).toBe(false)
    expect(run.approvals.size).toBe(0)
  })

  it('reports nothing settled for an unknown id, so a stale prompt cannot allow anything', () => {
    const run = startRun('approve-unknown', 'u1')
    expect(settleApproval(run, 'never-issued', true)).toBe(false)
  })

  it('ignores a second decision for an id already settled', async () => {
    const run = startRun('approve-twice', 'u1')
    const pending = awaitApproval(run, 'a1')
    settleApproval(run, 'a1', false)
    expect(settleApproval(run, 'a1', true)).toBe(false)
    expect(await pending).toBe(false)
  })

  it('refuses on its own when the user never answers', async () => {
    const run = startRun('approve-timeout', 'u1')
    expect(await awaitApproval(run, 'a1', 30)).toBe(false)
    expect(run.approvals.size).toBe(0)
  })

  it('counts down from the configured timeout and forgets the id once settled', () => {
    const run = startRun('approve-clock', 'u1')
    void awaitApproval(run, 'a1')
    const left = approvalTimeLeft(run, 'a1')
    expect(left).not.toBeNull()
    expect(left!).toBeLessThanOrEqual(APPROVAL_TIMEOUT_MS)
    expect(left!).toBeGreaterThan(0)
    settleApproval(run, 'a1', false)
    expect(approvalTimeLeft(run, 'a1')).toBeNull()
  })
})
