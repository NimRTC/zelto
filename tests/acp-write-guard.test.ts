// 运行时守卫 —— C9 主判定点的两种形态（ADR-133）
//
// 这个文件钉住 ADR-133 验收标准第 2 条：
//
//   **ACP 路线下不装任何 hook 配置** ——
//   `.claude/settings.local.json` / `.cursor/hooks.json` / `.codex/hooks.json`
//   都不被 zelto 动。
//
// 为什么这条要单独测：ACP agent **不读**某家 CLI 的 hooks 配置。
// 装了等于「看起来装了、实际不生效」—— ADR-083 里「假想工具名」的同形状坑。
// 而且更糟：同一会话两套闸门 = 两份 `policy.decision`、两种结论可能并存，
// 追溯链反而变脏。
//
// 另外还钉住：**预约照取不误** —— permission 回调读的正是那份预约，
// 「谁来问」不同不等于「有没有判据」。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installRuntimeGuard } from '../src/cli/commands/runtime-guard.js';

let workDir: string;
let projectRoot: string;

before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'zelto-guard-work-'));
  projectRoot = mkdtempSync(join(tmpdir(), 'zelto-guard-proj-'));
  mkdirSync(join(projectRoot, '.zelto'), { recursive: true });

  // worktree 必须是个 git 仓库 —— 守卫开工前要拍基线快照（D-29/D-61），
  // 读不到基线就**拒绝开工**（那是有意的 fail closed）。
  execFileSync('git', ['init', '-q'], { cwd: workDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@zelto.local'], { cwd: workDir });
  execFileSync('git', ['config', 'user.name', 'zelto test'], { cwd: workDir });
  writeFileSync(join(workDir, 'README.md'), '# test\n', 'utf-8');
  execFileSync('git', ['add', '.'], { cwd: workDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: workDir, stdio: 'ignore' });
});

after(() => {
  rmSync(workDir, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

describe("守卫 —— permission 路线**不装任何 hook 配置**（ADR-133 验收 2）", () => {
  it('三个 hook 配置文件都不被创建', async () => {
    const guard = await installRuntimeGuard({
      sliceId: 'slice-acp',
      writes: ['src/**'],
      worktree: workDir,
      projectRoot,
      writeGuard: 'permission',
    });

    try {
      for (const rel of [
        '.claude/settings.local.json',
        '.cursor/hooks.json',
        '.codex/hooks.json',
      ]) {
        assert.equal(
          existsSync(join(workDir, rel)),
          false,
          `${rel} 不该被创建 —— ACP 路线不装 hook`,
        );
      }
    } finally {
      await guard.release();
    }
  });

  it('预约照取不误（permission 回调读的正是它）', async () => {
    const guard = await installRuntimeGuard({
      sliceId: 'slice-acp-2',
      writes: ['src/**'],
      worktree: workDir,
      projectRoot,
      writeGuard: 'permission',
    });

    try {
      assert.equal(guard.reservation.sliceId, 'slice-acp-2');
      assert.deepEqual(guard.reservation.writes, ['src/**']);
    } finally {
      await guard.release();
    }
  });

  it('release 不去动用户自己的 hook 配置', async () => {
    // 用户本来就有 `.cursor/hooks.json`（他自己的配置）——
    // zelto 没装过，就不该在 release 时去改它。
    const cursorHooks = join(workDir, '.cursor', 'hooks.json');
    mkdirSync(join(workDir, '.cursor'), { recursive: true });
    const original = JSON.stringify({ hooks: { userOwn: { command: 'echo hi' } } }, null, 2);
    writeFileSync(cursorHooks, original, 'utf-8');

    const guard = await installRuntimeGuard({
      sliceId: 'slice-acp-3',
      writes: ['src/**'],
      worktree: workDir,
      projectRoot,
      writeGuard: 'permission',
    });
    await guard.release();

    assert.equal(
      readFileSync(cursorHooks, 'utf-8'),
      original,
      'zelto 没装过钩子，就不该在收尾时动用户的文件',
    );
  });

  it('hook 路线仍然装钩子（既有行为不变）', async () => {
    // ADR-133 是**增量**不是迁移：现有三个 adapter 的行为一个字都不许变。
    const guard = await installRuntimeGuard({
      sliceId: 'slice-claude',
      writes: ['src/**'],
      worktree: workDir,
      projectRoot,
      harness: 'claude-code',
      writeGuard: 'hook',
    });

    try {
      assert.equal(
        existsSync(join(workDir, '.claude', 'settings.local.json')),
        true,
        'hook 路线必须照旧装钩子',
      );
    } finally {
      await guard.release();
    }
  });
});
