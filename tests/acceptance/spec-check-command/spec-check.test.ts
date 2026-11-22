// Acceptance test: spec-check-command
//
// 跑的是 `dist/cli/index.js` 这个**真实 CLI 进程**，验的是
// 「命令接上去之后是不是真的能用」——
// git 改动收集、切片读取、规格读取、退出码、事件落盘。
//
// 与单元测试（tests/core/spec-conformance/）的分工：
//   单元测试验「core 里的判定逻辑对不对」（喂进去假的改动清单）
//   这里验「命令真的能拿到 git 的真实改动并判对」——
//   单元测试**够不到**这一段：git 那一层只能靠真仓库验。
//
// 关键设计：测试目录必须是**真的 git 仓库**且**有真的提交**，
// 否则 `collectChangedFiles` 拿不到 diff（读不到就说读不到，不假装）。

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');
const TEST_DIR = join(
  tmpdir(),
  `zelto-accept-spec-check-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
);

function zelto(...args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [CLI_SCRIPT, ...args], {
    cwd: TEST_DIR,
    encoding: 'utf-8',
    timeout: 20000,
  });
  return {
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
    status: result.status,
  };
}

function git(...args: string[]): { stdout: string; status: number | null } {
  const result = spawnSync('git', args, {
    cwd: TEST_DIR,
    encoding: 'utf-8',
    timeout: 20000,
  });
  return { stdout: (result.stdout ?? '').trim(), status: result.status };
}

/** 写一个切片文件（含 gate 需要的字段） */
async function writeSlice(id: string, opts: { writes?: string[]; baseCommit?: string } = {}): Promise<void> {
  const dir = join(TEST_DIR, '.zelto', 'slices');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${id}.json`),
    JSON.stringify({
      id,
      title: `Slice ${id}`,
      state: 'frozen',
      spec: { path: `specs/slices/${id}.md`, frozenHash: null, frozenAt: null },
      acceptance: { dir: `tests/acceptance/${id}/`, frozenHash: null, oracleSrc: null },
      baseCommit: opts.baseCommit ?? null,
      drift: { detected: false, reason: null, at: null },
      trace: { requirements: [], contracts: [], tests: [] },
      traceWaiver: null,
      writes: opts.writes ?? [],
      runs: [],
      stall: { class: null, autoResolved: 0, gateRetries: 0 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    'utf-8',
  );
}

/** 写一份规格文件 */
async function writeSpec(id: string, body: string): Promise<void> {
  const dir = join(TEST_DIR, 'specs', 'slices');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.md`), body, 'utf-8');
}

describe('zelto spec-check (acceptance)', { concurrency: false }, () => {
  before(async () => {
    await mkdir(TEST_DIR, { recursive: true });

    // 必须是**真的 git 仓库** —— 符合性检查的核心事实来自 git diff
    assert.equal(git('init').status, 0, 'git init failed');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');

    // 建基线文件并提交 —— 没有 HEAD 就没有 diff 基准
    await mkdir(join(TEST_DIR, 'src'), { recursive: true });
    await writeFile(join(TEST_DIR, 'src', 'existing.ts'), 'export const existing = 1;\n', 'utf-8');
    assert.equal(git('add', '-A').status, 0, 'git add failed');
    assert.equal(git('commit', '-m', 'baseline').status, 0, 'git commit failed');

    const init = zelto('init');
    assert.equal(init.status, 0, `init failed: ${init.stderr}`);
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // 还原工作区到基线，每个用例从同一状态开始
    git('checkout', '--', '.');
    git('clean', '-fd');
  });

  // ─── 基本形态 ────────────────────────────────────────────────────────────

  it('without a slice id is a usage error', () => {
    const result = zelto('spec-check');
    assert.equal(result.status, 1, 'no id should exit 1');
    // 错误走 stderr（JSON 模式下 `f.error` 写 stderr）
    assert.ok(result.stderr.includes('USAGE'), `Expected USAGE error, got: ${result.stderr}`);
  });

  it('for a nonexistent slice exits 1', () => {
    const result = zelto('spec-check', 'no-such-slice');
    assert.equal(result.status, 1, 'missing slice should exit 1');
    assert.ok(result.stderr.includes('NOT_FOUND'), `Expected NOT_FOUND, got: ${result.stderr}`);
  });

  // ─── 没有改动 ────────────────────────────────────────────────────────────

  it('with no changes makes no conformance judgment', async () => {
    await writeSlice('clean-slice');
    await writeSpec('clean-slice', '# 规格\n\n## 验收标准\n\n1. `src/existing.ts` 应当被修改。\n');

    // 把切片文件与规格**提交**掉 —— 否则它们本身是未跟踪的新文件，
    // 那就是「有改动」，检查会照常做（这正是下一条用例验的事）。
    git('add', '-A');
    git('commit', '-m', 'clean slice');

    const result = zelto('spec-check', 'clean-slice');
    assert.equal(result.status, 0, `no changes should exit 0: ${result.stderr}`);
    assert.ok(
      result.stdout.includes('没有检出任何改动'),
      `Expected "no changes detected", got: ${result.stdout}`,
    );
  });

  // ─── 已实现 ──────────────────────────────────────────────────────────────

  it('reports a requirement as implemented when the path was touched', async () => {
    await writeSlice('impl-slice');
    await writeSpec(
      'impl-slice',
      '# 规格\n\n## 验收标准\n\n1. `src/existing.ts` 应当被修改。\n',
    );
    git('add', '-A');
    git('commit', '-m', 'impl slice setup');

    await writeFile(join(TEST_DIR, 'src', 'existing.ts'), 'export const existing = 2;\n', 'utf-8');
    git('add', '-A');

    const result = zelto('spec-check', 'impl-slice');
    assert.equal(result.status, 0, `implemented should exit 0: ${result.stderr}`);
    assert.ok(
      result.stdout.includes('已实现'),
      `Expected "implemented", got: ${result.stdout}`,
    );
  });

  // ─── 未实现 → 退出码 1 ──────────────────────────────────────────────────

  it('reports a missing requirement and exits 1', async () => {
    await writeSlice('missing-slice');
    await writeSpec(
      'missing-slice',
      '# 规格\n\n## 验收标准\n\n1. `src/never-touched.ts` 应当被新建。\n',
    );

    // 先把切片与规格提交掉 —— 这样唯一的改动就是下面那个源码文件，
    // 「规格要的那条没有证据」才是干净的前提。
    git('add', '-A');
    git('commit', '-m', 'missing slice setup');

    // 动一个别的文件 —— 规格要的那条依然没有证据
    await writeFile(join(TEST_DIR, 'src', 'existing.ts'), 'export const existing = 3;\n', 'utf-8');
    git('add', '-A');

    const result = zelto('spec-check', 'missing-slice');
    assert.equal(result.status, 1, 'a missing requirement should exit 1');
    assert.ok(
      result.stderr.includes('SPEC_NONCONFORMANCE'),
      `Expected SPEC_NONCONFORMANCE, got: ${result.stderr}`,
    );
  });

  // ─── 范围蔓延：只报告，不拦 ─────────────────────────────────────────────

  it('reports scope creep but still exits 0', async () => {
    await writeSlice('creep-slice');
    await writeSpec(
      'creep-slice',
      '# 规格\n\n## 验收标准\n\n1. `src/existing.ts` 应当被修改。\n',
    );
    git('add', '-A');
    git('commit', '-m', 'creep slice setup');

    // 满足规格要求（动 existing.ts）**同时**多动一个规格没提的文件
    await writeFile(join(TEST_DIR, 'src', 'existing.ts'), 'export const existing = 7;\n', 'utf-8');
    await writeFile(join(TEST_DIR, 'src', 'unexpected.ts'), 'export const u = 1;\n', 'utf-8');
    git('add', '-A');

    const result = zelto('spec-check', 'creep-slice');
    assert.equal(result.status, 0, `scope creep alone should not fail: ${result.stderr}`);
    assert.ok(
      result.stdout.includes('unexpected.ts'),
      `Expected the scope creep file to be listed, got: ${result.stdout}`,
    );
  });

  it('does not report zelto managed files as scope creep', async () => {
    await writeSlice('managed-slice');
    await writeSpec(
      'managed-slice',
      '# 规格\n\n## 验收标准\n\n1. `src/existing.ts` 应当被修改。\n',
    );
    git('add', '-A');
    git('commit', '-m', 'managed slice setup');

    // 只改 zelto 自己的托管文件（切片文件 + 事件流），
    // 同时满足规格要求 —— 这样唯一的「没点名」文件就是托管文件
    await writeFile(join(TEST_DIR, 'src', 'existing.ts'), 'export const existing = 8;\n', 'utf-8');
    await writeFile(
      join(TEST_DIR, '.zelto', 'slices', 'managed-slice.json'),
      JSON.stringify({ id: 'managed-slice', touched: true }),
      'utf-8',
    );
    git('add', '-A');

    const result = zelto('spec-check', 'managed-slice');
    assert.equal(result.status, 0);
    assert.ok(
      !result.stdout.includes('规格没点名的改动'),
      `Managed files must not be reported as scope creep, got: ${result.stdout}`,
    );
  });

  // ─── 判不了 ──────────────────────────────────────────────────────────────

  it('reports an abstract requirement as undetermined, not missing', async () => {
    await writeSlice('abstract-slice');
    await writeSpec(
      'abstract-slice',
      '# 规格\n\n## 验收标准\n\n1. 解析器应当健壮。\n',
    );
    git('add', '-A');
    git('commit', '-m', 'abstract slice setup');

    await writeFile(join(TEST_DIR, 'src', 'existing.ts'), 'export const existing = 6;\n', 'utf-8');
    git('add', '-A');

    const result = zelto('spec-check', 'abstract-slice');
    assert.equal(result.status, 0, 'an undetermined requirement should not fail');
    assert.ok(
      result.stdout.includes('判不了') || result.stdout.includes('无法用确定性判据核实'),
      `Expected "undetermined", got: ${result.stdout}`,
    );
  });

  // ─── JSON 输出 ───────────────────────────────────────────────────────────

  it('--json returns a structured report', async () => {
    await writeSlice('json-slice');
    await writeSpec(
      'json-slice',
      '# 规格\n\n## 验收标准\n\n1. `src/existing.ts` 应当被修改。\n',
    );
    git('add', '-A');
    git('commit', '-m', 'json slice setup');

    await writeFile(join(TEST_DIR, 'src', 'existing.ts'), 'export const existing = 4;\n', 'utf-8');
    git('add', '-A');

    const result = zelto('spec-check', 'json-slice', '--json');
    assert.equal(result.status, 0, `json should exit 0: ${result.stderr}`);

    const parsed = JSON.parse(result.stdout);
    const data = parsed.data as {
      sliceId: string;
      specPath: string;
      report: {
        totalRequirements: number;
        implemented: number;
        missing: number;
        unknown: number;
        scopeCreep: unknown[];
      };
    };
    assert.equal(data.sliceId, 'json-slice');
    assert.equal(data.specPath, 'specs/slices/json-slice.md');
    assert.equal(data.report.totalRequirements, 1);
    assert.equal(data.report.implemented, 1);
    assert.equal(data.report.missing, 0);
    assert.ok(Array.isArray(data.report.scopeCreep));
  });

  // ─── 事件流 ──────────────────────────────────────────────────────────────

  it('writes a conformance_checked event', async () => {
    await writeSlice('event-slice');
    await writeSpec(
      'event-slice',
      '# 规格\n\n## 验收标准\n\n1. `src/existing.ts` 应当被修改。\n',
    );
    git('add', '-A');
    git('commit', '-m', 'event slice setup');

    await writeFile(join(TEST_DIR, 'src', 'existing.ts'), 'export const existing = 5;\n', 'utf-8');
    git('add', '-A');

    const result = zelto('spec-check', 'event-slice');
    assert.equal(result.status, 0);

    const eventFile = join(TEST_DIR, '.zelto', 'events', 'event-slice', 'events.jsonl');
    assert.ok(existsSync(eventFile), 'event file should exist');

    const content = await readFile(eventFile, 'utf-8');
    assert.ok(
      content.includes('spec.conformance_checked'),
      'should record a conformance check event',
    );
  });
});
