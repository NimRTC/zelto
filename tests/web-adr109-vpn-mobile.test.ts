// ADR-109：驾驶舱可对外可达（VPN 内网）＋ 手机端窄屏适配
//
// ── 为什么需要这个测试 ────────────────────────────────────────────────
//
// 需求：人在外面（手机走 VPN 连台式机）要能看进度、能重启切片开发。
//
// 落地时要跨**三道**原本只为本机设计的关卡：
//
//   1. **绑定面** —— 原先硬编码 `127.0.0.1`（ADR-072 §7），手机连不上。
//      本 ADR 决策三：默认不变，但要对外必须**显式** `--host`。
//
//   2. **Origin 校验** —— 原先判 `origin === this.url`（即等于启动时的地址）。
//      手机浏览器的 Origin 是 `http://192.168.x.x:4321` → **所有 POST 被 403**。
//      本 ADR 决策一：改成比对 `Host` 头（真正的同源判据）。
//
//   3. **窄屏** —— 13 处表格在手机上挤成一团。
//      本 ADR 决策四：纯 CSS 断点，表格转卡片。
//
// 而第 2 条**动的是 CSRF 防线** —— 所以本测试的重点是：
// **同源判据放宽之后，跨站请求必须依然被拒。**
//
// 那个「放宽」用词不准 —— 准确说是「**修正**」：
// 原判据在「换个地址访问」时会**误拒**真正的同源请求；
// 新判据（Origin ≡ Host）是浏览器同源策略自己的定义。
// 关键在于：**跨站请求的 Origin 永远不等于目标地址的 Host**。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { isLoopbackHost, isSameOrigin } from '../src/adapters/web/server.js';

const TEST_DIR = join(tmpdir(), `zelto-web-adr109-${Date.now()}`);
const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');
const PORT = 4419;
const BASE = `http://127.0.0.1:${PORT}`;

let server: ChildProcess | null = null;

interface Res {
  status: number;
  headers: Headers;
  body: any;
  raw: string;
}

async function req(
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Res> {
  const res = await fetch(`${BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: options.headers,
    body: options.body,
  });
  const raw = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  return { status: res.status, headers: res.headers, body, raw };
}

/** 从首页 HTML 里抠出会话 token —— 模拟浏览器读到了页面。 */
async function readSessionToken(): Promise<string> {
  const res = await fetch(`${BASE}/`);
  const html = await res.text();
  const m = html.match(/window\.__ZELTO_TOKEN__ = "([a-f0-9]+)"/);
  assert.ok(m, `首页里应当有会话 token，实际 HTML 开头：${html.slice(0, 400)}`);
  return m[1];
}

/** 造一个待签字的请求（写操作的存在性证明 —— 用来验证 POST 通路） */
async function writePendingSign(sliceId: string): Promise<string> {
  const now = new Date().toISOString();
  const id = `sign-${sliceId}-pending`;
  await writeFile(
    join(TEST_DIR, '.zelto', 'locks', `${id}.json`),
    JSON.stringify(
      {
        id,
        sliceId,
        requestedAt: now,
        requestedBy: 'human',
        status: 'pending',
        decidedAt: null,
        decidedBy: null,
        comment: null,
      },
      null,
      2,
    ),
    'utf-8',
  );
  return id;
}

describe('ADR-109 · 驾驶舱对外可达 + 手机端', () => {
  before(async () => {
    await mkdir(join(TEST_DIR, '.zelto', 'slices'), { recursive: true });
    await mkdir(join(TEST_DIR, '.zelto', 'events'), { recursive: true });
    await mkdir(join(TEST_DIR, '.zelto', 'locks'), { recursive: true });
    await mkdir(join(TEST_DIR, 'specs', 'slices'), { recursive: true });

    server = spawn('node', [CLI_SCRIPT, 'web', '--port', String(PORT)], {
      cwd: TEST_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        const res = await fetch(`${BASE}/api/summary`);
        if (res.ok) break;
      } catch {
        /* 还没起来 */
      }
      if (Date.now() > deadline) throw new Error('Web 驾驶舱没能在 20 秒内启动');
      await new Promise((r) => setTimeout(r, 200));
    }
  });

  after(async () => {
    if (server) {
      server.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 300));
      if (!server.killed) server.kill('SIGKILL');
    }
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  // ── ① Origin 判据：同源放行（ADR-109 决策一）────────────────────────
  //
  // 核心场景：**换地址访问**（手机走 VPN 拿到的是台式机的 VPN 网卡地址）。
  // 原判据 `origin === this.url` 在这里会误拒 —— 那正是本 ADR 要修的缺陷。

  it('同源：Origin 与 Host 头一致时，写操作放行到业务判定层', async () => {
    const signId = await writePendingSign('same-origin-slice');
    const token = await readSessionToken();

    // Origin 用 `127.0.0.1:PORT`，Host 头也是 `127.0.0.1:PORT` —— 同源。
    // 放行后应当走到**业务判定**（缺四项确认项 → 409），而不是传输层 403。
    const res = await req(`/api/sign-requests/${signId}/approve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Zelto-Token': token,
        Origin: BASE,
      },
      body: '{}',
    });

    assert.notEqual(res.status, 403, `同源不该被传输层拒（403 = Origin 校验失败），实际 ${res.status}`);
    assert.equal(res.status, 409, `应当走到业务判定（缺确认项 → 409），实际 ${res.status} ${res.raw}`);
  });

  it('同源：Origin 带 scheme、Host 头不带 scheme —— 比的是解析后的 host:port', async () => {
    // ── 为什么这条只能单元测 ────────────────────────────────────────
    //
    // Node 的 `fetch` **不允许覆盖 `Host` 头**（它是 forbidden header），
    // 所以「Host 头不带端口」这种形态在端到端测试里根本构造不出来。
    // 而它恰恰是**最需要验**的形态 ——
    // 「浏览器省略默认端口」与「Origin 带显式端口」必须能对上。
    //
    // 所以同源判据抽成了纯函数 `isSameOrigin`，直接单测。
    //
    // 这条测的是**两端形态不同**时的对齐：
    //   Origin: `http://a.com`        → 隐含端口 80
    //   Host:   `a.com`               → 补默认端口 80
    // → 应当判为同源
    assert.equal(isSameOrigin('http://a.com', 'a.com'), true, '两端都省默认端口 → 同源');
    assert.equal(isSameOrigin('http://a.com:80', 'a.com'), true, 'Origin 带默认端口、Host 省着 → 同源');
    assert.equal(isSameOrigin('http://a.com', 'a.com:80'), true, 'Host 带默认端口、Origin 省着 → 同源');
  });

  it('同源：端口不同 → 不同源（端口是同源的一部分）', async () => {
    // `http://a.com:4321` 与 `http://a.com:9999` 是不同源 ——
    // 只比 host 会把「同一台机器的不同端口」误判成同源。
    assert.equal(isSameOrigin('http://a.com:4321', 'a.com:9999'), false);
    assert.equal(isSameOrigin('http://a.com:4321', 'a.com:4321'), true);
    // 非默认端口不能被当成默认端口
    assert.equal(isSameOrigin('http://a.com:4321', 'a.com'), false);
  });

  it('同源：Origin 与 Host 头一致时，走的是「放行」而不是「放行到业务层」的边界', async () => {
    const signId = await writePendingSign('parsed-slice');
    const token = await readSessionToken();

    const res = await req(`/api/sign-requests/${signId}/approve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Zelto-Token': token,
        // Origin 后面带一个斜杠 —— 合法 URL，但**字符串不等于** BASE
        // （BASE 没有尾斜杠）。如果实现是「字符串相等」，这条会误拒。
        Origin: `${BASE}/`,
      },
      body: '{}',
    });

    assert.notEqual(res.status, 403, `Origin 带尾斜杠仍应判为同源，实际 ${res.status} ${res.raw}`);
  });

  it('同源：IPv6 两边形态一致（URL 的 hostname 带方括号，Host 头也可能裸写）', async () => {
    // `new URL('http://[::1]:4321').hostname === '[::1]'` —— **带方括号**。
    // 而 Host 头里 IPv6 可能写成 `[::1]:4321`（带括号，标准形态）
    // 或裸 `::1`（不带括号）。
    // 两边形态不一致就会让「本该同源的 IPv6 请求」被误拒。
    assert.equal(isSameOrigin('http://[::1]:4321', '[::1]:4321'), true, '带方括号的两边');
    assert.equal(isSameOrigin('http://[::1]:4321', '::1:4321'), false, '裸 IPv6 带端口 —— 端口解析不了，不该判同源');
    assert.equal(isSameOrigin('http://[::1]', '[::1]'), true, 'IPv6 默认端口');
  });

  it('同源：Host 头格式非法 → fail closed（判否，不放行）', async () => {
    assert.equal(isSameOrigin('http://a.com:4321', ''), false, '空 Host');
    assert.equal(isSameOrigin('http://a.com:4321', 'a.com:notaport'), false, '端口不是数字');
    assert.equal(isSameOrigin('http://a.com:4321', 'a.com:99999'), false, '端口超长');
  });

  it('同源：Origin 解析不出来 → fail closed（判否，不放行）', async () => {
    assert.equal(isSameOrigin('not-a-url', 'a.com:4321'), false);
    assert.equal(isSameOrigin('', 'a.com:4321'), false);
    // `null` 是浏览器对某些跨站请求发的字面 Origin —— 不是合法 URL → 判否
    assert.equal(isSameOrigin('null', 'a.com:4321'), false);
  });

  // ── ② CSRF 防线必须一点没弱（这是本 ADR 最要紧的一条）─────────────

  it('CSRF：第三方 Origin 与 Host 头不一致 → 写操作被拒（403）', async () => {
    const signId = await writePendingSign('csrf-slice');
    const token = await readSessionToken();

    const res = await req(`/api/sign-requests/${signId}/approve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Zelto-Token': token,
        // 第三方网页的 Origin —— Host 头仍然是目标地址，两者不等
        Origin: 'https://evil.example.com',
      },
      body: '{}',
    });

    assert.equal(res.status, 403, `第三方 Origin 必须被拒，实际 ${res.status} ${res.raw}`);
    assert.match(res.raw, /Origin/);
  });

  it('CSRF：Origin 与 Host 头一致但**缺 token** → 仍然被拒（授权仍靠 token）', async () => {
    const signId = await writePendingSign('same-origin-no-token');

    const res = await req(`/api/sign-requests/${signId}/approve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: BASE,
      },
      body: '{}',
    });

    assert.equal(res.status, 403, `同源但缺 token 必须被拒，实际 ${res.status} ${res.raw}`);
    assert.match(res.raw, /token/i);
  });

  it('CSRF：Origin 存在但**解析不出来** → 被拒（fail closed，不许当成空 Origin）', async () => {
    const signId = await writePendingSign('bad-origin-slice');
    const token = await readSessionToken();

    const res = await req(`/api/sign-requests/${signId}/approve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Zelto-Token': token,
        // 非法 URL —— 解析失败
        Origin: 'not-a-valid-url',
      },
      body: '{}',
    });

    assert.equal(res.status, 403, `解析不出来的 Origin 必须被拒（fail closed），实际 ${res.status} ${res.raw}`);
  });

  it('CSRF：Origin 为空（curl / 脚本）→ 放行到业务层（既有行为不变）', async () => {
    const signId = await writePendingSign('no-origin-slice');
    const token = await readSessionToken();

    const res = await req(`/api/sign-requests/${signId}/approve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Zelto-Token': token,
      },
      body: '{}',
    });

    assert.equal(res.status, 409, `空 Origin 应放行到业务判定（缺确认项 → 409），实际 ${res.status} ${res.raw}`);
  });

  it('CSRF：跨源读仍然被堵 —— 响应里没有 CORS 放行头（ADR-072 §3 不变）', async () => {
    const res = await req('/api/slices');
    assert.equal(res.status, 200);
    assert.equal(
      res.headers.get('access-control-allow-origin'),
      null,
      '发 CORS 放行头等于让第三方网页读本地状态 —— 绝不能发',
    );
  });

  // ── ③ 绑定面（ADR-109 决策三）──────────────────────────────────────

  it('绑定面：默认仍是 127.0.0.1（既有行为一字不变）', async () => {
    // 这个测试用的就是默认启动（before 里没传 --host）
    // —— 能从 127.0.0.1 连上，说明默认绑定面没被放开。
    const res = await req('/api/health');
    assert.equal(res.status, 200);
  });

  it('绑定面：isLoopbackHost 只认回环（127.x 整段 / ::1 / localhost）', async () => {
    assert.equal(isLoopbackHost('127.0.0.1'), true);
    assert.equal(isLoopbackHost('127.0.0.53'), true, '127.0.0.0/8 整段都是回环');
    assert.equal(isLoopbackHost('::1'), true);
    assert.equal(isLoopbackHost('[::1]'), true);
    assert.equal(isLoopbackHost('localhost'), true);
    assert.equal(isLoopbackHost('LOCALHOST'), true, '大小写不敏感');

    // **0.0.0.0 不是回环** —— 它是「所有网卡」的通配，正是最需要警示的那种
    assert.equal(isLoopbackHost('0.0.0.0'), false);
    assert.equal(isLoopbackHost('192.168.1.50'), false);
    assert.equal(isLoopbackHost('10.0.0.5'), false);
    assert.equal(isLoopbackHost('::'), false);
  });

  it('绑定面：--host 给了非法值 → 明确报错退出，不静默回退到回环', async () => {
    // **静默回退是最坏的失败形态**：人以为驾驶舱开在 0.0.0.0（手机能连），
    // 实际回退到 127.0.0.1（手机连不上）—— 症状是「明明配了却连不上」，
    // 比「起不来」难查得多。
    const proc = spawn('node', [CLI_SCRIPT, 'web', '--host', 'not a host'], {
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
    const code = await new Promise<number>((resolve) => {
      proc.on('close', (c) => resolve(c ?? 1));
      setTimeout(() => {
        proc.kill('SIGKILL');
        resolve(-1);
      }, 10_000);
    });
    assert.notEqual(code, 0, '非法绑定地址必须非零退出');
    assert.match(output, /绑定地址|host/i, `应当说清是绑定地址的问题，实际：${output}`);
  });

  it('绑定面：--host 非回环 → 启动时打印警示横幅（说清代价）', async () => {
    // 绑 0.0.0.0 会占用一台机器的所有网卡 —— 测试机上可能与别的服务冲突。
    // 用 127.0.0.2（**也是回环**，所以不会真的对外开）不行 ——
    // 那样就触发不了警示。所以这里用一个**明确的非回环**地址，
    // 但用 `--port 0` 拿空闲端口，且只验证**横幅文本**，
    // 不去真的连它（连不上也不影响本断言）。
    const proc = spawn('node', [CLI_SCRIPT, 'web', '--host', '0.0.0.0', '--port', '0'], {
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

    const deadline = Date.now() + 20_000;
    for (;;) {
      if (/绑定面已放开/.test(output)) break;
      if (Date.now() > deadline) {
        proc.kill('SIGKILL');
        throw new Error(`没等到警示横幅。实际输出：\n${output}`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    try {
      assert.match(output, /绑定面已放开/, '必须明确说「绑定面已放开」');
      // 横幅必须说清**代价** —— 不能只说「已放开」
      assert.match(output, /签字|token/, '必须说清同网设备能拿到 token 并替你签字');
    } finally {
      proc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 300));
      if (!proc.killed) proc.kill('SIGKILL');
    }
  });

  it('绑定面：--help 里要写清 --host 的用法与代价', async () => {
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
    assert.match(output, /--host/, '帮助里必须提到 --host');
    assert.match(output, /127\.0\.0\.1/, '帮助里必须说清默认值是回环');
  });

  // ── ④ 窄屏适配（ADR-109 决策四）────────────────────────────────────

  it('窄屏：页面里必须有窄屏断点（表格转卡片靠它）', async () => {
    const res = await fetch(`${BASE}/`);
    const html = await res.text();
    assert.match(html, /@media \(max-width: 720px\)/, '必须有窄屏断点');
    assert.match(html, /max-width: 720px/, '断点阈值必须出现');
  });

  it('窄屏：表格必须转卡片（table 脱离表格布局、thead 隐藏）', async () => {
    const res = await fetch(`${BASE}/`);
    const html = await res.text();
    // 表格转卡片的三步 —— 少一步就还是横向滚动
    assert.match(html, /table\s*\{[^}]*display:\s*block/s, 'table 必须转 display:block');
    assert.match(html, /thead\s*\{[^}]*display:\s*none/s, 'thead 必须隐藏（表头进每个单元格）');
    assert.match(html, /td\s*\{[^}]*display:\s*block/s, 'td 必须转块级');
  });

  it('窄屏：列名靠 data-label 显示（table() 助手必须挂上去）', async () => {
    const res = await fetch(`${BASE}/`);
    const html = await res.text();
    // CSS 侧
    assert.match(html, /attr\(data-label\)/, '必须用 attr(data-label) 显示列名');
    // JS 侧 —— 助手必须真的挂这个属性
    assert.match(html, /setAttribute\('data-label'/, 'table() 助手必须给每个 td 挂 data-label');
  });

  it('窄屏：按钮触摸目标够大（≥ 44px 高）与导航换行', async () => {
    const res = await fetch(`${BASE}/`);
    const html = await res.text();
    // 导航必须允许换行 —— 否则 9 个按钮横向溢出，人看不到后面的视图
    assert.match(html, /nav\s*\{[^}]*flex-wrap:\s*wrap/s, '导航必须允许换行');
    // 触摸目标：按钮内边距要加（iOS HIG 的 44px 下限）
    assert.match(html, /\.btn\s*\{[^}]*padding:\s*11px/s, '按钮内边距必须加大（实测 ≥44px）');
  });

  it('窄屏：断点之外零变化（桌面端排版不受影响）', async () => {
    const res = await fetch(`${BASE}/`);
    const html = await res.text();
    // 桌面端的关键排版必须**在** @media 之外
    // —— @media 段之前的 `main { max-width: 1200px }` 必须原样存在
    assert.match(html, /main \{ padding: 20px; max-width: 1200px; \}/, '桌面端 main 排版必须不变');
    assert.match(html, /\.kv \{ display: grid; grid-template-columns: 130px 1fr;/, '桌面端 kv 排版必须不变');
  });
});
