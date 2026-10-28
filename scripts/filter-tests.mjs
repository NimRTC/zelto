#!/usr/bin/env node
// Fast unit test runner — excludes slow tests (spawn, SDK, e2e)
// Called by pnpm test:unit. Runs fast tests with default concurrency.

const SLOW_PATTERNS = [
  'executor-adapter',
  'claude-agent-sdk-adapter',
  'ai-pipeline-cli',
  'agent-execution',
  'auto-flow',
  'hook-executable',
  'spec-md-executor-e2e',
  'abandon-command',
  'clarify-command',
  'config-loading',
  'create-command',
  'event-emission',
  'init-command',
  'patch-content',
  'start-command',
];

import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const testDir = join(__dirname, '..', 'dist-test', 'tests');

const allFiles = readdirSync(testDir).filter(f => f.endsWith('.test.js'));
const fastFiles = allFiles.filter(f =>
  !SLOW_PATTERNS.some(p => f.includes(p))
).map(f => join(testDir, f));

if (process.argv.includes('--list-slow')) {
  const slowFiles = allFiles.filter(f =>
    SLOW_PATTERNS.some(p => f.includes(p))
  );
  for (const f of slowFiles) console.log(f);
  process.exit(0);
}

// Spawn node --test with the filtered file list (cross-platform)
const result = spawnSync(process.execPath, ['--test', ...fastFiles], {
  stdio: 'inherit',
  cwd: join(__dirname, '..'),
});

process.exit(result.status ?? 1);
