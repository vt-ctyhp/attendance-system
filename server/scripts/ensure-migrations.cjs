#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const args = new Set(process.argv.slice(2));
const projectRoot = path.resolve(__dirname, '..');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const run = (cmd, cmdArgs) => {
  const result = spawnSync(cmd, cmdArgs, {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env
  });

  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

if (args.has('--dry-run')) {
  run(npx, ['prisma', 'migrate', 'status', '--schema', 'prisma/schema.prisma']);
  process.exit(0);
}

run(npx, ['prisma', 'generate', '--schema', 'prisma/schema.prisma']);
run(npx, ['prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma']);
