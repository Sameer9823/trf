import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createAuthLimiters } from '../app.js';

/**
 * The real app disables the auth limiters under NODE_ENV=test, so these tests
 * build the limiters on a tiny app with small numbers and prove the split:
 * credential endpoints are limited hard, select-member has its own higher
 * limit, and the session endpoints are not caught by the strict limit.
 */

function buildLimitedApp() {
  const app = express();
  const { strictAuthLimiter, pinLimiter, generalAuthLimiter } = createAuthLimiters({
    strictMax: 2, pinMax: 4, generalMax: 100, windowMs: 60_000,
  });
  app.use('/api/auth', strictAuthLimiter);
  app.use('/api/auth', pinLimiter);
  app.use('/api/auth', generalAuthLimiter);
  app.use('/api/auth', (_req, res) => { res.json({ ok: true }); });
  return app;
}

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const server = buildLimitedApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const hit = (base: string, path: string) => fetch(`${base}/api/auth/${path}`, { method: 'POST' });

/** A fresh app per path, because the strict limiter counts every strict path
 *  against one per-IP bucket. */
async function expectLimited(path: string, max: number): Promise<void> {
  await withServer(async (base) => {
    for (let i = 0; i < max; i++) {
      const res = await hit(base, path);
      assert.notEqual(res.status, 429, `${path} request ${i + 1} of ${max} should pass`);
    }
    const res = await hit(base, path);
    assert.equal(res.status, 429, `${path} should be limited after ${max} requests`);
  });
}

test('login, forgot-password and reset-password are limited hard', async () => {
  for (const path of ['login', 'forgot-password', 'reset-password']) {
    await expectLimited(path, 2);
  }
});

test('select-member has its own higher limit than the credential endpoints', async () => {
  // pinMax (4) is higher than strictMax (2): 4 pass, the 5th is limited.
  await expectLimited('select-member', 4);
});

test('refresh and me are not caught by the strict limit', async () => {
  await withServer(async (base) => {
    for (let i = 0; i < 6; i++) {
      assert.notEqual((await hit(base, 'refresh')).status, 429, 'refresh must not hit the strict limit');
      assert.notEqual((await hit(base, 'me')).status, 429, 'me must not hit the strict limit');
    }
  });
});