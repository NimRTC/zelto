// ZD-062：门禁超时要杀**整棵**命令树，而不是只杀外壳
//
// 病灶（实测 2026-11-26，`npm test` 全量）：
//
//   `manager.test.js` 跑了 57s 后被判失败，报
//   `EPERM, Permission denied: .../zelto-wt-nested-XXXX`；
//   同一轮 `node --test` 报告里还冒出一行 `?? tests 3xxx` —— 那是**别的进程**
//   往 stdout 里写的。
//
// 根因：门禁用 `shell: true` 拉起命令，超时后只 `child.kill()` 了外壳；
// 它下面的 `node --test ...` 子进程继续跑，占着临时目录里的文件 →
// 紧接着的 `rmSync` 变成 EPERM；子进程的结果也混进了本轮报告。
//
// 这条用例只守**一件事**：超时之后，整棵命令树都真的死了。
// 用一个「父 shell 拉一个孙子、孙子写自己的 pid 文件然后长睡」的命令来验。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { GateExecutor } from '../src/core/gate/executor.js';
import { SliceStore } from '../src/core/slice/store.js';
import { EventStream } from '../src/core/events/stream.js';
import type { GateConfig } from '../src/core/gate/types.js';

const TEST_DIR = join(tmpdir(), `zelto-zd062-${Date.now()}`);
// 残留进程要先手里有 pid，after 里才有东西可收 —— 否则失败时临时目录删不掉，
// 下一次跑又踩上一个「被占住的临时目录」。
let grandchildPid = 0;

/** 进程还活着吗（Windows 用 tasklist，其它平台用 kill -0）。 */
function isAlive(pid: number): boolean {
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], {
        encoding: 'utf-8',
        timeout: 15_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return out.includes(String(pid));
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return pred();
}

describe('ZD-062：门禁超时杀整棵命令树', () => {
  let pidFile: string;

  before(() => {
    mkdirSync(join(TEST_DIR, 'slices'), { recursive: true });
    mkdirSync(join(TEST_DIR, 'events'), { recursive: true });
    pidFile = join(TEST_DIR, 'grandchild.pid');
  });

  after(() => {
    // 用例失败时孙子可能还活着（那正是被测的错误行为）——
    // 先收掉，否则临时目录删不掉，下一次跑再踩一次 EPERM。
    if (grandchildPid > 0 && isAlive(grandchildPid)) {
      try {
        if (process.platform === 'win32') {
          execFileSync('taskkill', ['/pid', String(grandchildPid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          process.kill(grandchildPid, 'SIGKILL');
        }
      } catch {
        /* 尽力而为 */
      }
    }
    rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 3 });
  });

  it('超时后：孙子进程也被杀掉，不会在 rmSync 时变成 EPERM', async () => {
    const store = new SliceStore(join(TEST_DIR, 'slices'));
    const events = new EventStream(join(TEST_DIR, 'events'));
    const pid = pidFile.replace(/\\/g, '/');
    const run = `node -e "require('fs').writeFileSync('${pid}', String(process.pid)); setTimeout(() => {}, 600000)"`;
    const config: GateConfig = {
      commands: [{ name: 'hang', run }],
      timeoutSec: 3,
      retry: { max: 1, budgetStepUsd: 0 },
    };
    const executor = new GateExecutor(store, events, config, TEST_DIR);
    const slice = store.create('zd062', 'ZD-062');
    slice.state = 'frozen';
    slice.spec.frozenHash = 'x';
    slice.spec.frozenAt = new Date().toISOString();
    await store.write(slice);

    const report = await executor.execute('zd062');
    assert.equal(report.passed, false, '超时必须判失败');

    assert.ok(existsSync(pidFile), '孙子应该写下过 pid（证明命令真的跑起来了）');
    const grandchild = Number(readFileSync(pidFile, 'utf-8').trim());
    assert.ok(grandchild > 0);
    grandchildPid = grandchild;

    // 超时后记下 pid 的那一刻，孙子可能还没死透 —— 给一小段宽限。
    const dead = await waitFor(() => !isAlive(grandchild), 15_000);
    assert.equal(dead, true, `超时后孙子进程 ${grandchild} 仍然活着（只杀了外壳）`);

    // 整棵树都死了 → 临时目录删得掉（不会 EPERM）
    rmSync(TEST_DIR, { recursive: true, force: true });
  });
});
