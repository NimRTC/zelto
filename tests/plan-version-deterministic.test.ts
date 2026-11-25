// `zelto plan version`：从钉死的切片清单确定性建一个版本（不经 LLM）
//
// 为什么需要它（实测 nimrtc-v14，2026-11-25）：
//
//   已确认的计划里要补 13 个待做项，按「写哪个文件」分三波。
//   `plan add-version` 走 LLM 生成一整版，写集是模型编的、要逐条核对；
//   手改 `.zelto/versions/<id>.json` 是追溯链上的谎言（C4）。
//
// 这个文件钉住：
//   1. createVersion 只加、不猜、不改别的版本（不改入参）
//   2. 校验：label / 重复版本 / 依赖缺失 / 依赖成环 / 重复切片 / 空版本
//   3. 写集归一化 + 缺省规格路径
//   4. `zelto plan version` 真的落盘，并且**双写**到被跟踪的 versions/（ADR-110）

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createVersion } from '../src/core/version/create.js';
import type { VersionPlan } from '../src/core/version/types.js';

function basePlan(): VersionPlan {
  return {
    id: 'plan-test',
    designId: 'dsg-test',
    title: '测试计划',
    versions: [
      {
        version: 'v3',
        dependsOn: [],
        description: '前置版本',
        slices: [
          { id: 'v3-a', module: 'm', title: 'a', writes: ['src/a/**'], specPath: 'specs/slices/v3-a.md', state: 'draft' },
        ],
        integrationTestDir: 'tests/version/v3',
        status: 'integrated',
      },
    ],
    status: 'confirmed',
    createdAt: '2026-01-01T00:00:00.000Z',
    confirmedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('createVersion：确定性建版本', () => {
  it('加一整版，切片写集归一化，缺省规格路径按 id 推', () => {
    const plan = basePlan();
    const { plan: next, version, problems } = createVersion(plan, {
      version: 'v4',
      dependsOn: ['v3'],
      description: '第一波',
      slices: [
        { id: 'v4-b', title: 'B', module: 'm', writes: ['src/b/**', 'src\\b/**', ' src/b/** '] },
        { id: 'v4-c', title: 'C', module: 'm', writes: ['src/c/**'], specPath: 'custom/c.md' },
      ],
    });
    assert.deepEqual(problems, []);
    assert.ok(version);
    assert.equal(version.status, 'planned');
    assert.equal(version.integrationTestDir, 'tests/version/v4');
    assert.deepEqual(version.slices[0].writes, ['src/b/**'], '写集去重 + 正斜杠');
    assert.equal(version.slices[0].specPath, 'specs/slices/v4-b.md');
    assert.equal(version.slices[1].specPath, 'custom/c.md');
    // 不改入参
    assert.equal(plan.versions.length, 1);
    assert.equal(next.versions.length, 2);
  });

  it('拒绝已存在的版本号', () => {
    const { version, problems } = createVersion(basePlan(), {
      version: 'v3',
      description: 'x',
      slices: [{ id: 'v3-b', title: 'b', module: 'm', writes: [] }],
    });
    assert.equal(version, null);
    assert.ok(problems.some((p) => p.kind === 'duplicate-version'));
  });

  it('拒绝不存在的依赖、依赖成环', () => {
    const missing = createVersion(basePlan(), {
      version: 'v4',
      dependsOn: ['v9'],
      description: 'x',
      slices: [{ id: 'v4-a', title: 'a', module: 'm', writes: [] }],
    });
    assert.ok(missing.problems.some((p) => p.kind === 'missing-dep'));

    const plan = basePlan();
    plan.versions.push({
      version: 'v5',
      dependsOn: ['v6'],
      description: 'x',
      slices: [],
      integrationTestDir: 'tests/version/v5',
      status: 'planned',
    });
    const cyclic = createVersion(plan, {
      version: 'v6',
      dependsOn: ['v5'],
      description: 'x',
      slices: [{ id: 'v6-a', title: 'a', module: 'm', writes: [] }],
    });
    assert.ok(cyclic.problems.some((p) => p.kind === 'cycle'));
  });

  it('拒绝切片 id 与别的版本重复（合并归属会歧义）', () => {
    const { problems } = createVersion(basePlan(), {
      version: 'v4',
      description: 'x',
      slices: [{ id: 'v3-a', title: 'dup', module: 'm', writes: [] }],
    });
    assert.ok(problems.some((p) => p.kind === 'duplicate-slice'));
  });

  it('拒绝空版本与非法的版本 label', () => {
    const empty = createVersion(basePlan(), { version: 'v4', description: 'x', slices: [] });
    assert.ok(empty.problems.some((p) => p.kind === 'empty-slices'));

    const bad = createVersion(basePlan(), {
      version: '../v4',
      description: 'x',
      slices: [{ id: 'v4-a', title: 'a', module: 'm', writes: [] }],
    });
    assert.ok(bad.problems.some((p) => p.kind === 'invalid-label'));
  });
});

const REPO = join(tmpdir(), `zelto-plan-version-${Date.now()}`);
const CLI = join(process.cwd(), 'dist', 'cli', 'index.js');

describe('zelto plan version：CLI 端到端', () => {
  before(async () => {
    await mkdir(join(REPO, '.zelto', 'versions'), { recursive: true });
    await mkdir(join(REPO, '.zelto', 'events'), { recursive: true });
    await mkdir(join(REPO, '.zelto', 'slices'), { recursive: true });
    await writeFile(join(REPO, '.zelto', 'config.yaml'), 'project:\n  name: test\n', 'utf-8');
    const plan = basePlan();
    await writeFile(join(REPO, '.zelto', 'versions', 'plan-test.json'), JSON.stringify(plan, null, 2), 'utf-8');
  });
  after(async () => {
    await rm(REPO, { recursive: true, force: true });
  });

  it('落盘到真源 + 双写被跟踪副本，并写 draft.revised 事件', async () => {
    execFileSync(
      process.execPath,
      [
        CLI,
        'plan',
        'version',
        'plan-test',
        'v4',
        '--description',
        '第一波：模块内',
        '--depends-on',
        'v3',
        '--slice',
        'v4-b',
        '--slice-title',
        'B 片',
        '--slice-module',
        'ice',
        '--write',
        'src/b/**',
      ],
      { cwd: REPO, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const runtime = JSON.parse(await readFile(join(REPO, '.zelto', 'versions', 'plan-test.json'), 'utf-8')) as VersionPlan;
    const v4 = runtime.versions.find((v) => v.version === 'v4');
    assert.ok(v4, '真源里有 v4');
    assert.deepEqual(v4.slices.map((s) => s.id), ['v4-b']);

    // ADR-110 决策六：被跟踪副本必须同步
    assert.ok(existsSync(join(REPO, 'versions', 'plan-test.json')), 'tracked 副本存在');
    const tracked = JSON.parse(await readFile(join(REPO, 'versions', 'plan-test.json'), 'utf-8')) as VersionPlan;
    assert.ok(tracked.versions.some((v) => v.version === 'v4'), '副本里也有 v4');

    // C4：事件留痕
    const events = await readFile(join(REPO, '.zelto', 'events', 'draft-plan-plan-test', 'events.jsonl'), 'utf-8');
    assert.match(events, /draft\.revised/);
    assert.match(events, /"addedVersion":"v4"/);
  });

  it('重复加同一版本 → 非零退出，计划不变', async () => {
    let code = 0;
    try {
      execFileSync(
        process.execPath,
        [CLI, 'plan', 'version', 'plan-test', 'v4', '--description', 'again', '--slice', 'v4-z'],
        { cwd: REPO, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (err) {
      code = (err as { status?: number }).status ?? 1;
    }
    assert.notEqual(code, 0);
    const runtime = JSON.parse(await readFile(join(REPO, '.zelto', 'versions', 'plan-test.json'), 'utf-8')) as VersionPlan;
    assert.equal(runtime.versions.filter((v) => v.version === 'v4').length, 1);
    assert.ok(!runtime.versions.some((v) => v.slices.some((s) => s.id === 'v4-z')));
  });
});
