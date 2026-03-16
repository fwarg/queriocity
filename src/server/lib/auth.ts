import { SignJWT, jwtVerify } from 'jose'

const secret = new TextEncoder().encode(
  process.env.JWT_SECRET ?? 'change-me-in-production-32chars!!'
)
const ALG = 'HS256'

export async function signToken(userId: string): Promise<string> {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secret)
}

export async function verifyToken(token: string): Promise<string> {
  const { payload } = await jwtVerify(token, secret)
  if (!payload.sub) throw new Error('Missing sub claim')
  return payload.sub
}
