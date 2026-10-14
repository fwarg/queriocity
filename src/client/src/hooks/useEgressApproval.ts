import { useState, type MutableRefObject } from 'react'
import { decideEgress } from '../lib/api.ts'
import type { EgressApproval } from './chat-run.ts'

/** The outbound request awaiting the user's decision. At most one is ever parked: the generation
 *  blocks on it, so a second cannot be raised until this one resolves. */
export function useEgressApproval(liveSessionRef: MutableRefObject<string | undefined>) {
  const [approval, setApproval] = useState<EgressApproval | null>(null)

  /** Answers a parked egress prompt. Clearing it locally regardless of the server's reply is
   *  deliberate: if nothing was parked the request had already been refused by the timeout, and
   *  leaving the dialog up would invite a second click that means nothing. */
  async function decideApproval(id: string, allow: boolean) {
    setApproval(a => (a && a.id === id ? null : a))
    if (liveSessionRef.current) await decideEgress(liveSessionRef.current, id, allow)
  }

  return { approval, setApproval, decideApproval }
}
