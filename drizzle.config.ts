import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/server/lib/db.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.DB_PATH ?? 'queriocity.db',
  },
})
