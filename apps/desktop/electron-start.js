#!/usr/bin/env node
delete process.env.ELECTRON_RUN_AS_NODE;
const { spawnSync } = require('child_process');
const electron = require('electron');
const result = spawnSync(electron, process.argv.slice(2), {
  stdio: 'inherit',
  windowsHide: false,
});
process.exit(result.status ?? 0);
