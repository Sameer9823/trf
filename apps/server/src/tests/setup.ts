/**
 * Test-only environment, loaded before any test file
 * (`tsx --test --import ./src/tests/setup.ts`) so config.ts can validate its variables.
 *
 * Point TEST_DATABASE_* at a disposable PostgreSQL instance to run the database
 * tests. Without it those tests report as skipped rather than passing quietly.
 * The remaining defaults are throwaway placeholders, never a real credential.
 */
process.env.DATABASE_HOST ??= 'localhost';
process.env.DATABASE_NAME ??= 'trf_test';
process.env.DATABASE_USER ??= 'trf_test';
process.env.DATABASE_PASSWORD ??= 'test-only';
process.env.JWT_SECRET ??= 'test-only-secret-value-that-is-long-enough-32';

// A test run owns the whole database it points at, so these override the defaults above.
if (process.env.TEST_DATABASE_HOST) process.env.DATABASE_HOST = process.env.TEST_DATABASE_HOST;
if (process.env.TEST_DATABASE_PORT) process.env.DATABASE_PORT = process.env.TEST_DATABASE_PORT;
if (process.env.TEST_DATABASE_NAME) process.env.DATABASE_NAME = process.env.TEST_DATABASE_NAME;
if (process.env.TEST_DATABASE_USER) process.env.DATABASE_USER = process.env.TEST_DATABASE_USER;
if (process.env.TEST_DATABASE_PASSWORD) process.env.DATABASE_PASSWORD = process.env.TEST_DATABASE_PASSWORD;