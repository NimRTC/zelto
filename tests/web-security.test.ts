// ADR-072：Web 驾驶舱的安全与范围测试
//
// 这个测试守住 ADR-072 里**三件被明确决定过的事**：
//
//   1. **CSRF 防线**（§3）：写操作必须同时带会话 token 与同源 Origin。
//      ADR-010 §9 原写的缓解措施（「无 session/cookie」）恰恰是 CSRF 成立的前提，
//      如果照它实现，**任何网页都能替人签字**。
//      本测试直接模拟那个攻击：第三方 Origin + 无 token → 必须被拒。
//
//   2. **范围收窄**（§4）：除签字外，**没有写操作**。
//      run / gate / freeze / admit / abandon / resume 一律 404/405 ——
//      它们在 CLI 侧有完整实现，Web 侧再实现一份会分叉判定。
//
//      **ADR-086 部分取代了这条**：run / gate / freeze / resume 搬进了驾驶舱，
//      但方式是**复用 core 编排**而不是重写判定。
//      仍然不开放的：admit / abandon / clarify / create。
//      （被取代的四个在 `web-cockpit-throttle.test.ts` 里验。）
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

/**
 * 「人确认过了这四项」的凭据 —— 四项全 ok。
 *
 * 内容**不作数**（服务端自己重算），只验形状。
 */
const FOUR_OK_CHECKS = [
  { label: '追溯链未断', ok: true, evidence: 'x', adrRef: 'y' },
  { label: '验收真跑过本片', ok: true, evidence: 'x', adrRef: 'y' },
  { label: '改动在写集内', ok: true, evidence: 'x', adrRef: 'y' },
  { label: '产物真落地', ok: true, evidence: 'x', adrRef: 'y' },
];

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

  // ── ② 范围收窄 ───────────────────────────────────────────────────────

  it('范围：admit / abandon / clarify / create 一律不存在', async () => {
    // ADR-086 把 run / gate / freeze / resume 搬进了驾驶舱（复用 core 判定），
    // 所以这条断言**缩小**为「仍未开放的写操作」。
    //
    // ADR-072 §4 的排除清单**部分**被 ADR-086 取代 —— 被取代的四个
    // 在 `web-cockpit-throttle.test.ts` 里验；这里守住**没被取代的**那些。
    await writeSlice('scope-slice');
    const token = await readSessionToken();
    const paths = [
      '/api/slices/scope-slice/admit',
      '/api/slices/scope-slice/abandon',
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

  it('范围：ADR-086 开放的四个端点**确实存在**（不是 404）', async () => {
    // 反向断言：光断言「别的端点不存在」不能证明新端点装上了 ——
    // 路由没匹配到也是 404，那跟「不存在」长得一模一样。
    //
    // **用 GET 探，不真 POST**：
    // 这四个端点只接受 POST，而 POST /run 会**真的拉起 CLI 子进程**
    // （fire-and-forget），POST /gate 会真的跑命令。
    // 探路用的请求不该有副作用 —— 尤其不该在临时目录里留下子进程，
    // 那会让清理阶段 EBUSY。
    //
    // GET 拿到 **405**（Method Not Allowed）恰恰证明「路由匹配到了、
    // 只是方法不对」—— 404 说明路由不存在，405 说明存在且只收 POST。
    await writeSlice('scope-slice');
    const token = await readSessionToken();
    const paths = [
      '/api/slices/scope-slice/run',
      '/api/slices/scope-slice/gate',
      '/api/slices/scope-slice/freeze',
      '/api/slices/scope-slice/resume',
    ];
    for (const p of paths) {
      const res = await req(p, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json', 'X-Zelto-Token': token },
      });
      assert.equal(res.status, 405, `${p} 应当存在（GET 得 405），实际返回 ${res.status}`);
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
      body: JSON.stringify({ checks: FOUR_OK_CHECKS }),
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
      body: JSON.stringify({ checks: FOUR_OK_CHECKS }),
    });
    assert.equal(res.status, 409, `已批准的请求不该再批准，实际：${res.status}`);
  });

  // ── ③b 「先看后签」的凭据（ADR-072 §5.2）─────────────────────────
  //
  // ADR-072 §5.2 原文：
  //   「POST 必须带四项判定结果，且四项全 ok 才执行签字」
  //   「只把前端传的当作『人确认过了这四项』的凭据」
  //
  // 「四项全 ok」由**服务端重算**保证（上面的测试已经守）；
  // 这一组守的是另一半：**必须带**。
  //
  // 为什么「带」本身有意义：
  // 服务端不信任前端传的内容（自己重算），所以内容真假不影响安全。
  // 但「有没有带」是一个**流程信号** —— 没带就说明人没在页面上
  // 看过那四项（或者有人绕过前端直接调 API）。
  // 两种情况都不该被签字。

  it('签字：不带确认项凭据必须被拒（人没确认过就不能签）', async () => {
    await writeSlice('no-ack-slice');
    await writePassingGateEvent('no-ack-slice');
    const signId = await writePendingSign('no-ack-slice');
    const token = await readSessionToken();

    // body 里没有 checks —— 模拟「绕过前端直接调 API」
    const res = await req(`/api/sign-requests/${signId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Zelto-Token': token },
      body: '{}',
    });

    assert.equal(res.status, 409, `缺凭据必须被拒，实际：${res.status} ${res.raw}`);
    assert.match(res.body.reason, /确认项凭据/, `拒绝理由要说清是缺凭据，实际：${res.body.reason}`);

    const check = JSON.parse(
      await readFile(join(TEST_DIR, '.zelto', 'locks', `${signId}.json`), 'utf-8'),
    );
    assert.equal(check.status, 'pending', '被拒后签字状态不该变');
  });

  it('签字：确认项凭据不足四项必须被拒', async () => {
    await writeSlice('few-ack-slice');
    await writePassingGateEvent('few-ack-slice');
    const signId = await writePendingSign('few-ack-slice');
    const token = await readSessionToken();

    const res = await req(`/api/sign-requests/${signId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Zelto-Token': token },
      body: JSON.stringify({ checks: FOUR_OK_CHECKS.slice(0, 2) }),
    });

    assert.equal(res.status, 409, `凭据不足四项必须被拒，实际：${res.status} ${res.raw}`);
    assert.match(res.body.reason, /至少要有 4 项/, `理由要说清缺了几项，实际：${res.body.reason}`);
  });

  it('签字：凭据里有一项没过也允许提交（人看到了失败项也算确认过）', async () => {
    await writeSlice('mixed-ack-slice');
    await writePassingGateEvent('mixed-ack-slice');
    const signId = await writePendingSign('mixed-ack-slice');
    const token = await readSessionToken();

    // 前端报「有一项没过」—— 这是**有效凭据**（人确实看到了）。
    // 放不放行由服务端重算决定，不在这里判断。
    const res = await req(`/api/sign-requests/${signId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Zelto-Token': token },
      body: JSON.stringify({
        checks: [
          { label: '追溯链未断', ok: true, evidence: 'x', adrRef: 'y' },
          { label: '验收真跑过本片', ok: false, evidence: '没过', adrRef: 'y' },
          { label: '改动在写集内', ok: true, evidence: 'x', adrRef: 'y' },
          { label: '产物真落地', ok: true, evidence: 'x', adrRef: 'y' },
        ],
      }),
    });

    // 服务端重算的结果才是准的 —— 这片服务端算出四项全绿 → 放行
    assert.equal(res.status, 200, `服务端重算全绿就放行，实际：${res.status} ${res.raw}`);
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

  // ── 文档对照：ADR-072 明确要求但之前没实现的 ────────────────────────
  //
  // 这一组守的是「文档写了、代码里没有」的缺口。
  // 三个缺口都是在「对照 ADR 逐条核」时发现的（不是测出来的）：
  //
  //   1. `/api/slices/:id/audit` 端点实现了，但**前端从不调用** ——
  //      ADR-072 §1 摘要与 §6 端点表都列了「审计」，
  //      而 ADR-010 §5.4 详情页设计的「📋 审计」按钮没人能用。
  //      「端点实现了却没人用」= 没实现。
  //   2. `POST /approve` 必须带四项判定结果作为「人确认过了」的凭据
  //      （§5.2）—— 之前前端传的是空对象。
  //   3. `/api/slices` 要含「追溯」明细、`/api/summary` 要含「成本」（§6）
  //      —— 之前追溯只给条目数，summary 完全没有成本。

  it('缺口一：前端必须真的调用审计端点（端点实现了却没人用 = 没实现）', async () => {
    const res = await fetch(`${BASE}/`);
    const html = await res.text();
    assert.ok(
      html.includes('/audit'),
      '前端必须调用 /api/slices/:id/audit —— ADR-072 §1/§6 都列了审计',
    );
  });

  it('缺口一：审计端点返回的形状前端能渲染（seq/timestamp/eventType/summary）', async () => {
    await writeSlice('audit-shape-slice');
    const audit = await req('/api/slices/audit-shape-slice/audit');
    assert.equal(audit.status, 200);
    assert.ok(Array.isArray(audit.body.entries), '审计必须有 entries 数组');
    // 形状契约 —— 前端按这几个字段渲染，字段名变了前端就白屏
    for (const e of audit.body.entries) {
      assert.ok('seq' in e, '审计条目必须有 seq');
      assert.ok('timestamp' in e, '审计条目必须有 timestamp');
      assert.ok('eventType' in e, '审计条目必须有 eventType');
      assert.ok('summary' in e, '审计条目必须有 summary');
    }
  });

  it('缺口三：切片总览带追溯明细（不只是条目数）', async () => {
    await writeSlice('trace-detail-slice');
    const list = await req('/api/slices');
    const row = list.body.find((s: any) => s.id === 'trace-detail-slice');
    assert.ok(row, '列表里应当有这片');
    assert.ok(Array.isArray(row.trace.requirements), '追溯需求必须是数组（明细），不是数字');
    assert.ok(Array.isArray(row.trace.contracts), '追溯契约必须是数组');
    assert.ok(Array.isArray(row.trace.tests), '追溯测试必须是数组');
    assert.ok(row.trace.counts, '同时保留计数 —— 列表页排版用');
    // 明细里应当真的有内容（writeSlice 造的是 req-1 / test-1）
    assert.ok(
      row.trace.requirements.includes('req-1'),
      `追溯明细里应当有 req-1，实际：${JSON.stringify(row.trace.requirements)}`,
    );
  });

  it('缺口三：概况含成本（已花费 / 上限 / 是否超支）', async () => {
    const summary = await req('/api/summary');
    assert.equal(summary.status, 200);
    assert.equal(typeof summary.body.spentUsd, 'number', '概况必须有已花费金额');
    assert.ok('limitUsd' in summary.body, '概况必须有预算上限');
    assert.equal(typeof summary.body.unlimited, 'boolean', '概况必须标明是否「不限」');
    assert.equal(typeof summary.body.exhausted, 'boolean', '概况必须标明是否超支');
    // 「不限」时 limitUsd 必须是 null 而不是 Infinity ——
    // JSON.stringify(Infinity) === 'null'，前端会显示成 $null
    if (summary.body.unlimited) {
      assert.equal(summary.body.limitUsd, null, '不限时上限应是 null');
    } else {
      assert.equal(typeof summary.body.limitUsd, 'number');
    }
  });

  // ── ADR-010 §5.3 里 ADR-072 §4 没有砍掉的只读端点 ──────────────────
  //
  // ADR-072 §4 砍掉的是**写操作**（run/gate/freeze/admit/abandon/resume/create），
  // 只读的度量与状态展示原本就在 ADR-010 §5.3 的范围里。
  // 人要求「都在驾驶舱里能看到」—— 这些端点补上。

  it('只读端点：度量 / 停机 / 策略 / 预算 / 全链 全部可用', async () => {
    const endpoints = ['/api/metrics', '/api/stalls', '/api/policy', '/api/budget', '/api/pipeline'];
    for (const path of endpoints) {
      const res = await req(path);
      assert.equal(res.status, 200, `${path} 应当可用，实际：${res.status} ${res.raw}`);
    }
  });

  it('只读端点：这些端点不许有写操作（POST 一律拒绝）', async () => {
    const token = await readSessionToken();
    for (const path of ['/api/metrics', '/api/stalls', '/api/policy', '/api/budget', '/api/pipeline']) {
      const res = await req(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Zelto-Token': token },
        body: '{}',
      });
      // 404 或 405 都行 —— 路由按 method 匹配，命中不了就是 404；
      // 关键是**不能是 2xx**（不能有写操作生效）
      assert.ok(
        res.status === 404 || res.status === 405,
        `${path} 不该接受 POST，实际：${res.status}`,
      );
    }
  });

  it('只读端点：策略端点必须给出规则与来源（不能是个空壳）', async () => {
    const res = await req('/api/policy');
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.exists, 'boolean', '必须标明策略是否存在');
    assert.ok(Array.isArray(res.body.rules), '必须有规则数组');
    // arch: 段也是策略的一部分 —— 只给 rules 会让人以为策略只有一条规则
    assert.ok(Array.isArray(res.body.arch), '必须带 arch 段（哪怕是空的）');
  });

  it('只读端点：全链端点必须诚实报出未归属的切片', async () => {
    const res = await req('/api/pipeline');
    assert.equal(res.status, 200);
    assert.ok(res.body.requirements, '必须有需求段');
    assert.ok(res.body.designs, '必须有设计段');
    assert.ok(res.body.plans, '必须有计划段');
    assert.ok(res.body.versions, '必须有版本段');
    assert.ok(res.body.slices, '必须有切片段');
    assert.ok(Array.isArray(res.body.slices.unassigned), '必须报出未归属的切片 —— 别让人以为漏了');
    assert.ok(res.body.slices.byVersion, '必须有按版本的归属统计');
  });

  it('只读端点：预算端点必须报出花费最高的切片（钱花在哪了）', async () => {
    const res = await req('/api/budget');
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.spentUsd, 'number');
    assert.ok(Array.isArray(res.body.topSpenders), '必须报出花费最高的切片');
  });

  it('前端：导航里必须有这 5 个新视图的入口', async () => {
    const res = await fetch(`${BASE}/`);
    const html = await res.text();
    for (const view of ['metrics', 'stalls', 'policy', 'budget', 'pipeline']) {
      assert.ok(
        html.includes(`data-view="${view}"`),
        `导航里必须有 ${view} 的入口 —— 端点实现了却没入口 = 人看不到`,
      );
    }
    // 视图函数必须真的存在（注册进 VIEWS）
    for (const fn of ['viewMetrics', 'viewStalls', 'viewPolicy', 'viewBudget', 'viewPipeline']) {
      assert.ok(html.includes(`function ${fn}`), `必须有 ${fn} 实现`);
    }
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

  // ── 连接断开的可发现性（D-35）────────────────────────────────────────
  //
  // 起因：服务是**前台进程**（ADR-072 §10，不是常驻 daemon），
  // Ctrl+C 就停 —— 但浏览器标签页还留着，屏幕上还是上一次渲染的样子。
  // 人看着一个「看起来正常但其实早已不更新」的页面，
  // 会以为那就是当前状态 —— **这比直接报错更危险**。
  //
  // 原实现：轮询把所有错误都吞了（catch 里直接 return），
  // 服务挂了页面纹丝不动、人毫无察觉。

  it('前端：连接断了必须给出可行动提示，不能只留一句 Failed to fetch', async () => {
    const res = await fetch(`${BASE}/`);
    const html = await res.text();

    // 1. 必须有连接状态条（独占容器，不与动作横幅混用）
    assert.ok(
      html.includes('id="conn"'),
      '页面必须有一个连接状态容器（服务停了要让人知道）',
    );

    // 2. 必须把 fetch 的裸异常翻译成人能行动的话
    assert.ok(
      html.includes('friendlyError'),
      '前端必须有错误翻译函数，把 fetch 的 TypeError 换成可行动的话',
    );
    assert.ok(
      html.includes('连不上 zelto 服务'),
      '连接失败必须明确说「连不上服务」',
    );
    assert.ok(
      html.includes('zelto web'),
      '提示必须告诉人下一步做什么（重新跑 zelto web）',
    );

    // 3. 断连提示与动作横幅必须**分开** ——
    //    动作横幅是追加语义，断连提示是独占语义，混一个容器会互相冲掉
    assert.ok(
      html.includes('const conn = document.getElementById(\'conn\')'),
      '断连提示必须有独立的元素引用',
    );
  });

  it('前端：轮询失败不能悄悄吞掉（否则页面看着正常其实早就没更新）', async () => {
    const res = await fetch(`${BASE}/`);
    const html = await res.text();

    // refreshSilently 的 catch 里必须记一笔失败，而不是直接 return
    const fnStart = html.indexOf('async function refreshSilently');
    assert.ok(fnStart > 0, '必须有 refreshSilently');
    const fnBody = html.slice(fnStart, fnStart + 1200);
    const catchIdx = fnBody.indexOf('catch');
    assert.ok(catchIdx > 0, 'refreshSilently 必须有 catch');
    const catchBody = fnBody.slice(catchIdx, catchIdx + 400);
    assert.ok(
      catchBody.includes('noteDisconnected'),
      '轮询失败必须调 noteDisconnected —— 静默 return 会让人对着过期数据做决策',
    );

    // 一次抖动不报，连续失败才算数
    assert.ok(
      html.includes('OFFLINE_AFTER'),
      '必须有连续失败阈值 —— 一次网络抖动不该报断连',
    );
  });

  it('前端：连接恢复后提示要自动消失', async () => {
    const res = await fetch(`${BASE}/`);
    const html = await res.text();
    const fnStart = html.indexOf('function noteConnected');
    assert.ok(fnStart > 0, '必须有 noteConnected');
    const fnBody = html.slice(fnStart, fnStart + 500);
    assert.ok(
      fnBody.includes("conn.dataset.msg = ''"),
      '恢复后必须清掉提示状态',
    );
    assert.ok(
      fnBody.includes("display = 'none'"),
      '恢复后必须把提示条隐藏',
    );
  });

  // ── ⑦ 驾驶舱三件事：工程名 / 事件去重 / 实时进度可感知 ────────────────
  //
  // 这三条都是「人打开页面就发现」的问题，不是安全面：
  //   1. 标题只有「zelto 驾驶舱」—— 开两个项目就分不清是哪个
  //   2. 事件页同一条 policy.decision 刷了上百行，真正有事的那条挤没了
  //   3. 页面静默轮询、内容不变时看着像死掉，人不知道它还在不在

  it('工程名：/api/project 返回工程名与根目录', async () => {
    const res = await req('/api/project');
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.name, 'string', '必须给出工程名');
    assert.ok(res.body.name.length > 0, '工程名不能是空串');
    assert.equal(res.body.root, TEST_DIR, '必须给出工程根目录');
  });

  it('工程名：项目有 project-map.json 时以它为准', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      join(TEST_DIR, '.zelto', 'project-map.json'),
      JSON.stringify({ projectName: 'nimrtc' }),
      'utf-8',
    );
    const res = await req('/api/project');
    assert.equal(res.body.name, 'nimrtc', '必须以 project-map.json 的 projectName 为准');
  });

  it('工程名：前端标题区有工程名占位，且会去拉 /api/project', async () => {
    const res = await fetch(`${BASE}/`);
    const html = await res.text();
    assert.ok(html.includes('id="project-name"'), '标题区必须有工程名位置');
    assert.ok(html.includes('/api/project'), '前端必须真的去拉 /api/project');
  });

  it('事件去重：相邻的完全重复事件被折叠成一条并带次数', async () => {
    const sliceId = 'dup-event-slice';
    const dir = join(TEST_DIR, '.zelto', 'events', sliceId);
    await mkdir(dir, { recursive: true });
    const payload = { decision: 'allow', path: 'src/a.ts' };
    const mk = (ts: string, type: string, p: Record<string, unknown>) =>
      JSON.stringify({ ts, runSeq: 1, slice: sliceId, run: null, type, actor: 'hook', payload: p });
    const lines = [
      mk('2026-01-01T00:00:01.000Z', 'policy.decision', payload),
      mk('2026-01-01T00:00:02.000Z', 'policy.decision', payload),
      mk('2026-01-01T00:00:03.000Z', 'policy.decision', payload),
      // 有差异的事件不能被折叠
      mk('2026-01-01T00:00:04.000Z', 'policy.decision', { decision: 'deny', path: 'src/a.ts' }),
    ];
    await writeFile(join(dir, 'events.jsonl'), lines.join('\n') + '\n', 'utf-8');

    const res = await req('/api/events?limit=200');
    assert.equal(res.status, 200);
    const rows = res.body.filter((e: any) => e.slice === sliceId);
    assert.equal(rows.length, 2, `相邻完全重复应折叠为 2 条，实际 ${rows.length}`);
    // 最新是一条 deny（不折），更早的三条 allow 折成一条、count=3
    const allow = rows.find((e: any) => (e.payload || {}).decision === 'allow');
    assert.ok(allow, '必须有 allow 那一条');
    assert.equal(allow.count, 3, `折叠后的次数应为 3，实际 ${allow.count}`);
    assert.equal(
      allow.since,
      '2026-01-01T00:00:01.000Z',
      '折叠行必须保留「从什么时候开始」—— otherwise 人以为它只发生过一次',
    );
  });

  it('事件去重：中间夹了别的事件就不折叠（那不是刷屏，是有节奏的动作）', async () => {
    const sliceId = 'interleaved-slice';
    const dir = join(TEST_DIR, '.zelto', 'events', sliceId);
    await mkdir(dir, { recursive: true });
    const mk = (ts: string, type: string) =>
      JSON.stringify({ ts, runSeq: 1, slice: sliceId, run: null, type, actor: 'hook', payload: {} });
    const lines = [
      mk('2026-01-02T00:00:01.000Z', 'policy.decision'),
      mk('2026-01-02T00:00:02.000Z', 'run.started'),
      mk('2026-01-02T00:00:03.000Z', 'policy.decision'),
    ];
    await writeFile(join(dir, 'events.jsonl'), lines.join('\n') + '\n', 'utf-8');

    const res = await req('/api/events?limit=200');
    const rows = res.body.filter((e: any) => e.slice === sliceId);
    assert.equal(rows.length, 3, '中间夹了别的事件，三条都应保留');
    assert.ok(rows.every((e: any) => (e.count ?? 1) === 1));
  });

  it('实时进度：running 切片带已运行时长与最后一条输出', async () => {
    const sliceId = 'running-progress-slice';
    const now = new Date();
    const startedAt = new Date(now.getTime() - 42_000).toISOString();
    await writeSlice(sliceId);
    // 把切片改成 running
    const slicePath = join(TEST_DIR, '.zelto', 'slices', `${sliceId}.json`);
    const { readFile: rf } = await import('node:fs/promises');
    const slice = JSON.parse(await rf(slicePath, 'utf-8'));
    slice.state = 'running';
    await writeFile(slicePath, JSON.stringify(slice, null, 2), 'utf-8');

    // 造一份会话文件：进程 pid 用当前测试进程（活着），带输出与启动时间
    const sessDir = join(TEST_DIR, '.zelto', 'sessions');
    await mkdir(sessDir, { recursive: true });
    await writeFile(
      join(sessDir, 'sess-1.json'),
      JSON.stringify({
        sessionId: 'sess-1',
        sliceId,
        status: 'running',
        startedAt,
        lastActivityAt: now.toISOString(),
        lastOutputAt: now.toISOString(),
        pid: process.pid,
        output: ['正在跑测试…\n', 'PASS schema.test.ts\n'],
      }),
      'utf-8',
    );

    const res = await req('/api/slices');
    const row = res.body.find((s: any) => s.id === sliceId);
    assert.ok(row, '列表里应当有这片');
    assert.equal(row.state, 'running');
    assert.ok(
      typeof row.elapsedMs === 'number' && row.elapsedMs >= 40_000,
      `必须有已运行时长（≥40s），实际：${row.elapsedMs}`,
    );
    assert.equal(
      row.progressLine,
      'PASS schema.test.ts',
      `进度行应是最后一条有内容的输出，实际：${JSON.stringify(row.progressLine)}`,
    );
    assert.ok(row.progressAt, '必须带上这条输出的时间');
  });

  it('实时进度：非 running 切片不伪造进度', async () => {
    await writeSlice('idle-progress-slice');
    const res = await req('/api/slices');
    const row = res.body.find((s: any) => s.id === 'idle-progress-slice');
    assert.equal(row.progressLine, null, '没在跑就不该有进度行');
    assert.equal(row.elapsedMs, null, '没在跑就不该有已运行时长');
  });

  it('实时进度：前端有进度列与刷新心跳（页面不能看着像死了）', async () => {
    const res = await fetch(`${BASE}/`);
    const html = await res.text();
    // 进度：已跑时长 + 最后一条输出
    assert.ok(html.includes('function progressCell'), '必须有进度单元格实现');
    assert.ok(html.includes('已跑 '), '进度必须显示已运行时长');
    // 刷新心跳：一个每轮都在走的时间戳，把「静默」和「死掉」区分开
    assert.ok(html.includes('id="refresh-line"'), '必须有刷新心跳元素');
    assert.ok(html.includes('function markRefresh'), '必须有刷新心跳的更新函数');
    assert.ok(html.includes('最后刷新'), '心跳必须说清「最后刷新」是什么时候');
    // 总览页必须有「正在运行」一节
    assert.ok(html.includes('正在运行'), '总览页必须有正在运行一节');
    // 断连时心跳不能还显示绿色（假心跳比不刷更糟）
    assert.ok(
      html.includes('已停止刷新'),
      '断连时心跳必须明确说「已停止刷新」',
    );
  });
});
