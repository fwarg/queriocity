/** Stable identifiers for the API errors the UI shows to a user.
 *
 *  The server keeps returning its English `error` string — this rides alongside it, so the client
 *  can translate without the server knowing which language anyone reads. A response with no code
 *  still renders: the client falls back to the English string, which is why codes can be added
 *  route by route rather than all at once.
 *
 *  Every code needs an `error.<code>` entry in the catalogs; i18n.test.ts asserts that, so adding
 *  one here without translating it fails the build rather than reaching a user as a raw key. */
export type ErrorCode =
  // Sign-in and registration
  | 'too_many_attempts'
  | 'invalid_credentials'
  | 'email_registered'
  | 'invite_required'
  | 'invite_invalid'
  | 'invite_used'
  | 'invite_expired'
  | 'invite_email_mismatch'
  // Password change
  | 'no_credentials'
  | 'wrong_password'

/** The error body every route returns. `code` is optional while routes are still being converted. */
export interface ApiErrorBody {
  error: string
  code?: ErrorCode
}
