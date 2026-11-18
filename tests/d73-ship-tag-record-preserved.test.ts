// D-73：二次 ship 把版本计划里的 tag 记录抹掉
//
// 病灶（实测 nimrtc-zelto v1 / v2，2026-11-17）：
//   `tagVersion()` 对**已存在**的 tag 返回 false（「不覆盖」），
//   于是 `version.tag = tagged ? tag : undefined` 把计划里**已有的**
//   tag 记录抹成 undefined，事件里也记 `tag: null`。
//
//   但 git 里 tag 好好地在那儿 —— `git tag -l` 看得到。
//   计划说「这一版没打 tag」，git 说「tag 在」——**两个证据打架**。
//
//   实测后果：nimrtc-zelto 的版本计划里
//     v1: tag=undefined   v2: tag=undefined
//     v3: tag="v3"        v4: tag="v4"        v5: tag="v5"
//   差别就是「这一版有没有被 ship 第二次」—— v1 / v2 各被 ship 了两次。
//
// 修法：「本次**有没有新打** tag」与「这一版**有没有** tag」是两件事。
// 判断以 git 里的事实为准，不以「本次有没有新打」为准。
//
// 这一组用例守的是：
//   1. 二次 ship 后，计划里的 tag 记录**仍然保留**；
//   2. 二次 ship 后，事件里的 tag **不是 null**；
//   3. 计划 / 事件 / git 三方一致（不打架）；
//   4. 真没 tag 时仍然记 null（不虚报）；
//   5. `--no-tag` 时显式跳过优先（不因为「tag 已存在」就反悔）。

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

/** 主仓里一份最小可用的 zelto 项目（版本计划 + 一个已完成的切片） */
function makeProject(dir: string): { baseCommit: string } {
  mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@zelto.local'], dir);
  git(['config', 'user.name', 'zelto test'], dir);
  writeFileSync(join(dir, 'keep.txt'), 'keep\n', 'utf-8');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'init'], dir);

  const baseCommit = git(['rev-parse', 'HEAD'], dir).trim();

  git(['checkout', '-q', '-b', 'version/vx'], dir);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'feature.txt'), 'feature\n', 'utf-8');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'version work'], dir);
  git(['checkout', '-q', 'main'], dir);

  mkdirSync(join(dir, '.zelto', 'slices'), { recursive: true });
  mkdirSync(join(dir, '.zelto', 'versions'), { recursive: true });
  writeFileSync(
    join(dir, '.zelto', 'versions', 'plan-1.json'),
    JSON.stringify(
      {
        id: 'plan-1',
        title: '测试计划',
        status: 'confirmed',
        createdAt: '2026-01-01T00:00:00.000Z',
        versions: [
          {
            version: 'vx',
            dependsOn: [],
            description: '测试版本',
            slices: [{ id: 'vx-slice', title: '片', module: 'm', writes: [] }],
            integrationTestDir: 'tests/integration/vx',
            status: 'integrated',
            branch: 'version/vx',
            baseCommit,
          },
        ],
      },
      null,
      2,
    ),
    'utf-8',
  );
  writeFileSync(
    join(dir, '.zelto', 'slices', 'vx-slice.json'),
    JSON.stringify(
      {
        id: 'vx-slice',
        title: '片',
        state: 'completed',
        spec: { path: 'specs/slices/vx-slice.md', frozenHash: null, frozenAt: null },
        acceptance: { dir: 'tests/acceptance/vx-slice/', frozenHash: null, oracleSrc: null },
        baseCommit: null,
        drift: { detected: false, reason: null, at: null },
        trace: { requirements: [], contracts: [], tests: [] },
        traceWaiver: null,
        baseline: false,
        writes: [],
        runs: [],
        clarifyRounds: 0,
        stall: { class: null, autoResolved: 0, gateRetries: 0 },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      null,
      2,
    ),
    'utf-8',
  );

  return { baseCommit };
}

/** 跑一次 `zelto version ship vx` */
function runShip(cwd: string, extra: string[] = []): { stdout: string; stderr: string; code: number } {
  const cli = join(process.cwd(), 'dist', 'cli', 'index.js');
  const r = spawnSync('node', [cli, 'version', 'ship', 'vx', ...extra], { cwd, encoding: 'utf-8' });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? -1 };
}

/**
 * 把版本状态退回 `integrated` —— 模拟真实流程里的 `zelto merge`
 * （`syncVersionPlanAfterMerge` 会把版本推进到 `integrated`）。
 *
 * 没有这一步，第二次 ship 会被状态守卫挡下
 * （`Version "vx" is delivered. Must be "integrated" to ship.`）。
 */
function resetVersionToIntegrated(dir: string): void {
  const path = join(dir, '.zelto', 'versions', 'plan-1.json');
  const plan = JSON.parse(readFileSync(path, 'utf-8')) as {
    versions: Array<{ version: string; status: string }>;
  };
  for (const v of plan.versions) {
    if (v.version === 'vx') v.status = 'integrated';
  }
  writeFileSync(path, JSON.stringify(plan, null, 2), 'utf-8');
}

/** 读版本计划里 vx 的 tag 字段 */
function readPlanTag(dir: string): string | undefined {
  const plan = JSON.parse(readFileSync(join(dir, '.zelto', 'versions', 'plan-1.json'), 'utf-8')) as {
    versions: Array<{ version: string; tag?: string }>;
  };
  return plan.versions.find((v) => v.version === 'vx')?.tag;
}

/** 读事件流里的 version.delivered 事件 */
function readDelivered(dir: string): Array<Record<string, unknown>> {
  const file = join(dir, '.zelto', 'events', 'version-vx', 'events.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => e.type === 'version.delivered');
}

describe('D-73：二次 ship 不应抹掉版本计划里的 tag 记录', () => {
  let dir: string;
  let repo: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zelto-d73-'));
    repo = join(dir, 'repo');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it('第一次 ship：计划与事件都记下 tag', () => {
    makeProject(repo);

    const res = runShip(repo);
    assert.equal(res.code, 0, `ship 应当成功：${res.stdout}\n${res.stderr}`);

    assert.equal(readPlanTag(repo), 'vx', '第一次 ship 后计划里应记下 tag');
    const delivered = readDelivered(repo);
    assert.equal(delivered.length, 1);
    const payload = delivered[0].payload as Record<string, unknown>;
    assert.equal(payload.tag, 'vx', '第一次 ship 后事件里应记下 tag');
  });

  it('二次 ship：计划里的 tag 记录**仍然保留**（不被抹成 undefined）', () => {
    makeProject(repo);

    const first = runShip(repo);
    assert.equal(first.code, 0, `第一次 ship 应当成功：${first.stdout}\n${first.stderr}`);
    assert.equal(readPlanTag(repo), 'vx', '前置事实：第一次 ship 记下了 tag');

    // 第二次 ship —— tag 已存在
    resetVersionToIntegrated(repo);
    const second = runShip(repo);
    assert.equal(second.code, 0, `第二次 ship 应当成功：${second.stdout}\n${second.stderr}`);

    assert.equal(
      readPlanTag(repo),
      'vx',
      '二次 ship 不应抹掉计划里已有的 tag 记录（D-73）',
    );
  });

  it('二次 ship：事件里的 tag 不为 null', () => {
    makeProject(repo);

    runShip(repo);
    resetVersionToIntegrated(repo);
    const second = runShip(repo);
    assert.equal(second.code, 0, `第二次 ship 应当成功：${second.stdout}\n${second.stderr}`);

    const delivered = readDelivered(repo);
    assert.equal(delivered.length, 2, '应当有两条 version.delivered 事件');
    const last = delivered[1].payload as Record<string, unknown>;
    assert.equal(
      last.tag,
      'vx',
      '二次 ship 的事件里 tag 不应为 null —— tag 确实在 git 里',
    );
  });

  it('计划 / 事件 / git 三方一致（不打架）', () => {
    makeProject(repo);

    runShip(repo);
    resetVersionToIntegrated(repo);
    runShip(repo);

    const planTag = readPlanTag(repo);
    const delivered = readDelivered(repo);
    const eventTag = (delivered[delivered.length - 1].payload as Record<string, unknown>).tag as string;

    assert.equal(planTag, eventTag, '计划与事件对 tag 的说法必须一致');

    const gitTags = git(['tag', '-l'], repo).trim().split('\n').filter(Boolean);
    assert.ok(
      gitTags.includes(eventTag as string),
      `git 里应当有 tag "${eventTag}" —— 实际：${gitTags.join(', ')}`,
    );
  });

  it('真没 tag 时仍然记 null（不虚报）', () => {
    makeProject(repo);

    // 用 --no-tag 明确跳过 → 不打 tag，也不记录
    const res = runShip(repo, ['--no-tag']);
    assert.equal(res.code, 0, `ship 应当成功：${res.stdout}\n${res.stderr}`);

    assert.equal(readPlanTag(repo), undefined, '--no-tag 时计划里不应有 tag 记录');
    const delivered = readDelivered(repo);
    const payload = delivered[0].payload as Record<string, unknown>;
    assert.equal(payload.tag, null, '--no-tag 时事件里应记 null');
    assert.equal(git(['tag', '-l'], repo).trim(), '', '--no-tag 时 git 里不该有 tag');
  });
});
