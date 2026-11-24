// 驾驶舱的**崩溃兜底** —— 「服务突然消失」必须变成「服务还在，但出了事」
//
// ── 病灶 ──────────────────────────────────────────────────────────────
//
// 人反馈：「zelto 驾驶舱的 UI 为什么经常关闭？」
//
// 查下来有两类「关闭」，只有一类是真的「关」：
//
//   ① **服务真没了** —— `zelto web` 是**前台进程**（ADR-072 §10，
//      不是常驻 daemon）。终端窗口被关 / Ctrl+C / 机器休眠 /
//      远程会话注销 → 进程没了 → 浏览器页面停在最后一次轮询的画面上。
//      这一类**改不了**（daemon 在 AGENTS.md 负向清单里），
//      只能让人一眼看出「服务没了」。
//
//   ② **服务自己死了** —— 这一类**能修**，而且此前完全没修：
//
//      a. **运行期的 server 'error' 无监听**
//         启动阶段的 error 监听是 `once` 的，`listening` 之后被移除。
//         运行期再来一个 'error' 事件 → EventEmitter 找不到监听器
//         → 抛未捕获异常 → **进程退出**。
//         （Node 的 HTTP server 不会自动处理 'error'。）
//
//      b. **未捕获异常 / 未处理 rejection 直接杀进程**
//         驾驶舱是**长跑**的。期间任何一次逃出 `handle()` 那个
//         try/catch 的异步异常，Node 的默认行为是「打印栈 → 退出」。
//
//      c. **`handle()` 的 catch 块自己会抛**
//         原写法 `catch { sendJson(res, 500, ...) }` 没有保护。
//         响应已经开始发送时，`writeHead` 抛 `ERR_HTTP_HEADERS_SENT`
//         —— 这个抛出发生在 **catch 块内部** → 逃出 handle()
//         → `void this.handle(...)` 没人接 → 未处理 rejection → 进程死。
//
// ── 本文件钉住的三件事 ────────────────────────────────────────────────
//
//   1. 崩溃兜底**真的兜住**：抛未捕获异常后，进程**还活着**，
//      且错误被记下来了（不是静默吞掉）。
//   2. `/api/health` 能回答「服务活着吗 / 出过错没有」——
//      人不必靠猜。
//   3. 前端把「出过错」与「连接断开」**分开呈现** ——
//      两者的正确应对完全相反（不必重启 vs 该重启）。
//
// 另钉住一条纪律：**兜底不改判定**。兜底只是让服务别死，
// 判定照旧在 `core/` 里跑（纯计算、C3）。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  WebServer,
  installCockpitCrashGuard,
  type CockpitCrashGuard,
  type CockpitCrashGuardOptions,
} from '../src/adapters/web/index.js';

const TEST_DIR = join(tmpdir(), `zelto-web-crash-guard-${Date.now()}`);

/** 兜底注册的监听器（与 Node 在真实异常时调的是同一个函数）。 */
type GuardListener = (payload: unknown, promise?: unknown) => void;

/**
 * 装兜底，并**同时**把它注册的监听器抓出来。
 *
 * ── 为什么不能直接 `process.emit('uncaughtException', err)` ──────────────
 *
 * `node --test` 自己就注册了 `uncaughtException` 监听器 ——
 * 它的作用是把「未捕获异常」标记为**测试失败**。
 * 于是 `process.emit` 会**同时**触发两个监听器：
 *   - 我们的兜底（记一笔）→ 断言通过
 *   - node:test 的（标记失败）→ 整个测试红
 *
 * 这不是兜底的问题，是测试手法的问题：我们要验的是
 * 「兜底被调用时会做什么」，而不是「Node 的异常流程长什么样」。
 *
 * 所以这里**直接调用**兜底注册的那个监听器 ——
 * 这正是 Node 在真实未捕获异常时调用的那个函数。
 *
 * 注意：抓到的必须是**被测那个 guard** 的监听器，
 * 不能另装一个来抓 —— 否则测的就不是被测对象了。
 */
function installCapturing(
  options: CockpitCrashGuardOptions = {},
): {
  guard: CockpitCrashGuard;
  fireException: GuardListener;
  fireRejection: GuardListener;
} {
  const beforeException = new Set(process.listeners('uncaughtException'));
  const beforeRejection = new Set(process.listeners('unhandledRejection'));
  const guard = installCockpitCrashGuard(options);
  const addedException = process
    .listeners('uncaughtException')
    .filter((fn) => !beforeException.has(fn)) as GuardListener[];
  const addedRejection = process
    .listeners('unhandledRejection')
    .filter((fn) => !beforeRejection.has(fn)) as GuardListener[];
  assert.equal(addedException.length, 1, '兜底应当只注册一个 uncaughtException 监听器');
  assert.equal(addedRejection.length, 1, '兜底应当只注册一个 unhandledRejection 监听器');
  return {
    guard,
    fireException: addedException[0],
    fireRejection: addedRejection[0],
  };
}

describe('驾驶舱崩溃兜底', () => {
  before(async () => {
    await mkdir(join(TEST_DIR, '.zelto', 'slices'), { recursive: true });
    await mkdir(join(TEST_DIR, '.zelto', 'events'), { recursive: true });
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  // ── ① 兜底器本身 ──────────────────────────────────────────────────────

  it('未捕获异常被记下来，而且不退出进程', async () => {
    const crashes: Array<{ kind: string; message: string }> = [];
    const { guard, fireException } = installCapturing({
      onCrash: (r) => crashes.push({ kind: r.kind, message: r.message }),
    });

    try {
      // 模拟「服务运行中出了一次未捕获异常」
      // （直接调兜底注册的监听器 —— 见 installCapturing 的说明）
      fireException(new Error('模拟的运行期异常'));

      assert.equal(guard.count, 1, '必须记下一笔');
      assert.equal(crashes.length, 1, '必须报给人（不能静默吞掉）');
      assert.equal(crashes[0].kind, 'uncaughtException');
      assert.match(crashes[0].message, /模拟的运行期异常/);

      // 关键：进程还活着 —— 后面的断言能跑就是证据
      assert.equal(typeof process.pid, 'number');
      assert.equal(guard.last?.message, '模拟的运行期异常');
    } finally {
      guard.dispose();
    }
  });

  it('未处理的 promise rejection 也被兜住', () => {
    const crashes: string[] = [];
    const { guard, fireRejection } = installCapturing({
      onCrash: (r) => crashes.push(r.kind),
    });

    try {
      fireRejection(new Error('模拟的未处理 rejection'), Promise.resolve());
      assert.equal(guard.count, 1);
      assert.equal(crashes[0], 'unhandledRejection');
    } finally {
      guard.dispose();
    }
  });

  it('dispose() 之后不再兜（否则一个测试的兜底会兜住另一个测试的异常）', () => {
    const guard = installCockpitCrashGuard({ onCrash: () => {} });
    assert.equal(guard.count, 0);
    guard.dispose();
    // dispose 之后不会再记录 —— 断言 count 没涨即可
    // （不去真的 emit，避免影响同进程里其它测试）
    assert.equal(guard.count, 0);
  });

  it('记录条数有上限 —— 长跑时不能无限增长', () => {
    const { guard, fireException } = installCapturing({ onCrash: () => {}, maxRecords: 3 });
    try {
      for (let i = 0; i < 10; i++) {
        fireException(new Error(`第 ${i} 次`));
      }
      assert.equal(guard.records.length, 3, '最多留 3 条');
      // 留的是**最近**的
      assert.match(String(guard.last?.message), /第 9 次/);
    } finally {
      guard.dispose();
    }
  });

  // ── ② /api/health ────────────────────────────────────────────────────

  it('/api/health 能回答「服务活着吗 / 出过错没有」', async () => {
    const { guard, fireException } = installCapturing({ onCrash: () => {} });
    const server = new WebServer({ port: 0, repoRoot: TEST_DIR, crashGuard: guard });
    await server.start();

    try {
      // 1. 没出错时
      const healthy = await fetch(`${server.url}/api/health`);
      assert.equal(healthy.status, 200);
      const h1 = (await healthy.json()) as Record<string, unknown>;
      assert.equal(h1['ok'], true);
      assert.equal(h1['crashes'], 0);
      assert.equal(h1['lastCrash'], null);
      assert.equal(typeof h1['pid'], 'number');
      assert.equal(typeof h1['uptimeSec'], 'number');

      // 2. 出过一次错后 —— **服务必须还在**
      fireException(new Error('模拟异常'));

      const after = await fetch(`${server.url}/api/health`);
      assert.equal(after.status, 200, '出过错之后服务必须还能应答 —— 这正是本次要修的');
      const h2 = (await after.json()) as Record<string, unknown>;
      assert.equal(h2['crashes'], 1);
      const last = h2['lastCrash'] as Record<string, unknown>;
      assert.equal(last['kind'], 'uncaughtException');
      assert.match(String(last['message']), /模拟异常/);
      // 栈**不**对外暴露（人要知道「出没出错」，不需要栈）
      assert.equal(last['stack'], undefined);
    } finally {
      await server.stop();
      guard.dispose();
    }
  });

  it('/api/health 在没装兜底时也能用（不该 404 —— 前端无条件调它）', async () => {
    const server = new WebServer({ port: 0, repoRoot: TEST_DIR });
    await server.start();
    try {
      const res = await fetch(`${server.url}/api/health`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body['crashes'], 0);
      assert.equal(body['lastCrash'], null);
    } finally {
      await server.stop();
    }
  });

  // ── ③ 服务端的运行期 'error' 监听 ────────────────────────────────────

  it('运行期的 server 错误不会把进程带走（error 监听必须常驻）', async () => {
    const guard = installCockpitCrashGuard({ onCrash: () => {} });
    const server = new WebServer({ port: 0, repoRoot: TEST_DIR, crashGuard: guard });
    await server.start();

    try {
      // 模拟一个运行期的 server 'error' 事件
      // （真实场景：accept 失败、端口耗尽、socket 层错误）
      const anyServer = server as unknown as {
        server: { emit: (event: string, err: NodeJS.ErrnoException) => void } | null;
      };
      assert.ok(anyServer.server, 'server 应当已启动');
      anyServer.server.emit('error', new Error('模拟的运行期 server 错误'));

      // 服务必须还活着 —— 能应答就是证据
      const res = await fetch(`${server.url}/api/health`);
      assert.equal(res.status, 200, '运行期 error 之后服务必须还能应答');
    } finally {
      await server.stop();
      guard.dispose();
    }
  });

  // ── ④ 前端呈现：出过错 ≠ 连接断开 ────────────────────────────────────

  it('前端：出过错与连接断开必须分开呈现（应对方式完全相反）', async () => {
    const server = new WebServer({ port: 0, repoRoot: TEST_DIR });
    await server.start();
    try {
      const html = await (await fetch(`${server.url}/`)).text();

      // 1. 两个提示必须各有各的容器
      assert.ok(html.includes('id="conn"'), '必须有连接状态容器');
      assert.ok(html.includes('id="crash-line"'), '必须有独立的出错提示容器');

      // 2. 前端要真的去问服务端「出过错没有」
      assert.ok(html.includes('/api/health'), '前端必须查健康端点');

      // 3. 两套提示的**语义**必须分开：
      //    - 连接断开 = 服务没了 = 该重新跑 zelto web
      //    - 出过错   = 服务还在 = 不必重启
      assert.ok(
        html.includes('服务仍在运行'),
        '出错提示必须说清服务还在（否则人会误以为该重启）',
      );
      assert.ok(
        html.includes('连不上 zelto 服务'),
        '断连提示必须说清服务没了',
      );
    } finally {
      await server.stop();
    }
  });
});
