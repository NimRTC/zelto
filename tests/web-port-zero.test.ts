// `zelto web --port 0` —— 让系统分配一个空闲端口（多开驾驶舱）
//
// ── 为什么需要这个 ────────────────────────────────────────────────────
//
// 同一台机器上常同时开多个项目的驾驶舱（zelto 自身 + nimrtc-v14 + …）。
// 每个都得自己记一个不冲突的端口 —— 忘了就会撞，撞了就会得到
// 「端口 4321 已被占用」的报错，**第二块仪表盘起不来**。
//
// `--port 0` 把这件事交给操作系统：系统给一个当前没人占的端口。
// 人不需要记端口，也不需要试。
//
// ── 但这**不是**「端口被占就自动换」───────────────────────────────
//
// ADR-072 §7 的硬要求：**端口占用要明确报错退出，不静默换端口**。
//
// 理由很实在：静默换端口会让人以为「驾驶舱起在 4321」，实际不是。
// 人拿着 4321 的 URL 访问，访问到的是**另一个项目的驾驶舱** ——
// 这比「起不来」危险得多（对着错的看板签字）。
//
// 所以这两件事必须分开：
//   - 端口被占 → 明确报错退出（不许偷偷换）
//   - 显式要系统分配（--port 0）→ 系统给空闲端口，并**打印出来**
//
// 后者是**人明说要的**，端口从一开始就是「随便一个空闲的」，
// 不存在「以为它在 4321」的误解。
//
// 本文件钉住三件事：
//   1. `--port 0` 起得来，且打印的 URL 里是**实际端口**
//   2. `--port 0` 起两个 → 拿到**两个不同**的端口（不撞）
//   3. 端口占用仍然**明确报错退出**（不许偷偷换 —— ADR-072 §7）

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';

const TEST_DIR = join(tmpdir(), `zelto-web-port0-${Date.now()}`);
const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');

/** 起一个 `zelto web` 进程，等到它把 URL 打印出来。 */
async function startWeb(
  args: string[],
): Promise<{ proc: ChildProcess; url: string | null; output: string }> {
  const proc = spawn('node', [CLI_SCRIPT, 'web', ...args], {
    cwd: TEST_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  let url: string | null = null;
  const found = new Promise<void>((resolve) => {
    const onData = (c: Buffer) => {
      output += c.toString();
      const m = output.match(/驾驶舱已启动：(http:\/\/127\.0\.0\.1:\d+)/);
      if (m?.[1]) {
        url = m[1];
        resolve();
      }
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
  });

  await Promise.race([
    found,
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error(`驾驶舱没在 20 秒内启动。输出：\n${output}`)), 20_000),
    ),
  ]);

  return { proc, url, output };
}

function stop(proc: ChildProcess): void {
  proc.kill('SIGTERM');
}

describe('zelto web --port 0 —— 系统分配空闲端口', () => {
  before(async () => {
    await mkdir(join(TEST_DIR, '.zelto', 'slices'), { recursive: true });
    await mkdir(join(TEST_DIR, '.zelto', 'events'), { recursive: true });
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('--port 0 起得来，且打印的 URL 里是实际端口（不是 0）', async () => {
    const { proc, url } = await startWeb(['--port', '0']);
    try {
      assert.ok(url, '必须打印出 URL');
      assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);

      // 实际端口必须是一个**真的**端口，不是 0
      const port = Number.parseInt(url.split(':').pop() ?? '', 10);
      assert.ok(Number.isInteger(port) && port > 0, `实际端口必须是正整数，实际 ${port}`);
      assert.notEqual(port, 0, '不能把 0 当成实际端口打印出来');

      // 而且那个端口真的能访问
      const res = await fetch(`${url}/api/health`);
      assert.equal(res.status, 200);
    } finally {
      stop(proc);
    }
  });

  it('--port 0 起两个 → 拿到两个不同的端口（多开不撞）', async () => {
    const a = await startWeb(['--port', '0']);
    const b = await startWeb(['--port', '0']);
    try {
      assert.ok(a.url && b.url, '两个都必须打印出 URL');
      assert.notEqual(a.url, b.url, `两个实例必须拿到不同端口，实际都是 ${a.url}`);
    } finally {
      stop(a.proc);
      stop(b.proc);
    }
  });

  it('--port 0 时必须明说「端口由系统分配」（否则人还惦记着 4321）', async () => {
    const { proc, output } = await startWeb(['--port', '0']);
    try {
      assert.match(output, /系统分配/, '必须告诉人端口是系统给的');
    } finally {
      stop(proc);
    }
  });

  it('--help 里要写清 --port 0 的用法', async () => {
    const proc = spawn('node', [CLI_SCRIPT, 'web', '--help'], {
      cwd: TEST_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    proc.stdout?.on('data', (c: Buffer) => {
      output += c.toString();
    });
    proc.stderr?.on('data', (c: Buffer) => {
      output += c.toString();
    });
    await new Promise<void>((resolve) => {
      proc.on('close', () => resolve());
      setTimeout(() => {
        proc.kill('SIGKILL');
        resolve();
      }, 10_000);
    });
    assert.match(output, /--port 0/, '帮助里必须提到 --port 0');
    assert.match(output, /系统分配|空闲端口/, '帮助里必须说清它的语义');
  });

  // ── 守住 ADR-072 §7：端口占用仍然明确报错，不偷偷换 ──────────────────

  it('端口被占仍然明确报错退出（不许偷偷换端口）', async () => {
    // 先占住一个端口
    const first = await startWeb(['--port', '0']);
    try {
      assert.ok(first.url, '第一个实例必须起来');
      const port = first.url.split(':').pop() ?? '';

      // 第二个实例用**同一个**端口 → 必须报错，不许换
      const second = spawn('node', [CLI_SCRIPT, 'web', '--port', port], {
        cwd: TEST_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let errOut = '';
      second.stdout?.on('data', (c: Buffer) => {
        errOut += c.toString();
      });
      second.stderr?.on('data', (c: Buffer) => {
        errOut += c.toString();
      });
      const code = await new Promise<number>((resolve) => {
        second.on('close', (c) => resolve(c ?? 1));
        setTimeout(() => {
          second.kill('SIGKILL');
          resolve(-1);
        }, 10_000);
      });

      assert.notEqual(code, 0, '端口被占时不该成功退出');
      assert.match(errOut, /端口|占用/, `应当说清端口占用，实际：${errOut}`);
      // 关键：**不许**偷偷换端口后假装成功
      assert.doesNotMatch(
        errOut,
        /驾驶舱已启动/,
        '端口被占时绝不许启动成功 —— 静默换端口会让人对着错的看板操作',
      );
    } finally {
      stop(first.proc);
    }
  });

  // ── 非法端口仍然拒绝 ──────────────────────────────────────────────────

  it('非法端口仍然拒绝启动（负数 / 超范围 / 非数字）', async () => {
    for (const bad of ['-1', '70000', 'abc', '4321abc', '']) {
      const proc = spawn('node', [CLI_SCRIPT, 'web', '--port', bad], {
        cwd: TEST_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      proc.stdout?.on('data', (c: Buffer) => {
        out += c.toString();
      });
      proc.stderr?.on('data', (c: Buffer) => {
        out += c.toString();
      });
      const code = await new Promise<number>((resolve) => {
        proc.on('close', (c) => resolve(c ?? 1));
        setTimeout(() => {
          proc.kill('SIGKILL');
          resolve(-1);
        }, 10_000);
      });
      assert.notEqual(code, 0, `端口 "${bad}" 应当被拒绝`);
      assert.doesNotMatch(out, /驾驶舱已启动/, `端口 "${bad}" 不该启动成功`);
    }
  });
});
