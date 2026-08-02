import { SignJWT, jwtVerify } from 'jose'
import bcrypt from 'bcryptjs'

export const AUTH_COOKIE = 'auth-token'

if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET env var is required')
const secret = new TextEncoder().encode(process.env.JWT_SECRET)
const ALG = 'HS256'

export interface AuthUser {
  userId: string
  email: string
  role: 'user' | 'admin'
  /** Invalidation counter — bumped on delete, role change and password change so an existing
   *  cookie stops working immediately instead of at its 7-day expiry. */
  tokenVersion: number
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12)
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash)
}

export async function signToken(user: AuthUser): Promise<string> {
  return new SignJWT({ email: user.email, role: user.role, tv: user.tokenVersion })
    .setProtectedHeader({ alg: ALG })
    .setSubject(user.userId)
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secret)
}

export async function verifyToken(token: string): Promise<AuthUser> {
  const { payload } = await jwtVerify(token, secret)
  if (!payload.sub) throw new Error('Missing sub')
  return {
    userId: payload.sub,
    email: payload['email'] as string,
    role: payload['role'] as 'user' | 'admin',
    // Tokens issued before token versioning existed carry no `tv` claim; treating them as
    // version 0 (the column default) keeps everyone logged in across the upgrade.
    tokenVersion: typeof payload['tv'] === 'number' ? payload['tv'] : 0,
  }
}

export function validatePassword(password: string): string | null {
  if (password.length < 8) return 'Password must be at least 8 characters'
  if (!/[A-Z]/.test(password)) return 'Password must contain an uppercase letter'
  if (!/[a-z]/.test(password)) return 'Password must contain a lowercase letter'
  if (!/[0-9]/.test(password)) return 'Password must contain a digit'
  if (!/[^A-Za-z0-9]/.test(password)) return 'Password must contain a special character'
  return null
}

// `secure` is on unless explicitly disabled: set COOKIE_SECURE=false for local http
// development, where the browser would otherwise discard the cookie entirely.
export const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.COOKIE_SECURE !== 'false',
  sameSite: 'Lax' as const,
  path: '/',
  maxAge: 7 * 24 * 60 * 60,
}
