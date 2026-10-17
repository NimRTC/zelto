// Acceptance test: clarify-state-event
// Verifies that zelto clarify emits slice.state.changed events
// for CLARIFY_START and CLARIFY_CONVERGED transitions

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const BASE_DIR = join(tmpdir(), 'zelto-acceptance-clarify-state-event');
const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');

function zelto(...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI_SCRIPT, ...args], {
      cwd: BASE_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    child.on('error', reject);
  });
}

async function readEvents(sliceId: string): Promise<Record<string, unknown>[]> {
  const eventsFile = join(BASE_DIR, '.zelto', 'events', sliceId, 'events.jsonl');
  if (!existsSync(eventsFile)) return [];
  const content = await readFile(eventsFile, 'utf-8');
  return content
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line) as Record<string, unknown>; }
      catch { return null; }
    })
    .filter((e): e is Record<string, unknown> => e !== null);
}

describe('acceptance: clarify-state-event', () => {
  before(async () => {
    await rm(BASE_DIR, { recursive: true, force: true });
    await mkdir(join(BASE_DIR, '.zelto', 'slices'), { recursive: true });
    await mkdir(join(BASE_DIR, '.zelto', 'events'), { recursive: true });
    await mkdir(join(BASE_DIR, 'specs', 'slices'), { recursive: true });

    // Write config with echo as mock agent
    await writeFile(join(BASE_DIR, '.zelto', 'config.yaml'), [
      'gate:',
      '  commands:',
      '    - { name: test, run: "echo ok" }',
      '    - { name: lint, run: "echo ok" }',
      '  timeoutSec: 30',
      '  retry:',
      '    max: 1',
      'agent:',
      '  command: "echo"',
      '',
    ].join('\n'), 'utf-8');
  });

  after(async () => {
    await rm(BASE_DIR, { recursive: true, force: true });
  });

  it('zelto clarify emits CLARIFY_START state change event', async () => {
    // Create a draft slice and run clarify
    await zelto('create', 'clarify-start-test');
    await writeFile(join(BASE_DIR, 'specs', 'slices', 'clarify-start-test.md'), '# Clarify start test', 'utf-8');
    await zelto('clarify', 'clarify-start-test', '--auto');

    const events = await readEvents('clarify-start-test');
    const stateChangedEvents = events.filter((e) => e.type === 'slice.state.changed');

    // Should have at least CLARIFY_START and CLARIFY_CONVERGED events
    const startEvent = stateChangedEvents.find((e) => {
      const p = e.payload as Record<string, unknown>;
      return p.event === 'CLARIFY_START';
    });
    assert.ok(startEvent, 'should have CLARIFY_START state change event');
    const payload = startEvent.payload as Record<string, unknown>;
    assert.equal(payload.from, 'draft');
    assert.equal(payload.to, 'clarifying');
    assert.equal(payload.sliceId, 'clarify-start-test');
  });

  it('zelto clarify --auto emits CLARIFY_CONVERGED state change event', async () => {
    // Same slice from previous test already went through clarify --auto
    // Create a new slice for independent verification
    await zelto('create', 'clarify-converge-test');
    await writeFile(join(BASE_DIR, 'specs', 'slices', 'clarify-converge-test.md'), '# Clarify converge test', 'utf-8');
    await zelto('clarify', 'clarify-converge-test', '--auto');

    const events = await readEvents('clarify-converge-test');
    const stateChangedEvents = events.filter((e) => e.type === 'slice.state.changed');

    const convergeEvent = stateChangedEvents.find((e) => {
      const p = e.payload as Record<string, unknown>;
      return p.event === 'CLARIFY_CONVERGED';
    });
    assert.ok(convergeEvent, 'should have CLARIFY_CONVERGED state change event');
    const payload = convergeEvent.payload as Record<string, unknown>;
    assert.equal(payload.from, 'clarifying');
    assert.equal(payload.to, 'draft');
    assert.equal(payload.sliceId, 'clarify-converge-test');
  });
});
