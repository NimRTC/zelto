// Acceptance test: config-command
// Verifies `zelto config` (show), `zelto config get` and `zelto config set`:
// - `zelto config` with no subcommand shows the configuration (not just usage)
// - secrets are masked by default; `--raw` opts into the real value
// - `zelto config set` round-trips a value

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const BASE_DIR = join(tmpdir(), `zelto-acceptance-config-command-${process.pid}`);
const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');
const CONFIG_FILE = join(BASE_DIR, '.zelto', 'config.yaml');

function runZelto(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const env: NodeJS.ProcessEnv = { ...process.env, NIMRTC_LLM_API_KEY: 'secret-key-value' };
  // The zelto-specific and ecosystem key names take priority over the config
  // file (ADR-022) — clear them so the test exercises the config path.
  delete env.ZELTO_LLM_API_KEY;
  delete env.DEEPSEEK_API_KEY;
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI_SCRIPT, ...args], {
      cwd: BASE_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    child.on('error', reject);
  });
}

const CONFIG = `gate:
  commands:
    - name: build
      run: echo built
  timeoutSec: 42
  retry:
    max: 1
agent:
  command: echo agent
llm:
  provider: deepseek
  apiKey: "\${NIMRTC_LLM_API_KEY}"
  baseUrl: https://api.deepseek.com
  model: deepseek-chat
`;

describe('acceptance: config-command', () => {
  before(async () => {
    await rm(BASE_DIR, { recursive: true, force: true });
    await mkdir(join(BASE_DIR, '.zelto'), { recursive: true });
    await writeFile(CONFIG_FILE, CONFIG, 'utf-8');
  });

  after(async () => {
    await rm(BASE_DIR, { recursive: true, force: true });
  });

  it('zelto config with no subcommand shows the configuration', async () => {
    const { stdout, code } = await runZelto(['config']);
    assert.equal(code, 0, 'config should exit 0');
    assert.ok(stdout.includes('Configuration:'), `Should print the configuration: ${stdout}`);
    assert.ok(stdout.includes('build'), `Should list gate commands: ${stdout}`);
    assert.ok(stdout.includes('42s'), `Should show gate timeout: ${stdout}`);
  });

  it('zelto config get reads a non-secret value', async () => {
    const { stdout, code } = await runZelto(['config', 'get', 'gate.timeoutSec']);
    assert.equal(code, 0);
    assert.equal(stdout.trim(), '42');
  });

  it('zelto config get masks the api key by default', async () => {
    const { stdout, code } = await runZelto(['config', 'get', 'llm.apiKey']);
    assert.equal(code, 0);
    assert.ok(!stdout.includes('secret-key-value'), `Must not print the raw key: ${stdout}`);
    assert.ok(stdout.includes('***'), `Should print a mask: ${stdout}`);
  });

  it('zelto config get --raw prints the real key', async () => {
    const { stdout, code } = await runZelto(['config', 'get', 'llm.apiKey', '--raw']);
    assert.equal(code, 0);
    assert.equal(stdout.trim(), 'secret-key-value');
  });

  it('zelto config set round-trips a value', async () => {
    const { stdout, code } = await runZelto(['config', 'set', 'gate.timeoutSec', '99']);
    assert.equal(code, 0);
    assert.ok(stdout.includes('99'), `Should echo the new value: ${stdout}`);

    const after = await runZelto(['config', 'get', 'gate.timeoutSec']);
    assert.equal(after.stdout.trim(), '99');
  });
});
