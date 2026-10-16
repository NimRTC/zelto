import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const BASE_DIR = join(tmpdir(), 'zelto-acceptance-sign-test');
const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');

function zelto(...args: string[]): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI_SCRIPT, ...args], {
      cwd: BASE_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('close', (code) => resolve({ stdout: stdout || stderr, code: code ?? 1 }));
    child.on('error', reject);
  });
}

function createSignRequest(id: string, sliceId: string, status: string = 'pending') {
  return {
    id,
    sliceId,
    status,
    requestedAt: new Date().toISOString(),
    requestedBy: 'zelto',
    decidedAt: null,
    decidedBy: null,
    comment: null,
  };
}

describe('acceptance: zelto sign & inbox', () => {
  before(async () => {
    await mkdir(BASE_DIR, { recursive: true });
    await mkdir(join(BASE_DIR, '.zelto', 'slices'), { recursive: true });
    await mkdir(join(BASE_DIR, '.zelto', 'events'), { recursive: true });
    await mkdir(join(BASE_DIR, '.zelto', 'locks'), { recursive: true });
  });

  after(async () => {
    await rm(BASE_DIR, { recursive: true, force: true });
  });

  it('shows empty inbox when no requests', async () => {
    const { stdout, code } = await zelto('inbox', '--list');
    assert.equal(code, 0, `Expected 0, got ${code}: ${stdout}`);
    assert.ok(stdout.includes('Inbox is empty'), `should show empty, got: ${stdout.slice(0, 80)}`);
  });

  it('approves a slice via sign --approve', async () => {
    await zelto('create', 'approve-me');
    await zelto('freeze', 'approve-me');

    const req = createSignRequest('sign-approve-me-1', 'approve-me');
    await writeFile(join(BASE_DIR, '.zelto', 'locks', 'sign-approve-me-1.json'), JSON.stringify(req, null, 2));

    const { stdout, code } = await zelto('sign', 'approve-me', '--approve');
    assert.equal(code, 0, `Expected 0, got ${code}: ${stdout}`);
    assert.ok(stdout.includes('Approved'), 'should show Approved');
  });

  it('rejects a slice via sign --reject', async () => {
    await zelto('create', 'reject-me');
    await zelto('freeze', 'reject-me');

    const req = createSignRequest('sign-reject-me-1', 'reject-me');
    await writeFile(join(BASE_DIR, '.zelto', 'locks', 'sign-reject-me-1.json'), JSON.stringify(req, null, 2));

    const { stdout, code } = await zelto('sign', 'reject-me', '--reject');
    assert.equal(code, 0, `Expected 0, got ${code}: ${stdout}`);
    assert.ok(stdout.includes('Rejected'), 'should show Rejected');
  });

  it('lists pending requests via inbox --list', async () => {
    await zelto('create', 'pending-slice');
    await zelto('freeze', 'pending-slice');

    const req = createSignRequest('sign-pending-1', 'pending-slice');
    await writeFile(join(BASE_DIR, '.zelto', 'locks', 'sign-pending-1.json'), JSON.stringify(req, null, 2));

    const { stdout, code } = await zelto('inbox', '--list');
    assert.equal(code, 0, `Expected 0, got ${code}: ${stdout}`);
    assert.ok(stdout.includes('pending-slice'), 'should list pending slice');
    assert.ok(stdout.includes('approve'), 'should show approve hint');
  });
});
