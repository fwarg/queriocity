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
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12)
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash)
}

export async function signToken(user: AuthUser): Promise<string> {
  return new SignJWT({ email: user.email, role: user.role })
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

export const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'Lax' as const,
  path: '/',
  maxAge: 7 * 24 * 60 * 60,
}
