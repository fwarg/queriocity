/** Invite consumption during registration.
 *
 *  The bug this guards: the invite was marked used before the duplicate-email check, so someone who
 *  already had an account and opened their invite link a second time burned it — every later
 *  attempt failed with "Invite already used" and only an admin could issue another. An invite must
 *  be spent only when it actually buys a registration. */

import '../lib/test-support/test-env.ts'

import { describe, test, expect, beforeAll, beforeEach } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db, users, invites, authCredentials } from '../lib/db.ts'
import { authRouter } from './auth.ts'
import { hashPassword } from '../lib/auth.ts'
import { Hono } from 'hono'

const app = new Hono().route('/auth', authRouter)
const PASSWORD = 'Sufficient1!pass'
const TAKEN = 'taken@example.invalid'

// Registration behaves differently for the very first user (who needs no invite), so the table
// must not be empty for any of this to be under test.
beforeAll(async () => {
  const now = new Date()
  await db.insert(users).values({
    id: 'existing-user', email: TAKEN, name: null, role: 'user',
    settings: '{}', tokenVersion: 0, createdAt: now, updatedAt: now,
  })
  await db.insert(authCredentials).values({
    email: TAKEN, userId: 'existing-user', passwordHash: await hashPassword(PASSWORD),
  })
})

let token = ''
beforeEach(async () => {
  token = randomUUID()
  await db.insert(invites).values({
    id: token, email: null, createdBy: 'existing-user',
    expiresAt: new Date(Date.now() + 24 * 3600 * 1000), createdAt: new Date(),
  })
})

const register = (email: string, inviteToken?: string) =>
  app.request('/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, inviteToken }),
  })

const usedAtOf = async () =>
  (await db.select({ usedAt: invites.usedAt }).from(invites).where(eq(invites.id, token)).get())?.usedAt ?? null

describe('POST /auth/register', () => {
  test('leaves the invite unspent when the email is already registered', async () => {
    const res = await register(TAKEN, token)

    expect(res.status).toBe(409)
    expect(await usedAtOf()).toBeNull()
  })

  test('and the same invite still works afterwards', async () => {
    expect((await register(TAKEN, token)).status).toBe(409)

    const res = await register(`fresh-${randomUUID()}@example.invalid`, token)

    expect(res.status).toBe(201)
    expect(await usedAtOf()).not.toBeNull()
  })

  test('spends the invite on a registration that succeeds', async () => {
    expect((await register(`new-${randomUUID()}@example.invalid`, token)).status).toBe(201)
    expect(await usedAtOf()).not.toBeNull()
  })

  test('refuses to spend it twice', async () => {
    expect((await register(`a-${randomUUID()}@example.invalid`, token)).status).toBe(201)

    const res = await register(`b-${randomUUID()}@example.invalid`, token)

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: 'Invite already used' })
  })
})
