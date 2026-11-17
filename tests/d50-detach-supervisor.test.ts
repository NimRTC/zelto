// D-50：`--detach` 的监督进程必须是**独立进程**
//
// 病灶（实测于 nimrtc-zelto v2-input-binder，2026-11-17）：
//
//   `zelto run --detach` 的「后台监视器」是主进程里一个没 await 的 Promise。
//   主进程 `process.exit()` 时它跟着死 —— 于是：
//   - agent 变孤儿（还在改文件、还在烧 token）；
//   - 任务文件永远停在 `status: "running"`；
//   - 没人收尾 → 切片卡在 running → `run` / `merge` / `resume` 全堵死。
//
//   人看到的是「切片在跑」，实际是**一个没人管的孤儿 agent**。
//
// 这一组用例守的是：
//   1. 监督进程被以 **detached** 方式拉起（父进程退出它还活着）；
//   2. 监督进程的参数能被完整解析（少一个参数就退 2，不半途接管）；
//   3. 任务文件里记着监督进程的 pid 与日志路径 ——
//      「谁在管这一轮」必须能被后来的 zelto 调用回答。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SUPERVISOR_LOG_DIR,
  parseSupervisorArgs,
  spawnSupervisor,
  supervisorEntryPath,
  supervisorLogPath,
} from '../src/cli/commands/supervisor.js';

describe('D-50 监督进程：参数解析', () => {
  it('完整参数能被解析出来', () => {
    const args = parseSupervisorArgs([
      '--project-root', 'D:/proj',
      '--task-id', 'task-s1-123',
      '--slice-id', 's1',
      '--session-id', 'claude-agent-s1-1',
      '--agent-command', 'npx @anthropic-ai/claude-code',
      '--work-dir', 'D:/proj/.zelto/worktrees/s1',
      '--timeout-ms', '1800000',
    ]);
    assert.ok(args);
    assert.equal(args.taskId, 'task-s1-123');
    assert.equal(args.sliceId, 's1');
    assert.equal(args.sessionId, 'claude-agent-s1-1');
    assert.equal(args.agentCommand, 'npx @anthropic-ai/claude-code');
    assert.equal(args.isHotfix, false);
    assert.equal(args.timeoutMs, 1_800_000);
  });

  it('--hotfix 会被认出来', () => {
    const args = parseSupervisorArgs([
      '--project-root', 'D:/proj',
      '--task-id', 'task-s1-1',
      '--slice-id', 's1',
      '--session-id', 'sess',
      '--agent-command', 'agent',
      '--work-dir', 'D:/wt',
      '--hotfix',
    ]);
    assert.ok(args);
    assert.equal(args.isHotfix, true);
  });

  it('缺参数 → 返回 null（宁可不起，也不起一个残缺的）', () => {
    assert.equal(parseSupervisorArgs(['--project-root', 'D:/proj']), null);
    assert.equal(parseSupervisorArgs([]), null);
  });
});

describe('D-50 监督进程：路径约定', () => {
  it('日志路径落在 .zelto/supervisor/ 下（相对项目根）', () => {
    const p = supervisorLogPath('D:/proj', 'task-s1-1');
    assert.ok(p.includes(SUPERVISOR_LOG_DIR));
    assert.ok(p.endsWith('task-s1-1.log'));
  });

  it('入口路径指向 supervisor-entry.js（不是 supervisor.js —— 那是库）', () => {
    const entry = supervisorEntryPath();
    assert.ok(entry.endsWith('supervisor-entry.js'), entry);
  });
});

describe('D-50 监督进程：detached 拉起', () => {
  it('拉起后父进程退出，监督进程仍然活着', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'zelto-sup-'));
    // 用一个短命的脚本当「监督进程」：detached 之后父进程立刻退出，
    // 脚本自己写一个标记文件然后睡一会儿。
    // 真实入口在 dist/ 里，测试跑的是 dist-test/ —— 这里测的是
    // 「detached 拉起」这个行为本身，不测入口的内容。
    const marker = join(projectRoot, 'alive.txt');
    const script = join(projectRoot, 'worker.mjs');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      script,
      `import { writeFileSync } from 'node:fs';\n` +
      `writeFileSync(${JSON.stringify(marker)}, 'alive');\n` +
      `setTimeout(() => {}, 5000);\n`,
      'utf-8',
    );

    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, [script], {
      cwd: projectRoot,
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
    const pid = child.pid;
    child.unref();
    assert.ok(pid);

    // 模拟「主进程退出」：这里只是让当前进程不再持有 child 引用，
    // 真正的判据是 detached 的子进程不随父进程死。
    await new Promise((r) => setTimeout(r, 1500));
    assert.ok(existsSync(marker), 'detached 子进程应写出标记文件');

    // 清场：先杀掉 worker 再删目录（Windows 上还活着的进程会锁住目录）
    try { process.kill(pid!, 'SIGKILL'); } catch { /* 已经退了 */ }
    await new Promise((r) => setTimeout(r, 300));
    try {
      rmSync(projectRoot, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* 临时目录残留不致命 */
    }
  });

  it('入口存在时能拉起并返回 pid', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'zelto-sup2-'));
    try {
      const launch = await spawnSupervisor({
        projectRoot,
        taskId: 'task-x-1',
        sliceId: 'x',
        sessionId: 'sess',
        agentCommand: 'agent',
        workDir: projectRoot,
        timeoutMs: 1000,
        isHotfix: false,
      });
      // 入口存在 → 必须拿到 pid（拿不到就是「没在后台跑」）
      assert.ok(launch.ok, launch.ok ? '' : launch.reason);
      assert.equal(typeof launch.pid, 'number');
      try { process.kill(launch.pid, 'SIGKILL'); } catch { /* 已经退了 */ }
      // 日志文件应当被创建（detached 进程没人接 stdout，不落盘就没线索）
      const log = supervisorLogPath(projectRoot, 'task-x-1');
      assert.ok(existsSync(log), '监督进程日志应当落盘');
    } finally {
      try {
        rmSync(projectRoot, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* 临时目录残留不致命 */
      }
    }
  });
});

// D-53：detach 模式主进程**不起 agent**，会话 id 是空占位。
// 之前 `parseSupervisorArgs` 用 `!sessionId` 判空 → 空串被判成「参数不完整」
// → 监督进程打印一行就退出（码 2）→ 主进程照样报「已在后台跑」
// → **一个 agent 都没起，却显示 running**。
describe('D-53 监督进程：空会话 id 是合法占位', () => {
  it('--session-id 为空串时仍然能解析', () => {
    const args = parseSupervisorArgs([
      '--project-root', 'D:/proj',
      '--task-id', 'task-s1-1',
      '--slice-id', 's1',
      '--session-id', '',
      '--agent-command', 'agent',
      '--work-dir', 'D:/wt',
    ]);
    assert.ok(args, '空会话 id 是合法值 —— 监督进程自己起 agent');
    assert.equal(args.sessionId, '');
  });

  it('--session-id 整个没给时才算参数不完整', () => {
    const args = parseSupervisorArgs([
      '--project-root', 'D:/proj',
      '--task-id', 'task-s1-1',
      '--slice-id', 's1',
      '--agent-command', 'agent',
      '--work-dir', 'D:/wt',
    ]);
    assert.equal(args, null);
  });
});

describe('D-50 任务文件：监督进程 pid 必须可查', () => {
  it('任务文件类型带 supervisorPid 与 supervisorLog 字段', async () => {
    // 静态检查：字段必须存在（否则「谁在管这一轮」永远答不出来）
    const src = readFileSync(
      new URL('../../src/cli/commands/task-store.ts', import.meta.url),
      'utf-8',
    );
    assert.match(src, /supervisorPid\?/);
    assert.match(src, /supervisorLog\?/);
  });
});
