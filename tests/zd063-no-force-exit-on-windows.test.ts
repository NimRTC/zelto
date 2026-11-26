// ZD-063：测试进程不许硬退（Windows + Node>=23 的 libuv 断言崩溃）
//
// ── 病灶（实测本机 Node 24.16.0 / Windows，2026-11-27）──────────────
//
//   `npm run test:unit` 偶发红 2~3 个测试文件。但**没有一个断言不通过**：
//
//     Assertion failed: !(handle->flags & UV_HANDLE_CLOSING),
//     file src\win\async.c, line 94
//
//   崩在**进程退出时**（测试用例全绿之后）。表现是「测试红了，
//   但你找不到哪条断言错了」——
//   这比红更坏：红会告诉你「有问题」，这里告诉你的是「有鬼」。
//
// ── 根因 ──────────────────────────────────────────────────────────────
//
//   `scripts/filter-tests.mjs` 恒定传 `--test-force-exit`。
//   那个 flag 让 node --test 在测试跑完后**立刻 `process.exit()`**。
//
//   而 Node 内置 `fetch` 走 **undici 的全局连接池**：
//   跑过 **2 次及以上** fetch 后，池里就有一个 keep-alive 的 socket。
//   `process.exit()` 时它还没被关 → Node 调 `uv_async_send`
//   去通知一个已被 `uv_close` 标记 `UV_HANDLE_CLOSING` 的句柄
//   → libuv 直接断言崩溃。
//
//   这是 **Node 自身的 bug**，不是 zelto 的：
//     - nodejs/node#56645（Windows + Node 23.x 起必现）
//     - nodejs/node#61999 已修，但**还没进任何已发布版本**
//
//   复现的最小形状（**与 zelto 无关**，纯 node:http + 纯 fetch）：
//
//     const server = createServer((q, r) => r.end('{}'));
//     server.listen(0, '127.0.0.1', async () => {
//       const p = server.address().port;
//       await (await fetch(`http://127.0.0.1:${p}/a`)).json();   // 1 次 → 不崩
//       await (await fetch(`http://127.0.0.1:${p}/b`)).json();   // 2 次 → 崩
//       process.exit(0);
//     });
//
//   注：`server.close()` **救不了** —— 崩的是连接池里的客户端 socket。
//
// ── 本文件钉住的 ──────────────────────────────────────────────────────
//
//   1. **最小复现**：纯 node:http + 2 次 fetch + `process.exit()`，
//      真的会崩（不崩就说明 Node 修好了 —— 那时本文件会红，
//      是**好事**：说明可以去掉绕行方案了）。
//   2. **我们的测试脚本不再传 `--test-force-exit`** ——
//      判据是**读脚本源码**，不是「跑一遍看看绿不绿」
//      （绿不绿是概率，源码是事实）。
//   3. 兜底在位：传了 `--test-timeout`，挂住的用例会报**超时**
//      而不是让整个进程吊死。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';

// 测试跑在 `dist-test/tests/` 下，仓库根要往上数两级。
// （`import.meta.dirname` 在这里指向 `dist-test/tests`，不是仓库根。）
const ROOT = join(import.meta.dirname, '..', '..');

describe('ZD-063：测试进程不许硬退', () => {
  // ── ① 最小复现：证明这个 bug 还在 ──────────────────────────────────
  //
  // 这条测试**故意**在子进程里跑会崩的形状。
  // 它不测 zelto 的行为，测的是「触发条件还成立吗」。
  //
  // 为什么要有它：Node 什么时候修好，我们不知道。
  // 修好的那天，这条测试会红 —— 那正是我们该把绕行方案（不传 force-exit）
  // 和注释一起清掉的信号。没有它，绕行会永远留着，没人知道为什么。
  it('最小复现：2 次 fetch 后 process.exit() 会触发 libuv 断言', () => {
    const script = `
      const { createServer } = require('node:http');
      const server = createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
      server.listen(0, '127.0.0.1', async () => {
        const port = server.address().port;
        await (await fetch('http://127.0.0.1:' + port + '/a')).json();
        await (await fetch('http://127.0.0.1:' + port + '/b')).json();
        // 不关 server —— server.close() 救不了（崩的是 undici 客户端池）
        process.exit(0);
      });
    `;
    // 用临时文件而不是 `--eval`：`--eval` 在 node --test 下不被识别。
    const scriptPath = join(tmpdir(), `zelto-zd063-${process.pid}-${Date.now()}.cjs`);
    writeFileSync(scriptPath, script, 'utf-8');
    try {
      const result = spawnSync(process.execPath, [scriptPath], {
        encoding: 'utf-8',
        timeout: 60_000,
      });
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      const crashed = output.includes('UV_HANDLE_CLOSING');
      assert.ok(
        crashed,
        '这个最小复现本该崩，但没崩。\n' +
          '若 Node 已修（nodejs/node#61999），说明绕行方案可以撤了 ——\n' +
          '请同时删掉 filter-tests.mjs 里「不传 --test-force-exit」的说明与理由。\n' +
          `实际输出：\n${output}`,
      );
    } finally {
      rmSync(scriptPath, { force: true });
    }
  });

  // ── ② 我们的脚本不再硬退 ───────────────────────────────────────────
  //
  // 判据读**源码**而不是跑结果：跑结果的绿是概率，
  // 源码里没有那个 flag 才是事实。
  it('filter-tests.mjs 不再传 --test-force-exit', () => {
    const src = readFileSync(join(ROOT, 'scripts', 'filter-tests.mjs'), 'utf-8');
    // 只看代码，不看注释（注释里解释「为什么不用它」，提到它是应该的）
    const code = src
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
    assert.ok(
      !code.includes('--test-force-exit'),
      'scripts/filter-tests.mjs 还在传 --test-force-exit —— ' +
        '那会在 Windows + Node>=23 上触发 libuv 断言崩溃（ZD-063）。',
    );
  });

  // ── ③ 兜底在位：挂了要报超时，不是吊死 ────────────────────────────
  it('有 --test-timeout 兜底', () => {
    const src = readFileSync(join(ROOT, 'scripts', 'filter-tests.mjs'), 'utf-8');
    assert.ok(
      src.includes('--test-timeout='),
      'scripts/filter-tests.mjs 必须传 --test-timeout —— ' +
        '去掉 --test-force-exit 后没有硬退兜底了，' +
        '挂住的用例会吊死整个测试进程。',
    );
  });

  // ── ④ 形状自检：单次 fetch 不该崩（对照组）─────────────────────────
  //
  // 记录「1 次与 2 次的差别」这件事本身 —— 如果哪天 1 次也崩了，
  // 说明 Node 那边又变了，得重新查。
  it('对照组：1 次 fetch 不崩', async () => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/a`);
    await res.json();
    assert.equal(res.status, 200);
    await new Promise<void>((r) => server.close(() => r()));
  });
});
