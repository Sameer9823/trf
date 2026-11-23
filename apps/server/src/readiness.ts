/**
 * Whether the database is connected, migrated and schema-verified. Kept in its
 * own module so the health route can read it without importing index.ts, which
 * starts a listening server at load time.
 */
let dbReady = false;

export function markDbReady(): void {
  dbReady = true;
}

export function isDbReady(): boolean {
  return dbReady;
}