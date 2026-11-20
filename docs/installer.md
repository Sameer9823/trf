# Builds the installer

The installer packages `dist` (the renderer) and `dist-electron` (the main
process), plus `build/default-config.json` as a resource. Nothing else is shipped:
the app talks to the API over the network and has no database driver, so its
installer contains no PostgreSQL, no credentials and no server code.

## Before the first build

Electron's binary is downloaded by its install script, which needs network access.
On a machine without it, `npm install` reports `postinstall` failures for
`electron`. In that case Electron cannot be built here and the packaging step
cannot be verified.

## Building

```bash
npm run build:shared
npm install
npm run package -w @trf/desktop
```

The installer is written to `apps/desktop/release/TRF-Setup-<version>.exe`. It is a
per-user installer: it does not need administrator rights, and it installs into
the user's own profile.

## Pointing the installer at a server

`build/default-config.json` sets the address the app starts with. It is only a
default: an employee can change it under Settings, and that choice is kept in the
user profile, so upgrading does not undo it.

To ship an installer already pointing at a company server, change `serverUrl`
here before building. `readConfig()` in `electron/main.ts` prefers the saved
setting, then this file, then `TRF_API_URL`, then `http://localhost:4000`.

## Verifying a built installer

Not possible in an environment where Electron cannot be installed. After running
the installer on a real PC, check:

1. The app opens and shows the connection status screen.
2. With the server running, signing in works.
3. With the server stopped, the app reports
   `Company server is unavailable. Please connect to the company network.`
4. No console window appears behind the app (`nodeIntegration` off, `sandbox` on).
