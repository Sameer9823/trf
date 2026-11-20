# Deploying the TRF Management System

Two separate installations: one **server** that owns the database and the API,
and one **desktop client** on each PC. No PC runs PostgreSQL.

```
  ┌──────────────────────┐        HTTPS        ┌────────────────────────────┐
  │  Desktop client      │  ─────────────────▶  │  API server                │
  │  (per PC, Electron)  │                      │  Node.js + Express         │
  │  no database, no     │                      │                            │
  │  credentials on disk │                      │  PostgreSQL (same machine) │
  └──────────────────────┘                      └────────────────────────────┘
```

The client stores only the server address. Tokens live in the Electron main
process's memory and are never written to disk.

## 1. Preparing the database

```sql
CREATE USER trf_app WITH PASSWORD 'a-long-password';
CREATE DATABASE trf_system OWNER trf_app;
REVOKE ALL ON DATABASE trf_system FROM PUBLIC;
```

`REVOKE` matters: by default a new database is readable by any PostgreSQL role on
the machine, which is not what a lab system needs.

## 2. Installing the server

```bash
git clone <repository> trf-system
cd trf-system
npm install
cp apps/server/.env.example apps/server/.env
```

Edit `apps/server/.env`:

| Variable | Notes |
| --- | --- |
| `DATABASE_HOST` / `PORT` / `NAME` / `USER` / `PASSWORD` | The values from step 1. |
| `JWT_SECRET` | **Generate, do not type.** `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`. Minimum 32 characters. Rotating it signs every employee out. |
| `LOG_DIR` | Where the daily log files go. Default `./logs`. |
| `LOG_LEVEL` | `info` normally; `debug` only while investigating. |
| `API_HOST` / `API_PORT` | Default `0.0.0.0:4000`. |
| `BACKUP_DIR` | Where `npm run backup` writes. Default `./backups`. |

`apps/server/.env` holds the database password and the token secret. It is in
`.gitignore`. Its permissions should allow only the service account to read it.

## 3. Creating the first administrator

```bash
npm run seed:admin -w @trf/server
```

This runs only when no active administrator exists, marks the password as
"must change at first sign-in", and never runs on server start. **Remove
`ADMIN_PASSWORD` from `.env` afterwards**; leaving it there means the first
password stays written down for the life of the installation.

## 4. Building and running

```bash
npm run build:shared
npm run build -w @trf/server
npm start -w @trf/server
```

Migrations are applied automatically on start, and each is recorded in
`schema_migrations`. Running `npm run migrate -w @trf/server` on its own applies
them without starting the server.

### Running it as a service

Any supervisor works. The important settings are: restart on failure, and
restart on the exit code 1 that a fatal error produces.

**Windows (NSSM):**
```powershell
nssm install TRFApi "C:\Program Files\nodejs\node.exe" `
  "C:\trf-system\apps\server\dist\index.js"
nssm set TRFApi AppDirectory C:\trf-system\apps\server
nssm set TRFApi AppStdout C:\trf-system\logs\service.log
nssm set TRFApi Start SERVICE_AUTO_START
```

**Linux (systemd):** run `node dist/index.js` from `apps/server` as a service
account, with `EnvironmentFile` pointing at the `.env`.

## 5. Health checks

| Endpoint | Answers | Use it for |
| --- | --- | --- |
| `GET /api/health/live` | 200 whenever the process is running | A restart policy. |
| `GET /api/health/ready` | 200 only when PostgreSQL is reachable **and** migrations are applied | A load balancer or an installer check. |
| `GET /api/health` | 200 when PostgreSQL is reachable | The client's connection screen. |

None of them need a token. A server that cannot reach PostgreSQL returns **503**,
not a cheerful 200 — a health check that passes on a broken database is worse
than no check.

## 6. Backups

```bash
npm run backup -w @trf/server
```

This runs `pg_dump` in custom format and keeps 30 days of copies. Verify one:

```bash
# What should be there before you need it
npm run backup:counts -w @trf/server
```

To check a dump is really restorable:

```powershell
& "C:\Program Files\PostgreSQL\16\bin\pg_restore.exe" --list <file>.dump
```

**The tool version must match the server.** A dump written by a newer `pg_dump`
uses a newer archive format that the server's own `pg_restore` refuses
("unsupported version in file header"). The backup script detects the server's
version and picks the matching `pg_dump`, and says which one it used. If it
reports that no matching tool exists, install the PostgreSQL client tools for
the server's version.

To restore:

```powershell
createdb -h localhost -U trf_app trf_system_restored
pg_restore -h localhost -U trf_app -d trf_system_restored --no-owner <file>.dump
```

Restore into a **new** database and check it before putting it into service.
Restoring over a live database overwrites it.

Schedule the backup with Task Scheduler (daily, off-hours) or cron. A backup that
has never been restored is an assumption, not a backup.

## 7. Logs

`LOG_DIR` holds one file per day: `api-YYYY-MM-DD.log`, with 30 days kept and
older files removed automatically. Passwords, tokens and `Authorization` headers
are redacted before anything is written.

## 8. Upgrading

```bash
git pull
npm install
npm run build:shared
npm run build -w @trf/server
```

Then restart the service. Migrations apply on start. Take a backup first — this
is the one step where a mistake is not undoable with git.

The desktop client is installed per PC from the installer; see
`docs/installer.md`. Employees upgrade by running the new installer.

## 9. Troubleshooting

**Client says "Company server is unavailable."**
The client could not reach the API at all. From the PC, open
`http://<server>:4000/api/health/live`. No response means the service is stopped,
the port is blocked, or the address in Settings is wrong.

**Client signs in, then immediately signs out.**
The access token is being rejected immediately. `JWT_SECRET` almost certainly
changed, or the server and client are pointed at different databases. Every
employee is signed out when the secret changes; that is intended.

**"Invalid server configuration" on start.**
A required variable in `apps/server/.env` is missing. The message names it.

**Server starts but every request reports "degraded".**
PostgreSQL is not reachable: check `DATABASE_HOST`/`PORT`/`PASSWORD`, and that
PostgreSQL accepts connections from this machine.

**Two administrators, or none can be signed in.**
`npm run seed:admin` does nothing when an active administrator already exists. An
administrator must reset the other account's password under Employees.

**Log files are not appearing.**
`LOG_DIR` must be writable by the service account. Check the service account has
write permission on that folder.

**A restore finishes but the data is stale.**
Check the file's name for its timestamp and confirm it is the backup you meant.
Copies older than 30 days are deleted automatically.

## What is not covered here

- TLS termination. Run the API behind a reverse proxy that terminates TLS if the
  server is not on a trusted internal network.
- Multi-server deployment. The token counter and the audit trail assume one
  database.
- Automated backup verification. Schedule the `pg_restore --list` check above.
