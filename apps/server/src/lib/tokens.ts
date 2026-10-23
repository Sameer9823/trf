import jwt, { SignOptions } from 'jsonwebtoken';
import type { Role } from '@trf/shared';
import { config } from '../config';

export interface AccessTokenPayload {
  sub: string;      // employee id
  role: Role;
  employeeCode: string;
  type: 'access';
  actingEmployeeId?: number | null;
  accountId?: number | null;
}

function ttlSeconds(iso: string): number {
  return Math.max(0, Math.floor((new Date(iso).getTime() - Date.now()) / 1000));
}

/** Short-lived access token. Never persisted on disk anywhere in the desktop app. */
export function signAccessToken(payload: Omit<AccessTokenPayload, 'type'>, jti: string): { token: string; expiresAt: string } {
  const options: SignOptions = {
    expiresIn: config.JWT_ACCESS_TTL as SignOptions['expiresIn'],
    issuer: 'trf-api',
    audience: 'trf-desktop',
    jwtid: jti,
  };
  const token = jwt.sign({ ...payload, type: 'access' }, config.JWT_SECRET, options);
  const decoded = jwt.decode(token) as { exp: number };
  return { token, expiresAt: new Date(decoded.exp * 1000).toISOString() };
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const decoded = jwt.verify(token, config.JWT_SECRET, {
    issuer: 'trf-api',
    audience: 'trf-desktop',
  }) as jwt.JwtPayload & Partial<AccessTokenPayload>;

  if (decoded.type !== 'access' || !decoded.sub || !decoded.role) {
    throw new jwt.JsonWebTokenError('Not an access token');
  }
  return { 
    sub: decoded.sub, 
    role: decoded.role, 
    employeeCode: decoded.employeeCode ?? '', 
    type: 'access',
    actingEmployeeId: decoded.actingEmployeeId ?? null,
    accountId: decoded.accountId ?? null,
  };
}

export function refreshTokenExpiry(): Date {
  return new Date(Date.now() + config.JWT_REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export { ttlSeconds };
