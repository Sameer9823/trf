import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { signAccessToken, verifyAccessToken } from '../lib/tokens';

test('a signed access token verifies with its payload intact', () => {
  const { token, expiresAt } = signAccessToken({ sub: '7', role: 'Analyst', employeeCode: 'EMP-007' }, 'jti-1');
  const payload = verifyAccessToken(token);
  assert.equal(payload.sub, '7');
  assert.equal(payload.role, 'Analyst');
  assert.equal(payload.employeeCode, 'EMP-007');
  assert.ok(new Date(expiresAt).getTime() > Date.now(), 'token must not be issued already expired');
});

test('the access token expires shortly, not in days', () => {
  const { expiresAt } = signAccessToken({ sub: '1', role: 'Viewer', employeeCode: 'E1' }, 'jti-2');
  const minutes = (new Date(expiresAt).getTime() - Date.now()) / 60000;
  assert.ok(minutes > 0 && minutes <= 60, `access token lifetime ${minutes} minutes is too long`);
});

test('a token signed with another secret is rejected', () => {
  const foreign = jwt.sign({ sub: '1', role: 'Admin', type: 'access' }, 'a-different-secret-of-sufficient-length');
  assert.throws(() => verifyAccessToken(foreign));
});

test('a tampered or malformed token is rejected', () => {
  const { token } = signAccessToken({ sub: '2', role: 'Analyst', employeeCode: 'E2' }, 'jti-3');
  assert.throws(() => verifyAccessToken(token.slice(0, -3) + 'abc'));
  assert.throws(() => verifyAccessToken('not-a-jwt'));
  assert.throws(() => verifyAccessToken(''));
});

test('the JWT secret must be at least 32 characters', () => {
  assert.ok(config.JWT_SECRET.length >= 32, 'JWT_SECRET in .env must be 32 characters or more');
});
