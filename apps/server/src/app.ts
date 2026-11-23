import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { pinoHttp } from 'pino-http';
import type { ApiError, HealthResponse } from '@trf/shared';
import { MESSAGES } from '@trf/shared';
import { APP_VERSION } from './config.js';
import { isDatabaseReachable, pool } from './db.js';
import { AppError } from './lib/errors.js';
import { buildLogger } from './lib/logger.js';
import { authRouter } from './routes/auth.js';
import { employeesRouter } from './routes/employees.js';
import { teamAccountsRouter } from './routes/team-accounts.js';
import { departmentsRouter } from './routes/departments.js';
import { assignmentsRouter, catalogRouter } from './routes/assignments.js';
import { analysisRouter } from './routes/analysis.js';
import { coaRouter } from './routes/coa.js';
import { dashboardRouter } from './routes/dashboard.js';
import { reportsRouter } from './routes/reports.js';
import { lookupsRouter } from './routes/lookups.js';
import { auditRouter } from './routes/audit.js';
import { notificationsRouter } from './routes/notifications.js';
import { trfsRouter } from './routes/trfs.js';
import { searchRouter } from './routes/search.js';
import { settingsRouter } from './routes/settings.js';
import { ardAssignmentsRouter } from './routes/ard-assignments.js';

export const logger = buildLogger();

const apiError = (code: string, message: string): ApiError => ({ error: { code, message } });

/** Credential endpoints: a fresh login, a password reset, a forgot-password
 *  request. These get the hard limit. */
export const STRICT_AUTH_PATHS = new Set(['/login', '/forgot-password', '/reset-password']);
/** Team members switch user all day, and the PIN is already locked per person in
 *  the database, so select-member gets its own higher limit. */
export const PIN_AUTH_PATHS = new Set(['/select-member']);

export interface AuthLimiterOptions {
  strictMax: number;
  pinMax: number;
  generalMax: number;
  windowMs: number;
}

/**
 * Builds the three auth limiters. Each request passes through exactly one:
 * credential endpoints are strict, select-member is higher, and everything else
 * under /api/auth is loose. Exported so a test can build them on a tiny app,
 * because the real app skips them under NODE_ENV=test.
 */
export function createAuthLimiters({ strictMax, pinMax, generalMax, windowMs }: AuthLimiterOptions) {
  const message = { error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later.' } };
  const strictAuthLimiter = rateLimit({
    windowMs, max: strictMax,
    skip: (req) => !STRICT_AUTH_PATHS.has(req.path),
    message, standardHeaders: true, legacyHeaders: false,
  });
  const pinLimiter = rateLimit({
    windowMs, max: pinMax,
    skip: (req) => !PIN_AUTH_PATHS.has(req.path),
    message, standardHeaders: true, legacyHeaders: false,
  });
  const generalAuthLimiter = rateLimit({
    windowMs, max: generalMax,
    skip: (req) => STRICT_AUTH_PATHS.has(req.path) || PIN_AUTH_PATHS.has(req.path),
    message, standardHeaders: true, legacyHeaders: false,
  });
  return { strictAuthLimiter, pinLimiter, generalAuthLimiter };
}

export function buildApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(pinoHttp({ logger }));

  // Trust proxy: driven by the optional TRUST_PROXY env value (default off).
  // Must be set before any middleware that reads req.ip (the rate limiters below).
  const trustProxy = process.env.TRUST_PROXY?.trim();
  if (trustProxy) {
    const lower = trustProxy.toLowerCase();
    if (lower === 'true' || lower === '1') app.set('trust proxy', true);
    else if (lower === 'false' || lower === '0') app.set('trust proxy', false);
    else if (/^\d+$/.test(lower)) app.set('trust proxy', Number(lower));
    else app.set('trust proxy', trustProxy); // IP/subnet list or preset (e.g. 'loopback')
  }

  // Restrictive CORS: only allow configured origin (Electron app)
  const corsOrigin = process.env.CORS_ORIGIN ?? 'app://trf-desktop';
  app.use(cors({ origin: corsOrigin, credentials: false }));

  // Rate limiters for auth endpoints (skipped in test environment).
  // Credential endpoints get a strict limit; select-member is higher because
  // team members switch user all day and the PIN already locks per person in the
  // database; session endpoints (refresh, me, logout, …) get a high limit so a
  // lab behind one office IP is not blocked during normal work. Each request
  // passes through exactly one limiter.
  if (process.env.NODE_ENV !== 'test') {
    const { strictAuthLimiter, pinLimiter, generalAuthLimiter } = createAuthLimiters({
      strictMax: 20, pinMax: 300, generalMax: 300, windowMs: 15 * 60 * 1000,
    });

    app.use('/api/auth', strictAuthLimiter);
    app.use('/api/auth', pinLimiter);
    app.use('/api/auth', generalAuthLimiter);
  }

  app.use(express.json({ limit: '1mb' }));

  /**
   * Two questions, two answers, because they need different responses. `ready`
   * says the server can serve requests at all: PostgreSQL is reachable and every
   * migration has been applied. `live` only says the process is up, which is what
   * a restart policy should watch.
   *
   * A server that cannot reach PostgreSQL returns 503 rather than a cheerful
   * 200: an installer's health check that passes on a broken database is worse
   * than no check at all.
   */
  app.get('/api/health/live', (_req, res) => {
    res.status(200).json({ status: 'live', version: APP_VERSION });
  });

  app.get('/api/health/ready', async (_req, res) => {
    // Dynamic import to avoid circular dependency with index.ts
    const { isDbReady } = await import('./index.js');
    const ready = isDbReady();
    const dbOk = ready || await isDatabaseReachable();

    const body = {
      status: ready ? 'ready' : 'degraded',
      database: dbOk ? 'connected' : 'unavailable',
      migrations: ready ? 'applied' : dbOk ? 'applying' : 'unknown',
      version: APP_VERSION,
      serverTime: new Date().toISOString(),
    };
    res.status(ready ? 200 : 503).json(body);
  });

  app.get('/api/health', async (_req, res) => {
    const dbOk = await isDatabaseReachable();
    const body: HealthResponse = {
      status: dbOk ? 'ok' : 'degraded',
      database: dbOk ? 'connected' : 'unavailable',
      version: APP_VERSION,
      serverTime: new Date().toISOString(),
    };
    res.status(dbOk ? 200 : 503).json(body);
  });

  app.get('/api/meta', async (_req, res) => {
    // Lets an administrator confirm which server build a PC is talking to.
    res.json({ version: APP_VERSION, minimumClientVersion: '0.1.0' });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/employees', employeesRouter);
  app.use('/api/team-accounts', teamAccountsRouter);
  app.use('/api/departments', departmentsRouter);
  app.use('/api/trfs', trfsRouter);
  // Assignments and the test catalogue live under their own prefixes.
  app.use('/api/assignments', assignmentsRouter);
  app.use('/api/test-catalog', catalogRouter);
  app.use('/api/analysis', analysisRouter);
  app.use('/api/coa', coaRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/reports', reportsRouter);
  // ARD test assignments
  app.use('/api/ard-assignments', ardAssignmentsRouter);
  // The audit trail is read-only, so it is mounted without any write verbs.
  app.use('/api/audit', auditRouter);
  app.use('/api/notifications', notificationsRouter);
  // Customers and products sit under /api/lookups to keep the TRF routes flat.
  app.use('/api/lookups', lookupsRouter);
  // The top-bar search box queries TRFs, tests and certificates in one call.
  app.use('/api/search', searchRouter);
  app.use('/api/settings', settingsRouter);

  app.use((_req, res) => {
    res.status(404).json(apiError('NOT_FOUND', 'Resource not found.'));
  });

  // Technical details go to the server log only; employees get a plain message.
  app.use((err: Error & { status?: number; code?: string; constraint?: string; column?: string; detail?: string }, req: Request, res: Response, _next: NextFunction) => {
    const requestId = req.id;
    if (err instanceof AppError) {
      if (err.status >= 500) req.log.error({ err, requestId }, 'Request failed');
      return res.status(err.status).json({ ...err.toBody(), requestId });
    }
    // Log the PostgreSQL error code, constraint, column and detail so a support
    // engineer can find the cause in one search using the request ID.
    req.log.error({
      err: { message: err.message, code: err.code, constraint: err.constraint, column: err.column, detail: err.detail },
      requestId, stack: err.stack,
    }, 'Request failed');
    if (err.code === '23505') return res.status(409).json({ ...apiError('DUPLICATE', 'This record already exists.'), requestId });
    if (err.code === 'ECONNREFUSED' || err.code === '57P01') {
      return res.status(503).json({ ...apiError('SERVER_UNAVAILABLE', MESSAGES.SERVER_UNAVAILABLE), requestId });
    }
    if (err.code === '23503') return res.status(400).json({ ...apiError('BAD_REQUEST', 'A referenced record does not exist.'), requestId });
    return res.status(500).json({ ...apiError('SERVER_ERROR', 'Something went wrong on the server. Please try again or contact your administrator.'), requestId });
  });

  return app;
}
