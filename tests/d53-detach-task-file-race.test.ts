// D-53：detach 模式下**主进程与监督进程共享同一个任务文件**
//
// 病灶（实测于 nimrtc-zelto v2-qoe-feed，2026-11-17）：
//
//   `zelto run --detach` 的任务文件有两个写者：
//     - 主进程：写启动信息、supervisorPid、supervisorLog；
//     - 监督进程：写 sessionId、退出码、收尾状态。
//
//   两者的写入是**交错的**：
//     - T+0.00s  主进程 saveTask（sessionId: '' 占位）
//     - T+0.21s  监督进程起 agent，patchTask(sessionId: 真值)
//     - T+1.20s  主进程做「启动存活确认」后 saveTask → **把 sessionId 冲掉**
//
//   后果：界面上的「Session」永远是空的 —— 人无法回答「这一轮是谁在跑」。
//
//   另外还有一个更早的病灶：监督进程的 `--session-id` 是空串占位，
//   `parseSupervisorArgs` 用 `!sessionId` 判空 → 空串被判成「参数不完整」
//   → 监督进程打印一行就退出（码 2）→ 主进程照样报「已在后台跑」
//   → **一个 agent 都没起，却显示 running**。
//
// 这一组用例守的是：
//   1. 空会话 id 是合法占位（不是「参数不完整」）；
//   2. `patchTask` 是补丁式的 —— 不会把别的写者写的字段冲掉。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseSupervisorArgs } from '../src/cli/commands/supervisor.js';
import { patchTask, saveTask, loadTask } from '../src/cli/commands/task-store.js';

describe('D-53 任务文件：补丁式写入', () => {
  it('patchTask 只改给的字段，不冲掉别的写者写的值', () => {
    const cwd = process.cwd();
    const tmp = mkdtempSync(join(tmpdir(), 'zelto-task-'));
    const prevCwd = cwd;
    process.chdir(tmp);
    try {
      // 主进程先写（sessionId 还是空占位）
      saveTask({
        taskId: 'task-s1-1',
        sliceId: 's1',
        sessionId: '',
        agentName: 'agent',
        startedAt: '2026-11-17T00:00:00.000Z',
        status: 'running',
      });

      // 监督进程写回真会话 id
      patchTask('task-s1-1', { sessionId: 'claude-agent-s1-42' });

      // 主进程事后补写 supervisorPid —— 不能把 sessionId 冲掉
      patchTask('task-s1-1', { supervisorPid: 1234 });

      const task = loadTask('task-s1-1');
      assert.ok(task);
      assert.equal(task.sessionId, 'claude-agent-s1-42', '会话 id 不能被后来的写者冲掉');
      assert.equal(task.supervisorPid, 1234);
      assert.equal(task.status, 'running');
    } finally {
      process.chdir(prevCwd);
      try { rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 残留不致命 */ }
    }
  });

  it('patchTask 对不存在的任务返回 null（不凭空造一个）', () => {
    const prevCwd = process.cwd();
    const tmp = mkdtempSync(join(tmpdir(), 'zelto-task2-'));
    process.chdir(tmp);
    try {
      assert.equal(patchTask('task-does-not-exist', { sessionId: 'x' }), null);
    } finally {
      process.chdir(prevCwd);
      try { rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 残留不致命 */ }
    }
  });
});

describe('D-53 监督进程参数：空会话 id 是合法占位', () => {
  it('空串被接受', () => {
    const args = parseSupervisorArgs([
      '--project-root', 'D:/proj',
      '--task-id', 'task-s1-1',
      '--slice-id', 's1',
      '--session-id', '',
      '--agent-command', 'agent',
      '--work-dir', 'D:/wt',
    ]);
    assert.ok(args);
    assert.equal(args.sessionId, '');
  });

  it('参数整个缺失才是错误', () => {
    assert.equal(parseSupervisorArgs([
      '--project-root', 'D:/proj',
      '--task-id', 'task-s1-1',
      '--slice-id', 's1',
      '--agent-command', 'agent',
      '--work-dir', 'D:/wt',
    ]), null);
  });
});
