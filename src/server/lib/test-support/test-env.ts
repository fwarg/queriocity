/** Environment that server modules demand at *import* time, for tests that pull in route or
 *  middleware code.
 *
 *  `lib/auth.ts` throws on a missing `JWT_SECRET` as soon as it is loaded — deliberately, so a
 *  misconfigured deployment fails at startup rather than at the first login. Locally that is
 *  satisfied by the `.env` Bun auto-loads, so tests pass; CI has no `.env`, so importing
 *  anything that reaches `lib/auth.ts` threw and took the whole test file with it.
 *
 *  Import this FIRST in such tests: ES modules are evaluated in import order, so it must
 *  precede the module that reads the value. `||=` rather than `??=` so an empty-string value
 *  is also replaced — that is what the check being compensated for actually tests for, and
 *  `??=` would leave `JWT_SECRET=` in place and fail anyway. A real local value still wins. */

process.env.JWT_SECRET ||= 'test-only-secret-not-used-outside-bun-test'
