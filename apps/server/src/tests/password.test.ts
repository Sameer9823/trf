import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { hashPassword, hashToken, randomToken, verifyPassword } from '../lib/password';

test('a password verifies against its own hash and not against another', async () => {
  const hash = await hashPassword('Correct-Horse-42');
  assert.equal(await verifyPassword(hash, 'Correct-Horse-42'), true);
  assert.equal(await verifyPassword(hash, 'correct-horse-42'), false);
  assert.equal(await verifyPassword(hash, ''), false);
});

test('the plaintext password never appears in the stored hash', async () => {
  const hash = await hashPassword('PlainTextMustNotLeak-9');
  assert.equal(hash.includes('PlainTextMustNotLeak'), false);
  assert.match(hash, /^\$argon2id\$/);
});

test('the same password hashed twice gives different hashes (salted)', async () => {
  const [a, b] = await Promise.all([hashPassword('Same-Input-1'), hashPassword('Same-Input-1')]);
  assert.notEqual(a, b);
});

test('a malformed hash fails closed instead of throwing', async () => {
  assert.equal(await verifyPassword('not-a-hash', 'anything'), false);
  assert.equal(await verifyPassword('', 'anything'), false);
});

test('refresh tokens are random and stored only as digests', () => {
  const token = randomToken();
  assert.notEqual(token, randomToken());
  const digest = hashToken(token);
  assert.equal(digest.length, 64);
  assert.equal(digest, hashToken(token));
  assert.equal(digest.includes(token), false);
});
