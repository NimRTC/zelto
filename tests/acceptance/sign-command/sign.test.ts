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

/**
 * 造一条「验收真跑过且通过」的 gate.result 事件（D-48）。
 *
 * 签字前确认项②的判据是 gate.result 事件的 acceptance 字段
 * （ADR-033/051）—— 没有这条事件，确认项②必过不了，签字必被拦。
 */
async function writeAcceptanceGateResult(sliceId: string): Promise<void> {
  const dir = join(BASE_DIR, '.zelto', 'events', sliceId);
  await mkdir(dir, { recursive: true });
  const envelope = {
    ts: new Date().toISOString(),
    type: 'gate.result',
    actor: 'zelto',
    payload: {
      sliceId,
      passed: true,
      results: [
        {
          command: 'acceptance',
          passed: true,
          exitCode: 0,
          durationMs: 123,
          stdout: '# pass 3\n# fail 0\n',
          stderr: null,
        },
      ],
      acceptance: {
        status: 'passed',
        path: `tests/acceptance/${sliceId}`,
        command: 'node --test tests/acceptance/x',
        exitCode: 0,
        durationMs: 123,
      },
    },
  };
  await writeFile(join(dir, 'events.jsonl'), `${JSON.stringify(envelope)}\n`, 'utf-8');
}

/** 造一条追溯齐全的切片文件（确认项①的判据，ADR-060/032）。 */
async function writeSliceWithTrace(sliceId: string): Promise<void> {
  await writeFile(
    join(BASE_DIR, '.zelto', 'slices', `${sliceId}.json`),
    JSON.stringify({
      id: sliceId,
      title: sliceId,
      state: 'completed',
      spec: { path: `specs/slices/${sliceId}.md`, frozenHash: null, frozenAt: null },
      acceptance: { dir: `tests/acceptance/${sliceId}/`, frozenHash: null, oracleSrc: null },
      baseCommit: null,
      drift: { detected: false, reason: null, at: null },
      trace: {
        requirements: [{ text: '需求 R1', ref: 'REQ-1', kind: 'requirement' }],
        contracts: [{ text: '契约 C1', ref: 'CTR-1', kind: 'contract' }],
        tests: [{ text: '测试 T1', ref: 'TST-1', kind: 'test' }],
      },
      traceWaiver: null,
      baseline: false,
      type: 'code',
      writes: [],
      runs: [],
      clarifyRounds: 0,
      stall: { class: null, autoResolved: 0, gateRetries: 0 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, null, 2),
    'utf-8',
  );
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
    // 签字前确认项闸门（D-48）：追溯要齐、验收要真跑过
    await writeSliceWithTrace('approve-me');
    await writeAcceptanceGateResult('approve-me');

    const req = createSignRequest('sign-approve-me-1', 'approve-me');
    await writeFile(join(BASE_DIR, '.zelto', 'locks', 'sign-approve-me-1.json'), JSON.stringify(req, null, 2));

    const { stdout, code } = await zelto('sign', 'approve-me', '--approve');
    assert.equal(code, 0, `Expected 0, got ${code}: ${stdout}`);
    assert.ok(stdout.includes('Approved'), 'should show Approved');
  });

  // ─── D-48：签字必须过「签字前确认项」闸门 ────────────────────────────
  //
  // 病灶（nimrtc-zelto v2-input-binder，2026-11-17）：
  //   验收测试三条用例**全是 `test.todo`**（一条真断言都没有），
  //   规格的 5 条验收标准一条都没被验证过；项目又没配 `gate.acceptance`
  //   → 门禁②的验收步骤记为 `skipped` → gate 报 `passed: true`
  //   → 签字请求照常发出，人面前一片绿灯。
  //
  //   ADR-070 的 `sign --review` 其实抓到了（「验收真跑过本片 ❌」），
  //   但 `--approve` **不经过它** —— 审查工具存在，签字路径绕过审查。
  describe('D-48 · 签字前确认闸门', () => {
    it('验收没跑过 → 拦下批准（退出码 1）', async () => {
      await zelto('create', 'no-acceptance');
      await writeSliceWithTrace('no-acceptance');
      // 故意**不写** gate.result 事件 → 确认项②「验收真跑过本片」必过不了
      const req = createSignRequest('sign-no-acceptance-1', 'no-acceptance');
      await writeFile(join(BASE_DIR, '.zelto', 'locks', 'sign-no-acceptance-1.json'), JSON.stringify(req, null, 2));

      const { stdout, code } = await zelto('sign', 'no-acceptance', '--approve');
      assert.equal(code, 1, `应当拦下，退出码应为 1：${stdout}`);
      assert.ok(stdout.includes('验收真跑过本片'), `应当点名拦截项：${stdout}`);
      assert.ok(!stdout.includes('Approved'), '不应当批准：' + stdout);
    });

    it('追溯链断了 → 拦下批准', async () => {
      await zelto('create', 'no-trace');
      // 追溯为空 → 确认项①「追溯链未断」必过不了
      await writeFile(
        join(BASE_DIR, '.zelto', 'slices', 'no-trace.json'),
        JSON.stringify({
          id: 'no-trace', title: 'no-trace', state: 'completed',
          spec: { path: 'specs/slices/no-trace.md', frozenHash: null, frozenAt: null },
          acceptance: { dir: 'tests/acceptance/no-trace/', frozenHash: null, oracleSrc: null },
          baseCommit: null, drift: { detected: false, reason: null, at: null },
          trace: { requirements: [], contracts: [], tests: [] },
          traceWaiver: null, baseline: false, type: 'code', writes: [], runs: [],
          clarifyRounds: 0, stall: { class: null, autoResolved: 0, gateRetries: 0 },
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        }, null, 2),
        'utf-8',
      );
      await writeAcceptanceGateResult('no-trace');
      const req = createSignRequest('sign-no-trace-1', 'no-trace');
      await writeFile(join(BASE_DIR, '.zelto', 'locks', 'sign-no-trace-1.json'), JSON.stringify(req, null, 2));

      const { stdout, code } = await zelto('sign', 'no-trace', '--approve');
      assert.equal(code, 1, `应当拦下，退出码应为 1：${stdout}`);
      assert.ok(stdout.includes('追溯链未断'), `应当点名拦截项：${stdout}`);
    });

    it('确认项全过 → 批准成功', async () => {
      await zelto('create', 'all-good');
      await writeSliceWithTrace('all-good');
      await writeAcceptanceGateResult('all-good');
      const req = createSignRequest('sign-all-good-1', 'all-good');
      await writeFile(join(BASE_DIR, '.zelto', 'locks', 'sign-all-good-1.json'), JSON.stringify(req, null, 2));

      const { stdout, code } = await zelto('sign', 'all-good', '--approve');
      assert.equal(code, 0, `应当批准，退出码应为 0：${stdout}`);
      assert.ok(stdout.includes('Approved'), `应当批准：${stdout}`);
    });

    it('--force → 明知故犯也能签（留给人一个显式出口）', async () => {
      await zelto('create', 'forced');
      // 既没有追溯也没有验收记录 → 确认项必不过
      const req = createSignRequest('sign-forced-1', 'forced');
      await writeFile(join(BASE_DIR, '.zelto', 'locks', 'sign-forced-1.json'), JSON.stringify(req, null, 2));

      const { stdout, code } = await zelto('sign', 'forced', '--approve', '--force');
      assert.equal(code, 0, `--force 应当放行：${stdout}`);
      assert.ok(stdout.includes('Approved'), `应当批准：${stdout}`);
      assert.ok(stdout.includes('force'), `应当留痕说明跳过了确认项：${stdout}`);
    });

    it('--json 输出里带拦截项明细', async () => {
      await zelto('create', 'json-blocked');
      const req = createSignRequest('sign-json-blocked-1', 'json-blocked');
      await writeFile(join(BASE_DIR, '.zelto', 'locks', 'sign-json-blocked-1.json'), JSON.stringify(req, null, 2));

      const { stdout, code } = await zelto('sign', 'json-blocked', '--approve', '--json');
      assert.equal(code, 1, `应当拦下：${stdout}`);
      const parsed = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop()!);
      assert.equal(parsed.action, 'blocked');
      assert.ok(Array.isArray(parsed.blockers) && parsed.blockers.length > 0);
      assert.ok(parsed.blockers.every((b: { label: string; evidence: string; adrRef: string }) =>
        b.label && b.evidence && b.adrRef));
    });
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
