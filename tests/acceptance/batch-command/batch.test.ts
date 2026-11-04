import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const ZELTO_CLI = join(process.cwd(), 'dist', 'cli', 'index.js');
const TEST_DIR = join(tmpdir(), `zelto-accept-batch-${Date.now()}`);
const ZELTO_DIR = join(TEST_DIR, '.zelto');
const SLICES_DIR = join(ZELTO_DIR, 'slices');
const EVENTS_DIR = join(ZELTO_DIR, 'events');
const LOCKS_DIR = join(ZELTO_DIR, 'locks');
const CONFIG_PATH = join(ZELTO_DIR, 'config.yaml');
const SPEC_DIR = join(TEST_DIR, 'specs', 'slices');
const ACCEPT_DIR = join(TEST_DIR, 'tests', 'acceptance');

function zelto(...args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [ZELTO_CLI, ...args], {
    cwd: TEST_DIR,
    encoding: 'utf-8',
    env: { ...process.env, ZELTO_DIR: TEST_DIR },
  });
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim(), status: result.status };
}

/**
 * 造一个切片。默认各项就绪——测试要改哪项就改哪项。
 */
async function setupSlice(
  id: string,
  overrides: {
    writes?: string[];
    state?: string;
    specFrozen?: boolean;
    trace?: { requirements: string[]; contracts: string[]; tests: string[] };
    specBody?: string;
    specDrift?: boolean;
  } = {},
) {
  const specFrozen = overrides.specFrozen !== false;

  // 规格文件先写——冻结哈希必须是它的真实哈希，否则会被判漂移
  const specBody = overrides.specBody ?? `# ${id}\n`;
  await writeFile(join(SPEC_DIR, `${id}.md`), specBody, 'utf-8');

  const realHash = `sha256:${createHash('sha256').update(specBody).digest('hex')}`;
  const frozenHash = specFrozen
    ? (overrides.specDrift ? 'sha256:stale-hash-from-another-freeze' : realHash)
    : null;

  const slice = {
    id,
    title: `Slice ${id}`,
    state: overrides.state ?? 'frozen',
    spec: {
      path: `specs/slices/${id}.md`,
      frozenHash,
      frozenAt: specFrozen ? new Date().toISOString() : null,
    },
    acceptance: { dir: `tests/acceptance/${id}/`, frozenHash: null, oracleSrc: null },
    baseCommit: null,
    drift: { detected: false, reason: null, at: null },
    trace: overrides.trace ?? {
      requirements: ['REQ-1'],
      contracts: ['CT-1'],
      tests: [`tests/${id}.test.ts`],
    },
    traceWaiver: null,
    writes: overrides.writes ?? [`src/${id}.ts`],
    runs: [],
    stall: { class: null, autoResolved: 0, gateRetries: 0 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeFile(join(SLICES_DIR, `${id}.json`), JSON.stringify(slice, null, 2), 'utf-8');

  // 验收测试目录必须存在，否则验收项判不过
  await mkdir(join(ACCEPT_DIR, id), { recursive: true });
}

describe('zelto batch — 批量开工前的准入审核', { concurrency: false }, () => {
  before(async () => {
    await mkdir(SLICES_DIR, { recursive: true });
    await mkdir(EVENTS_DIR, { recursive: true });
    await mkdir(LOCKS_DIR, { recursive: true });
    await mkdir(SPEC_DIR, { recursive: true });
    await mkdir(ACCEPT_DIR, { recursive: true });
    await writeFile(
      CONFIG_PATH,
      `agent:
  command: npx claude-code
gate:
  commands:
    - name: test
      run: node --test
  timeoutSec: 120
  retry:
    max: 2
`,
      'utf-8',
    );
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  afterEach(async () => {
    const entries = await readdir(SLICES_DIR).catch(() => []);
    for (const entry of entries) {
      await rm(join(SLICES_DIR, entry), { force: true });
    }
  });

  it('没有切片 id 时给出用法并返回 1', () => {
    const result = zelto('batch');
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes('zelto batch'), `Expected usage, got: ${result.stderr}`);
  });

  it('就绪的切片返回 0', async () => {
    await setupSlice('batch-ok-a');
    await setupSlice('batch-ok-b');

    const result = zelto('batch', 'batch-ok-a', 'batch-ok-b');
    assert.equal(result.status, 0, `Expected exit 0, got ${result.status}: ${result.stdout} ${result.stderr}`);
    assert.ok(result.stdout.includes('可以一起开工'), `Expected ready conclusion, got: ${result.stdout}`);
  });

  it('规格未冻结的切片被判阻断', async () => {
    await setupSlice('batch-unfrozen', { specFrozen: false });

    const result = zelto('batch', 'batch-unfrozen');
    assert.equal(result.status, 1);
    assert.ok(result.stdout.includes('不能开工'), `Expected blocked conclusion, got: ${result.stdout}`);
  });

  it('状态不对的切片被判阻断', async () => {
    await setupSlice('batch-draft', { state: 'draft' });

    const result = zelto('batch', 'batch-draft');
    assert.equal(result.status, 1);
    assert.ok(result.stdout.includes('不能开工'), `Expected blocked conclusion, got: ${result.stdout}`);
  });

  it('规格漂移的切片被判阻断', async () => {
    await setupSlice('batch-drift', { specDrift: true });

    const result = zelto('batch', 'batch-drift');
    assert.equal(result.status, 1);
    assert.ok(result.stdout.includes('偏离'), `Expected drift report, got: ${result.stdout}`);
  });

  it('同阶段写集重叠被判阻断', async () => {
    await setupSlice('batch-overlap-a', { writes: ['src/shared/**'] });
    await setupSlice('batch-overlap-b', { writes: ['src/shared/component.ts'] });

    const result = zelto('batch', 'batch-overlap-a', 'batch-overlap-b');
    assert.equal(result.status, 1);
    assert.ok(result.stdout.includes('写集重叠'), `Expected overlap report, got: ${result.stdout}`);
  });

  it('--json 输出可解析且字段齐全', async () => {
    await setupSlice('batch-json-a');
    await setupSlice('batch-json-b');

    const result = zelto('batch', 'batch-json-a', 'batch-json-b', '--json');
    assert.equal(result.status, 0, `Expected exit 0, got ${result.status}: ${result.stderr}`);

    let parsed: any;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      assert.fail(`Expected valid JSON, got: ${result.stdout}`);
    }
    assert.equal(parsed.ready, true);
    assert.equal(parsed.slices.length, 2);
    assert.equal(parsed.phases.length, 1);
    assert.equal(parsed.cycle, null);
    assert.ok(Array.isArray(parsed.issues));
    assert.equal(parsed.errorCount, 0);
  });

  it('--json 在阻断时也给出结构化结果', async () => {
    await setupSlice('batch-json-bad', { specFrozen: false });

    const result = zelto('batch', 'batch-json-bad', '--json');
    assert.equal(result.status, 1);

    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ready, false);
    assert.ok(parsed.errorCount > 0);
    assert.ok(parsed.review.issues.some((i: any) => i.code === 'spec_not_frozen'));
  });

  it('规格里的前置关系排进阶段', async () => {
    await setupSlice('batch-dep-a', { writes: ['src/dep-a.ts'] });
    await setupSlice('batch-dep-b', {
      writes: ['src/dep-b.ts'],
      specBody: '# batch-dep-b\n\n## Prerequisites\n\n- batch-dep-a\n',
    });

    const result = zelto('batch', 'batch-dep-a', 'batch-dep-b', '--json');
    assert.equal(result.status, 0, `Expected exit 0, got ${result.status}: ${result.stdout}`);

    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.phases.length, 2, `Expected 2 phases, got: ${JSON.stringify(parsed.phases)}`);
    assert.deepEqual(parsed.phases[0], ['batch-dep-a']);
    assert.deepEqual(parsed.phases[1], ['batch-dep-b']);
  });

  it('--depends-on 覆盖规格里的前置关系', async () => {
    await setupSlice('batch-ov-a', { writes: ['src/ov-a.ts'] });
    await setupSlice('batch-ov-b', { writes: ['src/ov-b.ts'] });

    const result = zelto('batch', 'batch-ov-a', 'batch-ov-b', '--depends-on', 'batch-ov-b=batch-ov-a', '--json');
    assert.equal(result.status, 0, `Expected exit 0, got ${result.status}: ${result.stdout}`);

    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.phases.length, 2);
    assert.deepEqual(parsed.phases[1], ['batch-ov-b']);
  });

  it('依赖成环时给出环路径', async () => {
    await setupSlice('batch-cycle-a', {
      writes: ['src/cycle-a.ts'],
      specBody: '# batch-cycle-a\n\n## Prerequisites\n\n- batch-cycle-b\n',
    });
    await setupSlice('batch-cycle-b', {
      writes: ['src/cycle-b.ts'],
      specBody: '# batch-cycle-b\n\n## Prerequisites\n\n- batch-cycle-a\n',
    });

    const result = zelto('batch', 'batch-cycle-a', 'batch-cycle-b', '--json');
    assert.equal(result.status, 1);

    const parsed = JSON.parse(result.stdout);
    assert.notEqual(parsed.cycle, null, 'Expected cycle to be reported');
    assert.equal(parsed.ready, false);
  });

  it('找不到的切片直接报错退出', () => {
    const result = zelto('batch', 'batch-does-not-exist');
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes('not found'), `Expected not-found error, got: ${result.stderr}`);
  });
});
