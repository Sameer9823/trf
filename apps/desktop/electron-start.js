#!/usr/bin/env node
delete process.env.ELECTRON_RUN_AS_NODE;
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');
const result = spawnSync(electron, process.argv.slice(2), {
  stdio: 'inherit',
  windowsHide: false,
});
process.exit(result.status ?? 0);
