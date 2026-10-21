import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import pinoHttp from 'pino-http';
import type { ApiError, HealthResponse } from '@trf/shared';
import { MESSAGES } from '@trf/shared';
import { APP_VERSION } from './config';
import { isDatabaseReachable, pool } from './db';
import { AppError } from './lib/errors';
import { buildLogger } from './lib/logger';
import { authRouter } from './routes/auth';
import { employeesRouter } from './routes/employees';
import { departmentsRouter } from './routes/departments';
import { assignmentsRouter, catalogRouter } from './routes/assignments';
import { analysisRouter } from './routes/analysis';
import { coaRouter } from './routes/coa';
import { dashboardRouter } from './routes/dashboard';
import { reportsRouter } from './routes/reports';
import { lookupsRouter } from './routes/lookups';
import { auditRouter } from './routes/audit';
import { trfsRouter } from './routes/trfs';
import { searchRouter } from './routes/search';

export const logger = buildLogger();

const apiError = (code: string, message: string): ApiError => ({ error: { code, message } });

export function buildApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(pinoHttp({ logger }));
  app.use(cors());
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
    try {
      const dbOk = await isDatabaseReachable();
      // Unapplied migrations mean the shape on disk is not the shape this build
      // expects, so the server is not ready however well PostgreSQL is answering.
      const { rows } = dbOk
        ? await pool.query<{ applied: string }>(`SELECT count(*)::text AS applied FROM schema_migrations`)
        : { rows: [] as { applied: string }[] };
      const migrated = dbOk && Number(rows[0]?.applied ?? 0) > 0;

      const body = {
        status: dbOk && migrated ? 'ready' : 'degraded',
        database: dbOk ? 'connected' : 'unavailable',
        migrations: migrated ? 'applied' : dbOk ? 'none' : 'unknown',
        version: APP_VERSION,
        serverTime: new Date().toISOString(),
      };
      res.status(dbOk && migrated ? 200 : 503).json(body);
    } catch {
      // Never let a health check fail with a stack trace; the answer is "not ready".
      res.status(503).json({
        status: 'degraded', database: 'unavailable', migrations: 'unknown',
        version: APP_VERSION, serverTime: new Date().toISOString(),
      });
    }
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
  app.use('/api/departments', departmentsRouter);
  app.use('/api/trfs', trfsRouter);
  // Assignments and the test catalogue live under their own prefixes.
  app.use('/api/assignments', assignmentsRouter);
  app.use('/api/test-catalog', catalogRouter);
  app.use('/api/analysis', analysisRouter);
  app.use('/api/coa', coaRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/reports', reportsRouter);
  // The audit trail is read-only, so it is mounted without any write verbs.
  app.use('/api/audit', auditRouter);
  // Customers and products sit under /api/lookups to keep the TRF routes flat.
  app.use('/api/lookups', lookupsRouter);
  // The top-bar search box queries TRFs, tests and certificates in one call.
  app.use('/api/search', searchRouter);

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
