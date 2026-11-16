// ADR-072：Web 驾驶舱的安全与范围测试
//
// 这个测试守住 ADR-072 里**三件被明确决定过的事**：
//
//   1. **CSRF 防线**（§3）：写操作必须同时带会话 token 与同源 Origin。
//      ADR-010 §9 原写的缓解措施（「无 session/cookie」）恰恰是 CSRF 成立的前提，
//      如果照它实现，**任何网页都能替人签字**。
//      本测试直接模拟那个攻击：第三方 Origin + 无 token → 必须被拒。
//
//   2. **范围收窄**（§4）：除了签字，**没有任何写操作**。
//      run / gate / freeze / admit / abandon / resume 一律 404/405 ——
//      它们在 CLI 侧有完整实现，Web 侧再实现一份会分叉判定。
//
//   3. **服务端强制四项确认项**（§5.2）：签字不是「一键批准」——
//      有确认项不过时，服务端必须拒绝（409），哪怕前端说「都过了」。
//
// 另外守：路径穿越（`:id` 过滤）、跨源读（不发 CORS 头）、只绑本机。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { validId } from '../src/adapters/web/server.js';

const TEST_DIR = join(tmpdir(), `zelto-web-security-${Date.now()}`);
const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');
const PORT = 4407;
const BASE = `http://127.0.0.1:${PORT}`;

let server: ChildProcess | null = null;

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: TEST_DIR,
    encoding: 'utf-8',
    timeout: 20_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

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

/** 造一个切片状态文件 */
async function writeSlice(
  id: string,
  opts: { writes?: string[]; trace?: boolean } = {},
): Promise<void> {
  const now = new Date().toISOString();
  const slice = {
    id,
    title: `Slice ${id}`,
    state: 'completed',
    spec: { path: `specs/slices/${id}.md`, frozenHash: 'hash', frozenAt: now },
    acceptance: { dir: `tests/acceptance/${id}/`, frozenHash: null, oracleSrc: null },
    baseCommit: null,
    drift: { detected: false, reason: null, at: null },
    trace: opts.trace === false
      ? { requirements: [], contracts: [], tests: [] }
      : { requirements: ['req-1'], contracts: [], tests: ['test-1'] },
    traceWaiver: null,
    baseline: false,
    writes: opts.writes ?? ['src/feature.ts'],
    runs: [],
    stall: { class: null, autoResolved: 0, gateRetries: 0 },
    createdAt: now,
    updatedAt: now,
  };
  await writeFile(
    join(TEST_DIR, '.zelto', 'slices', `${id}.json`),
    JSON.stringify(slice, null, 2),
    'utf-8',
  );
}

/** 造一个已批准的签字请求 */
async function writeApprovedSign(sliceId: string): Promise<string> {
  const now = new Date().toISOString();
  const id = `sign-${sliceId}-approved`;
  const req = {
    id,
    sliceId,
    requestedAt: now,
    requestedBy: 'human',
    status: 'approved',
    decidedAt: now,
    decidedBy: 'human',
    comment: null,
  };
  await writeFile(
    join(TEST_DIR, '.zelto', 'locks', `${id}.json`),
    JSON.stringify(req, null, 2),
    'utf-8',
  );
  return id;
}

/** 造一个待签字的请求 */
async function writePendingSign(sliceId: string): Promise<string> {
  const now = new Date().toISOString();
  const id = `sign-${sliceId}-pending`;
  const req = {
    id,
    sliceId,
    requestedAt: now,
    requestedBy: 'human',
    status: 'pending',
    decidedAt: null,
    decidedBy: null,
    comment: null,
  };
  await writeFile(
    join(TEST_DIR, '.zelto', 'locks', `${id}.json`),
    JSON.stringify(req, null, 2),
    'utf-8',
  );
  return id;
}

/** 造一条让四项确认项全绿的 gate.result 事件 */
async function writePassingGateEvent(sliceId: string): Promise<void> {
  const dir = join(TEST_DIR, '.zelto', 'events', sliceId);
  await mkdir(dir, { recursive: true });
  const event = {
    ts: new Date().toISOString(),
    runSeq: 1,
    slice: sliceId,
    run: null,
    type: 'gate.result',
    actor: 'zelto',
    payload: {
      passed: true,
      acceptance: { status: 'passed', path: null, command: 'acceptance', durationMs: 1 },
      results: [{ command: 'acceptance', passed: true, stdout: '# pass 3\n# fail 0\n' }],
    },
  };
  await writeFile(join(dir, 'events.jsonl'), JSON.stringify(event) + '\n', 'utf-8');
}

describe('zelto web —— 安全与范围（ADR-072）', () => {
  before(async () => {
    await mkdir(join(TEST_DIR, '.zelto', 'slices'), { recursive: true });
    await mkdir(join(TEST_DIR, '.zelto', 'events'), { recursive: true });
    await mkdir(join(TEST_DIR, '.zelto', 'locks'), { recursive: true });
    await mkdir(join(TEST_DIR, 'specs', 'slices'), { recursive: true });
    await mkdir(join(TEST_DIR, 'src'), { recursive: true });

    await writeFile(join(TEST_DIR, 'src', 'feature.ts'), 'export const x = 1;\n', 'utf-8');
    await writeFile(join(TEST_DIR, '.gitignore'), '.zelto/\n', 'utf-8');

    git('init', '-b', 'main');
    git('config', 'user.email', 'test@zelto.local');
    git('config', 'user.name', 'zelto test');
    git('add', '-A');
    git('commit', '-m', 'init');

    server = spawn('node', [CLI_SCRIPT, 'web', '--port', String(PORT)], {
      cwd: TEST_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // 等端口起来
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

  // ── ① CSRF 防线 ───────────────────────────────────────────────────────

  it('CSRF：第三方 Origin + 无 token 的签字请求被拒（ADR-072 §3）', async () => {
    await writeSlice('csrf-slice');
    const signId = await writePendingSign('csrf-slice');

    const res = await req(`/api/sign-requests/${signId}/approve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // 第三方网页的 Origin —— 这正是 CSRF 请求长什么样
        Origin: 'https://evil.example.com',
      },
      body: '{}',
    });

    assert.equal(res.status, 403, `第三方 Origin 必须被拒，实际：${res.status} ${res.raw}`);
    assert.match(res.raw, /Origin/);

    // 关键：**签字请求必须还是 pending** —— 光看状态码不够
    const check = JSON.parse(
      await readFile(join(TEST_DIR, '.zelto', 'locks', `${signId}.json`), 'utf-8'),
    );
    assert.equal(check.status, 'pending', 'CSRF 请求不该改变签字状态');
  });

  it('CSRF：同源但缺 token 的签字请求被拒', async () => {
    const signId = await writePendingSign('no-token-slice');
    await writeSlice('no-token-slice');

    const res = await req(`/api/sign-requests/${signId}/approve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: BASE,
      },
      body: '{}',
    });

    assert.equal(res.status, 403, `缺 token 必须被拒，实际：${res.status} ${res.raw}`);
    assert.match(res.raw, /token/i);
  });

  it('CSRF：token 错误时被拒', async () => {
    const signId = await writePendingSign('bad-token-slice');
    await writeSlice('bad-token-slice');

    const res = await req(`/api/sign-requests/${signId}/approve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: BASE,
        'X-Zelto-Token': 'f'.repeat(64),
      },
      body: '{}',
    });

    assert.equal(res.status, 403, `错 token 必须被拒，实际：${res.status} ${res.raw}`);
  });

  it('CSRF：跨源读被堵 —— 响应里没有 CORS 放行头', async () => {
    const res = await req('/api/slices');
    assert.equal(res.status, 200);
    assert.equal(
      res.headers.get('access-control-allow-origin'),
      null,
      '发 CORS 放行头等于让第三方网页读本地状态 —— 绝不能发',
    );
  });

  // ── ② 范围收窄：除签字外没有写操作 ────────────────────────────────────

  it('范围：run / gate / freeze / admit / abandon / resume 一律不存在（ADR-072 §4）', async () => {
    await writeSlice('scope-slice');
    const token = await readSessionToken();
    const paths = [
      '/api/slices/scope-slice/run',
      '/api/slices/scope-slice/gate',
      '/api/slices/scope-slice/freeze',
      '/api/slices/scope-slice/admit',
      '/api/slices/scope-slice/abandon',
      '/api/slices/scope-slice/resume',
      '/api/slices/scope-slice/clarify',
    ];
    for (const p of paths) {
      const res = await req(p, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Zelto-Token': token },
        body: '{}',
      });
      assert.equal(res.status, 404, `${p} 不该存在，实际返回 ${res.status}`);
    }
  });

  it('范围：创建切片也不在 Web 侧（创建要走 D-4 规格/写集一致性判定）', async () => {
    const token = await readSessionToken();
    const res = await req('/api/slices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Zelto-Token': token },
      body: JSON.stringify({ id: 'made-by-web', title: 'x' }),
    });
    assert.equal(res.status, 404, `创建切片不该在 Web 侧，实际返回 ${res.status}`);
  });

  // ── ③ 服务端强制四项确认项（不是一键批准）──────────────────────────

  it('签字：确认项不过时服务端拒绝（哪怕前端说都过了）（ADR-072 §5.2）', async () => {
    // 这片没有追溯链、没跑过验收 → 四项里至少两项不过
    await writeSlice('bad-checks-slice', { trace: false });
    const signId = await writePendingSign('bad-checks-slice');
    const token = await readSessionToken();

    const res = await req(`/api/sign-requests/${signId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Zelto-Token': token },
      body: JSON.stringify({
        // 前端声称「都过了」—— 服务端不信
        checks: [
          { label: '追溯链未断', ok: true, evidence: 'x', adrRef: 'y' },
          { label: '验收真跑过本片', ok: true, evidence: 'x', adrRef: 'y' },
          { label: '改动在写集内', ok: true, evidence: 'x', adrRef: 'y' },
          { label: '产物真落地', ok: true, evidence: 'x', adrRef: 'y' },
        ],
      }),
    });

    assert.equal(res.status, 409, `确认项不过必须被拒，实际：${res.status} ${res.raw}`);
    assert.ok(Array.isArray(res.body.checks), '拒绝时应当回传判定结果');
    assert.ok(
      res.body.checks.some((c: any) => c.ok === false),
      '回传的判定里应当有不过的项',
    );

    const check = JSON.parse(
      await readFile(join(TEST_DIR, '.zelto', 'locks', `${signId}.json`), 'utf-8'),
    );
    assert.equal(check.status, 'pending', '被拒后签字状态不该变');
  });

  it('签字：四项全绿时服务端放行，并提示「签字不等于合并」（ADR-018）', async () => {
    await writeSlice('good-checks-slice');
    await writePassingGateEvent('good-checks-slice');
    const signId = await writePendingSign('good-checks-slice');
    const token = await readSessionToken();

    const res = await req(`/api/sign-requests/${signId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Zelto-Token': token },
      body: '{}',
    });

    assert.equal(res.status, 200, `四项全绿应当放行，实际：${res.status} ${res.raw}`);
    assert.equal(res.body.ok, true);
    assert.match(res.body.nextStep, /签字不等于合并/, '必须提示签字≠合并（ADR-018）');

    const check = JSON.parse(
      await readFile(join(TEST_DIR, '.zelto', 'locks', `${signId}.json`), 'utf-8'),
    );
    assert.equal(check.status, 'approved', '签字状态应当已批准');
  });

  it('签字：已批准的请求不能重复批准', async () => {
    await writeSlice('twice-slice');
    await writePassingGateEvent('twice-slice');
    const signId = await writeApprovedSign('twice-slice');
    const token = await readSessionToken();

    const res = await req(`/api/sign-requests/${signId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Zelto-Token': token },
      body: '{}',
    });
    assert.equal(res.status, 409, `已批准的请求不该再批准，实际：${res.status}`);
  });

  // ── ④ 路径穿越 ────────────────────────────────────────────────────────

  it('路径穿越：带 ../ 的 id 被拒（400），不落到文件上', async () => {
    const res = await req('/api/slices/..%2F..%2Fetc%2Fpasswd');
    assert.equal(res.status, 400, `穿越 id 必须被拒，实际：${res.status} ${res.raw}`);
  });

  it('路径穿越：编码后的穿越原料不会命中任何切片', async () => {
    // WHATWG URL 解析器会在请求到达服务端**之前**规范化掉 `.` / `..` /
    // `%2e%2e` —— 所以这些形态根本进不了处理器。
    // 断言的是**结果**（不命中任何切片），不是具体状态码：
    // 规范化掉了就 404，绕过去了就 400，两种都不该是 200。
    for (const raw of ['..', '%2e%2e', '..%2f', '%2e%2e%2fetc%2fpasswd']) {
      const res = await req(`/api/slices/${raw}`);
      assert.notEqual(res.status, 200, `穿越原料 "${raw}" 不该命中任何切片，实际：${res.status}`);
    }
  });

  it('路径穿越：validId 本身挡住 . 与 ..（纵深防御，ADR-072 §7）', async () => {
    // 单元层断言 —— HTTP 上这些形态被 URL 规范化提前消解了，
    // 但 validId 仍是最后一道防线：它挡住 `.` / `..` 这两个
    // 符合字符集、却是穿越原料的特例。
    assert.equal(validId('..'), null, '.. 必须被 validId 挡住');
    assert.equal(validId('.'), null, '. 必须被 validId 挡住');
    assert.equal(validId('a/b'), null);
    assert.equal(validId('a b'), null);
    assert.equal(validId(''), null);
    assert.equal(validId(null), null);
    assert.equal(validId('ok-slice_1.2'), 'ok-slice_1.2');
  });

  it('路径穿越：非法字符的 id 被拒', async () => {
    for (const bad of ['a/b', 'a b', 'a$b']) {
      const res = await req(`/api/slices/${encodeURIComponent(bad)}`);
      assert.equal(res.status, 400, `非法 id "${bad}" 必须被拒，实际：${res.status}`);
    }
  });

  // ── ⑤ 只读面可用 ──────────────────────────────────────────────────────

  it('只读 API：切片总览 / 详情 / 事件 / 审计 / 概况都可用', async () => {
    const list = await req('/api/slices');
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.body));

    const detail = await req('/api/slices/good-checks-slice');
    assert.equal(detail.status, 200);
    assert.equal(detail.body.checks.length, 4, '详情页必须带四项确认项');
    assert.ok(detail.body.facts, '详情页必须带事实');
    const events = await req('/api/slices/good-checks-slice/events');
    assert.equal(events.status, 200);
    assert.ok(Array.isArray(events.body));

    const audit = await req('/api/slices/good-checks-slice/audit');
    assert.equal(audit.status, 200);

    const summary = await req('/api/summary');
    assert.equal(summary.status, 200);
    assert.ok(summary.body.totalSlices >= 1);

    const global = await req('/api/events?limit=10');
    assert.equal(global.status, 200);
  });

  it('首页：有 token、有导航、没有外链资源（不触网）', async () => {
    const res = await fetch(`${BASE}/`);
    const html = await res.text();
    assert.match(html, /__ZELTO_TOKEN__/);
    assert.match(html, /zelto 驾驶舱/);
    // 任何外链（http:// 或 https:// 的 src/href）都意味着页面会向外发请求
    const external = html.match(/(?:src|href)\s*=\s*["']https?:\/\/[^"']+/gi);
    assert.equal(external, null, `页面里有外链资源：${external}`);
  });

  it('首页：有横幅容器（签字提示活过轮询的关键）', async () => {
    const res = await fetch(`${BASE}/`);
    const html = await res.text();
    assert.match(html, /id="banner"/, '首页必须有横幅容器 —— 否则签字提示活不过一轮轮询');
  });

  // ── ⑥ 前端回归：三个实测出来的 UI 缺陷 ──────────────────────────────
  //
  // 这三个缺陷都出在前端 JS 里，肉眼看代码看不出来、点几下才发现。
  // 所以这里对**发出去的脚本**做断言 —— 脚本改了，这些测试就会红。
  //
  // 缺陷一：切片详情页被 5 秒轮询刷掉（人正在看的东西被抢走）
  // 缺陷二：签字成功提示被视图切换清掉（点了按钮什么都没发生，还以为失败了）
  // 缺陷三：轮询时页面塌陷成「加载中…」再重建（表格行跳、滚动位置丢）

  it('前端：轮询在详情页时必须停手（缺陷一）', async () => {
    const res = await fetch(`${BASE}/`);
    const html = await res.text();

    // 详情页状态用**独立变量**跟踪，不能靠 currentView 推断 ——
    // 详情页是从总览点进去的，那时 currentView 仍是 'overview'。
    assert.match(html, /let inDetail = false/, '必须有独立的详情页状态变量');
    assert.match(html, /inDetail = true/, '进详情页时必须置位');

    // 轮询的守卫必须只看 inDetail
    const pollBlock = html.slice(html.indexOf('pollTimer = setInterval'));
    assert.ok(pollBlock.length > 0, '找不到轮询代码');
    assert.match(
      pollBlock,
      /if \(inDetail\) return;/,
      '轮询必须在详情页时直接返回 —— 否则详情页会被刷掉',
    );

    // 旧写法（靠 currentView 推断）不能再出现
    assert.doesNotMatch(
      html,
      /currentView !== 'overview' && main\.querySelector/,
      '轮询守卫不能再靠 currentView 推断详情页 —— 那会把从总览点进的详情页刷掉',
    );
  });

  it('前端：视图函数必须接收显式的渲染目标（缺陷二的根因）', async () => {
    const res = await fetch(`${BASE}/`);
    const html = await res.text();

    // 视图函数不能写死往全局 main 里塞 —— 那样没法先渲染到离屏容器再整体替换
    for (const fn of ['viewOverview', 'viewSlices', 'viewSigns', 'viewEvents']) {
      assert.match(
        html,
        new RegExp(`async function ${fn}\\(target\\)`),
        `${fn} 必须接收 target 参数 —— 否则轮询刷新无法先离屏构建`,
      );
    }

    // main 必须是 const —— 一旦改成可变的全局，视图函数往哪儿渲染就取决于时序
    assert.match(html, /const main = document\.getElementById\('main'\)/, 'main 必须是 const');
    assert.doesNotMatch(html, /let main = document/, 'main 不能是可变全局 —— 那会引入渲染竞态');
  });

  it('前端：轮询刷新不得清空主区域（缺陷三）', async () => {
    const res = await fetch(`${BASE}/`);
    const html = await res.text();

    const fnStart = html.indexOf('async function refreshSilently');
    assert.ok(fnStart > 0, '找不到 refreshSilently');
    const fnEnd = html.indexOf('async function refreshSummary');
    const body = html.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 2000);

    // 刷新必须先渲染到离屏容器，成功后才整体替换
    assert.match(body, /document\.createElement\('div'\)/, '必须先构建离屏容器');
    assert.match(body, /await VIEWS\[view\]\(holder\)/, '必须渲染到离屏容器');
    assert.match(body, /while \(holder\.firstChild\) main\.appendChild/, '渲染成功后才整体替换');

    // 失败时保留原内容 —— catch 块里必须直接 return，不能碰主区域。
    // 断言方式：catch 块里的 return 必须排在 clear(main) **之前**
    // —— 这就证明了 clear(main) 在成功路径上，不在失败路径上。
    const catchIdx = body.indexOf('catch (err)');
    assert.ok(catchIdx > 0, '必须有 catch 分支');
    const returnIdx = body.indexOf('return;', catchIdx);
    const clearIdx = body.indexOf('clear(main)');
    assert.ok(returnIdx > catchIdx, 'catch 块里必须 return（保留原内容）');
    assert.ok(
      clearIdx > returnIdx,
      'clear(main) 必须排在 catch 的 return 之后 —— 否则失败时会把屏幕清空',
    );
  });

  it('前端：签字提示走独立横幅容器，且是追加不是覆盖（缺陷二）', async () => {
    const res = await fetch(`${BASE}/`);
    const html = await res.text();

    assert.match(html, /function showBanner\(className, text\)/, '必须有 showBanner');
    // 一次签字要显示两条（已签字 + 签字不等于合并）——
    // 清空式的写法会让后一条把前一条冲掉（实测只剩最后一条）
    const fnStart = html.indexOf('function showBanner');
    const fnEnd = html.indexOf('function clearBanner');
    const body = html.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 600);
    assert.match(body, /banner\.appendChild\(/, 'showBanner 必须是追加');
    assert.doesNotMatch(body, /clear\(banner\)/, 'showBanner 不能清空 —— 否则第二条提示会冲掉第一条');

    // 提示必须在视图切换**之后**追加
    const approveStart = html.indexOf('async function doApprove');
    const approveBody = html.slice(approveStart, approveStart + 2000);
    const renderIdx = approveBody.indexOf("await render('signs')");
    const bannerIdx = approveBody.indexOf('showBanner');
    assert.ok(renderIdx > 0, 'doApprove 里必须有视图切换');
    assert.ok(bannerIdx > renderIdx, '提示必须在视图切换之后追加 —— 否则会被一起清掉');
  });

  it('前端：只有 textContent，没有用 innerHTML 拼数据（XSS 防线）', async () => {
    const res = await fetch(`${BASE}/`);
    const html = await res.text();
    // innerHTML 出现在哪里都会可疑 —— 整个脚本里一处都不该有
    const uses = html.match(/\.innerHTML/g);
    assert.equal(uses, null, `前端不该用 innerHTML：${uses}`);
    const insertAdjacent = html.match(/insertAdjacentHTML/g);
    assert.equal(insertAdjacent, null, `前端不该用 insertAdjacentHTML：${insertAdjacent}`);
    // document.write 同理
    const docWrite = html.match(/document\.write/g);
    assert.equal(docWrite, null, `前端不该用 document.write：${docWrite}`);
  });

  it('端口占用时明确报错，不静默换端口', async () => {
    const res = await spawn('node', [CLI_SCRIPT, 'web', '--port', String(PORT)], {
      cwd: TEST_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    res.stderr.on('data', (c: Buffer) => {
      out += c.toString();
    });
    const code = await new Promise<number>((resolve) => {
      res.on('close', (c) => resolve(c ?? 1));
      setTimeout(() => {
        res.kill('SIGKILL');
        resolve(-1);
      }, 10_000);
    });
    assert.notEqual(code, 0, '端口被占用时不该成功退出');
    assert.match(out, /端口|占用/, `应当说清端口占用，实际：${out}`);
  });
});
