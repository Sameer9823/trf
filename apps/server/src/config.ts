import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().default(4000),
  LOG_DIR: z.string().default('./logs'),
  DATABASE_HOST: z.string().min(1),
  DATABASE_PORT: z.coerce.number().int().default(5432),
  DATABASE_NAME: z.string().min(1),
  DATABASE_USER: z.string().min(1),
  DATABASE_PASSWORD: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().default(10),
  /** Required from Phase 2 on: signing access and refresh tokens. */
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1).max(120).default(15),
  /** Seeded only by the admin:seed script, never by the server on start. */
  ADMIN_USERNAME: z.string().min(1).optional(),
  ADMIN_PASSWORD: z.string().min(12).optional(),
  ADMIN_EMPLOYEE_CODE: z.string().min(1).optional(),
  ADMIN_FULL_NAME: z.string().min(1).optional(),
  ADMIN_EMAIL: z.string().email().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const missing = parsed.error.issues.map((i) => `${i.path.join('.')}${i.message ? ` (${i.message})` : ''}`).join(', ');
  console.error(`Invalid server configuration. Check these variables in .env: ${missing}`);
  process.exit(1);
}
export const config = parsed.data;
export const APP_VERSION = '0.2.0';
