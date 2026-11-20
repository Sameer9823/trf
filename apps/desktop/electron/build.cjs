const fs = require('fs');
const { spawnSync } = require('child_process');

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', shell: true, ...opts });
  if (result.status !== 0) {
    process.exit(result.status);
  }
}

// Create electron/package.json with "type": "commonjs" for preload compilation
fs.writeFileSync('electron/package.json', '{"type":"commonjs"}');

// Compile preload first (needs CommonJS)
run('npx', ['tsc', '-p', 'electron/tsconfig.preload.json']);

// Remove the temporary package.json
fs.rmSync('electron/package.json');

// Compile main (needs ESM)
run('npx', ['tsc', '-p', 'electron/tsconfig.json']);

// Rename preload.js to preload.cjs so Electron loads it as CommonJS
fs.renameSync('dist-electron/preload.js', 'dist-electron/preload.cjs');