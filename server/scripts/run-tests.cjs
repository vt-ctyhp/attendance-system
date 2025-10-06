#!/usr/bin/env node

const { execSync } = require('node:child_process');
const { resolve } = require('node:path');

const projectRoot = resolve(__dirname, '..');

try {
  execSync('npx vitest run --no-file-parallelism', {
    cwd: projectRoot,
    env: process.env,
    stdio: 'inherit'
  });
} catch (error) {
  process.exit(error.status ?? 1);
}
