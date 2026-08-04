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

/*  `lib/db.ts` opens `DB_PATH` and runs initSchema() at import time, so importing anything that
 *  reaches it makes the test suite read, migrate and write the developer's real database — Bun
 *  auto-loads `.env`, which sets DB_PATH, so this is the *normal* case rather than an edge one.
 *
 *  Unconditional assignment, unlike JWT_SECRET above: honouring an ambient JWT_SECRET is
 *  harmless, but honouring an ambient DB_PATH lets tests write to real data. An in-memory
 *  database is created fresh per process and discarded after; vec0 works there exactly as on
 *  disk. Same import-order rule as above. */
process.env.DB_PATH = ':memory:'
