// ADR-139：提问回路的续跑段必须**重新装**运行时守卫
//
// ## 这个文件钉住什么
//
// 病灶（实测 2026-11-28，探针切片 `probe-claude-smoke`）：
//
//   00:32:28  run.started            ← 装守卫、装钩子
//   00:32:41  policy.decision ×3     ← 首轮判定正常
//   00:33:18  stall.classified       ← agent 提问，切片挂起
//   00:33:18  reservation.released  ← ★ 守卫释放、钩子撤掉
//   00:33:30  run.resumed            ← ★ 续跑 —— 守卫没重新装
//   00:34:05  run.finished           ← agent 在这段里写了文件
//
// **续跑段一条 `policy.decision` 都没有** —— agent 在没人看着的时候改文件。
//
// 修法（ADR-139）：`zelto answer` 续跑前装守卫、续跑后释放；
// 装不上就**拒绝续跑**（C9 的 fail closed）；续跑段也要跑写集审计。
//
// ## 为什么这些用例值得单独一个文件
//
// 「续跑段有守卫」这件事**只有一条外部证据**：事件流里
// `reservation.acquired` / `reservation.released` 成对出现在 `run.resumed` 之后。
// 没有这条证据，修复了也没人看得见 —— 下一个改这块代码的人
// 很容易把 `installResumeGuard` 当成「多余的重复」删掉。
//
// 所以这里钉住**四条**：预约在、钩子在、装不上就拒绝、结束必释放。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installResumeGuard } from '../src/cli/commands/resume-guard.js';
import { MANAGED_SETTINGS_PATH } from '../src/cli/commands/runtime-guard.js';

const ROOT = mkdtempSync(join(tmpdir(), 'zelto-adr139-'));
const ORIG_CWD = process.cwd();

function git(...args: string[]): void {
  execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** 造一个能装守卫的最小环境（git 仓 + 策略 + 切片记录）。 */
function seedSlice(sliceId: string, writes: string[]): void {
  mkdirSync(join(ROOT, '.zelto', 'slices'), { recursive: true });
  mkdirSync(join(ROOT, 'policy'), { recursive: true });
  writeFileSync(join(ROOT, 'policy', 'policy.yaml'), 'rules: []\n', 'utf-8');

  writeFileSync(
    join(ROOT, '.zelto', 'slices', `${sliceId}.json`),
    JSON.stringify(
      {
        id: sliceId,
        title: sliceId,
        state: 'running',
        spec: { path: `specs/slices/${sliceId}.md`, frozenHash: null, frozenAt: null, boundaryHash: null },
        acceptance: { dir: `tests/acceptance/${sliceId}/`, frozenHash: null, oracleSrc: null },
        baseCommit: null,
        drift: { detected: false, reason: null, at: null },
        trace: { requirements: [], contracts: [], tests: [] },
        traceWaiver: null,
        baseline: false,
        writes,
        runs: [],
        stall: { class: 'agent_question', gateRetries: 0, ...{} },
      },
      null,
      2,
    ),
    'utf-8',
  );
}

before(() => {
  git('init', '-q');
  git('config', 'user.email', 'test@zelto.local');
  git('config', 'user.name', 'zelto test');

  // 切片存储与事件流都落在这个仓库根下（`.zelto/`）——
  // 所以进程 cwd 必须切进临时目录，否则测试会往真仓库里写切片记录。
  process.chdir(ROOT);
});

after(() => {
  try {
    process.chdir(ORIG_CWD);
  } catch {
    /* ignore */
  }
  rmSync(ROOT, { recursive: true, force: true });
});

describe('ADR-139 —— 续跑段的守卫：预约在、钩子在', () => {
  it('装守卫后，写集预约生效（releasedAt 为空）', async () => {
    seedSlice('adr139-reserve', ['src/**']);
    const guard = await installResumeGuard({
      sliceId: 'adr139-reserve',
      adapterType: 'claude-agent',
      projectRoot: ROOT,
    });

    const lockPath = join(ROOT, '.zelto', 'locks', 'adr139-reserve.json');
    assert.ok(existsSync(lockPath), `续跑段必须有写集预约：${lockPath}`);

    const lock = JSON.parse(readFileSync(lockPath, 'utf-8')) as {
      releasedAt?: string | null;
      writes?: string[];
    };
    assert.equal(
      lock.releasedAt ?? null,
      null,
      '续跑段的预约必须是**生效中**的 —— releasedAt 有值就等于没有预约',
    );
    assert.deepEqual(
      lock.writes,
      ['src/**'],
      '预约里的写集必须来自切片记录',
    );

    await guard.release();
  });

  it('装守卫后，PreToolUse 钩子装在项目根的 .claude/settings.local.json', async () => {
    seedSlice('adr139-hook', ['src/**']);
    const guard = await installResumeGuard({
      sliceId: 'adr139-hook',
      adapterType: 'claude-agent',
      projectRoot: ROOT,
    });

    const settingsPath = join(ROOT, MANAGED_SETTINGS_PATH);
    assert.ok(existsSync(settingsPath), '续跑段必须装 PreToolUse 钩子');

    // Claude Code 的信封：`hooks.PreToolUse[]` 每一项里再套一层 `hooks[]`。
    const raw = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
      hooks?: {
        PreToolUse?: Array<{
          matcher?: string;
          hooks?: Array<{ type?: string; command?: string }>;
        }>;
      };
    };
    const commands = (raw.hooks?.PreToolUse ?? []).flatMap((e) =>
      (e.hooks ?? []).map((h) => h.command ?? ''),
    );
    assert.ok(
      commands.some((c) => c.includes('--zelto-pretool')),
      `配置里必须有 zelto 那一条 PreToolUse：${JSON.stringify(raw)}`,
    );

    await guard.release();
  });

  it('钩子文件被纳入托管清单（agent 改它 = 关掉门禁 = 越界）', async () => {
    seedSlice('adr139-managed', ['src/**']);
    const guard = await installResumeGuard({
      sliceId: 'adr139-managed',
      adapterType: 'claude-agent',
      projectRoot: ROOT,
    });

    assert.ok(
      guard.managedPaths.includes(MANAGED_SETTINGS_PATH),
      `钩子文件必须在托管清单里（实际：${guard.managedPaths.join(', ')}）`,
    );

    await guard.release();
  });
});

describe('ADR-139 —— 续跑段结束必须释放', () => {
  it('释放后预约被释放（releasedAt 有值）', async () => {
    seedSlice('adr139-release', ['src/**']);
    const guard = await installResumeGuard({
      sliceId: 'adr139-release',
      adapterType: 'claude-agent',
      projectRoot: ROOT,
    });

    await guard.release();

    const lockPath = join(ROOT, '.zelto', 'locks', 'adr139-release.json');
    const lock = JSON.parse(readFileSync(lockPath, 'utf-8')) as { releasedAt?: string | null };
    assert.ok(
      lock.releasedAt,
      '释放后预约必须被释放 —— 悬空的预约会让下片撞写集冲突',
    );
  });

  it('释放后 zelto 那条钩子被撤掉', async () => {
    seedSlice('adr139-unhook', ['src/**']);
    const guard = await installResumeGuard({
      sliceId: 'adr139-unhook',
      adapterType: 'claude-agent',
      projectRoot: ROOT,
    });

    await guard.release();

    const settingsPath = join(ROOT, MANAGED_SETTINGS_PATH);
    // 释放后要么文件整个没了，要么 zelto 那一条被撤了 —— 两种都算干净。
    if (existsSync(settingsPath)) {
      const raw = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
        hooks?: {
          PreToolUse?: Array<{
            matcher?: string;
            hooks?: Array<{ type?: string; command?: string }>;
          }>;
        };
      };
      const commands = (raw.hooks?.PreToolUse ?? []).flatMap((e) =>
        (e.hooks ?? []).map((h) => h.command ?? ''),
      );
      const remaining = commands.filter((c) => c.includes('--zelto-pretool'));
      assert.equal(remaining.length, 0, '释放后不应残留 zelto 的钩子条目');
    }
  });

  it('release() 幂等：重复调用不报错、不重复留痕', async () => {
    seedSlice('adr139-idem', ['src/**']);
    const guard = await installResumeGuard({
      sliceId: 'adr139-idem',
      adapterType: 'claude-agent',
      projectRoot: ROOT,
    });

    await guard.release();
    await guard.release(); // 第二次必须是 no-op

    const lockPath = join(ROOT, '.zelto', 'locks', 'adr139-idem.json');
    const lock = JSON.parse(readFileSync(lockPath, 'utf-8')) as { releasedAt?: string | null };
    assert.ok(lock.releasedAt, '重复释放后预约仍是已释放状态');
  });
});

describe('ADR-139 —— 写集来自切片记录，不是起跑时的 bundle 快照', () => {
  it('预约里的写集 = 切片记录里的 writes', async () => {
    // 切片记录里的写集与任何 bundle 无关 ——
    // bundle 是起跑进程的快照，续跑是另一个进程，读它会引入
    // 「快照与当前记录不一致」的可能。
    seedSlice('adr139-writes', ['docs/adr/**', 'src/core/**']);
    const guard = await installResumeGuard({
      sliceId: 'adr139-writes',
      adapterType: 'claude-agent',
      projectRoot: ROOT,
    });

    const lockPath = join(ROOT, '.zelto', 'locks', 'adr139-writes.json');
    const lock = JSON.parse(readFileSync(lockPath, 'utf-8')) as { writes?: string[] };
    assert.deepEqual(
      lock.writes,
      ['docs/adr/**', 'src/core/**'],
      '写集必须来自切片记录（冻结时钉住的权威）',
    );

    await guard.release();
  });
});

describe('ADR-139 —— 装不上守卫就拒绝续跑（C9 的 fail closed）', () => {
  it('拿不到写集预约时抛错，调用方据此拒绝续跑', async () => {
    // 不 seed 切片 → 读不到切片记录 → 装不了守卫。
    // 判据是「抛错」而不是「静默返回 null」——
    // 静默返回会让调用方以为装上了，然后放行一个无守卫的 agent。
    await assert.rejects(
      () =>
        installResumeGuard({
          sliceId: 'adr139-missing',
          adapterType: 'claude-agent',
          projectRoot: ROOT,
        }),
      (err: Error) => {
        assert.ok(err.message.length > 0, '错误信息要说清出了什么事');
        return true;
      },
      '装不上守卫必须抛错 —— 调用方据此 fail closed 拒绝续跑',
    );
  });
});
