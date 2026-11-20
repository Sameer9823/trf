import argon2 from 'argon2';
import crypto from 'node:crypto';

// OWASP-recommended argon2id parameters. A hash is stored, never a password.
const OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, OPTIONS);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

export function randomToken(bytes = 48): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Refresh tokens are stored as SHA-256 digests, so the table is useless to an attacker. */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * A constant-time string comparison, used where a mismatch must not leak timing
 * information (refresh token lookup).
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * A dummy argon2id hash used for timing-safe password verification when the
 * user does not exist. This ensures the verification takes the same amount of
 * time regardless of whether the account exists, preventing username enumeration
 * via timing attacks.
 */
export const DUMMY_PASSWORD_HASH = '$argon2id$v=19$m=19456,t=2,p=1$dW1teXNhbHQ$dW1teWhhc2g';
