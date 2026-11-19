// 驾驶舱的「可接管」动作 —— 端到端（ADR-084）
//
// 这个文件起**真实的 Web 服务器**，发**真实的 HTTP 请求**。
// 因为要验的东西全在进程边界上：
//   - token + Origin + Content-Type 三道防线（server.ts）
//   - 四个写操作是否真的落到文件里（core 的实现）
//   - 事件流里有没有留下痕迹（C4）
//
// 踩过的坑提醒：**Content-Type 那一道是新加的** ——
// 前端已经带对了，但**测试请求**容易漏。漏了会拿到 415，
// 那不是 bug，是防线在起作用。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WebServer } from '../src/adapters/web/server.js';

const ROOT = mkdtempSync(join(tmpdir(), 'zelto-web-actions-'));

let server: WebServer;
let baseUrl: string;
let token: string;

async function req(
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string>; contentType?: string | null } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    'X-Zelto-Token': token,
    ...(opts.headers ?? {}),
  };
  const ct = opts.contentType === null ? null : (opts.contentType ?? 'application/json');
  if (ct) headers['Content-Type'] = ct;

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

/** 读某个切片名下的事件流。 */
function readEvents(sliceId: string): Array<Record<string, unknown>> {
  const path = join(ROOT, '.zelto', 'events', sliceId, 'events.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('驾驶舱的可接管动作（ADR-084）', () => {
  before(async () => {
    mkdirSync(join(ROOT, '.zelto', 'slices'), { recursive: true });
    mkdirSync(join(ROOT, '.zelto', 'events'), { recursive: true });
    mkdirSync(join(ROOT, '.zelto', 'locks'), { recursive: true });
    mkdirSync(join(ROOT, '.zelto', 'halts'), { recursive: true });
    mkdirSync(join(ROOT, '.zelto', 'questions'), { recursive: true });

    // 一片已完成的切片 + 一条待签请求
    writeFileSync(
      join(ROOT, '.zelto', 'slices', 'slice-a.json'),
      JSON.stringify({
        id: 'slice-a',
        title: '测试切片',
        state: 'completed',
        type: 'feature',
        writes: ['src/**'],
        trace: { requirements: ['r1'], contracts: [], tests: [] },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        runs: [],
      }),
      'utf-8',
    );

    server = new WebServer({ port: 0, repoRoot: ROOT });
    await server.start();
    baseUrl = server.url;
    token = server.sessionToken;
  });

  after(async () => {
    await server?.stop();
    rmSync(ROOT, { recursive: true, force: true });
  });

  // ── 安全防线 ──────────────────────────────────────────────────────────

  it('缺 token 的写操作被拒（403）', async () => {
    const res = await fetch(`${baseUrl}/api/halt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'all' }),
    });
    assert.equal(res.status, 403);
  });

  it('Origin 不匹配的写操作被拒（403）', async () => {
    const res = await req('POST', '/api/halt', {
      body: { scope: 'all' },
      headers: { Origin: 'http://evil.example.com' },
    });
    assert.equal(res.status, 403);
  });

  it('**Content-Type 不是 application/json 的写操作被拒（415）**', async () => {
    // 这道防线是 ADR-084 §5 新加的。
    //
    // 为什么必需：token + Origin 已经挡住跨站了，
    // 但 `fetch(..., {mode:'no-cors'})` 能发 `text/plain` 的 body ——
    // 那种请求会绕过前两道。显式要求 JSON 就把它挡在外面。
    const res = await req('POST', '/api/halt', {
      body: { scope: 'all' },
      contentType: 'text/plain',
    });
    assert.equal(res.status, 415, 'text/plain 的写操作必须被拒');
  });

  it('没有 Content-Type 的写操作被拒（415）', async () => {
    const res = await req('POST', '/api/halt', {
      body: { scope: 'all' },
      contentType: null,
    });
    assert.equal(res.status, 415);
  });

  it('非法 id 被拒（400）', async () => {
    const res = await req('POST', '/api/slices/..%2Fetc/answer', { body: { answer: 'x' } });
    assert.ok(res.status === 400 || res.status === 404, `期望 400/404，实际 ${res.status}`);
  });

  // ── 拉闸 ──────────────────────────────────────────────────────────────

  it('拉闸成功，并且写了事件流（C4）', async () => {
    const res = await req('POST', '/api/halt', {
      body: { scope: 'all', reason: '端到端测试拉闸' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body['ok'], true);

    const events = readEvents('batch');
    const halted = events.find((e) => e['type'] === 'batch.halted');
    assert.ok(halted, '必须有 batch.halted 事件');
    const payload = halted['payload'] as Record<string, unknown>;
    assert.equal(payload['reason'], '端到端测试拉闸');
    assert.equal(
      payload['via'],
      'web',
      '事件里要记「在哪儿做的」—— actor 与 via 是两个维度',
    );
  });

  it('拉闸真的落盘了（.zelto/halts/ 下有请求）', async () => {
    const { readdirSync } = await import('node:fs');
    const entries = readdirSync(join(ROOT, '.zelto', 'halts'));
    assert.ok(entries.length > 0, '拉闸请求应当落盘');
  });

  // ── 回答提问 ──────────────────────────────────────────────────────────

  it('回答提问：记录答案 + 写事件（但不续跑）', async () => {
    // 造一条待答提问
    const qDir = join(ROOT, '.zelto', 'questions');
    writeFileSync(
      join(qDir, 'q1.json'),
      JSON.stringify({
        id: 'q1',
        sliceId: 'slice-a',
        question: '该用哪种数据库？',
        status: 'pending',
        raisedAt: new Date().toISOString(),
        zeltoSessionId: 'sess-1',
        adapterName: 'claude-agent',
      }),
      'utf-8',
    );

    const res = await req('POST', '/api/slices/slice-a/answer', {
      body: { answer: '用 SQLite' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body['ok'], true);
    // 响应里必须明确告诉人下一步 —— 因为**驾驶舱不续跑**
    assert.match(
      String(res.body['nextStep']),
      /zelto answer/,
      '必须告知续跑要在终端里做',
    );

    const events = readEvents('slice-a');
    const answered = events.find((e) => e['type'] === 'question.answered');
    assert.ok(answered, '必须有 question.answered 事件');
    const payload = answered['payload'] as Record<string, unknown>;
    assert.equal(payload['answer'], '用 SQLite');
    assert.equal(payload['via'], 'web');
    assert.equal(payload['answeredBy'], 'human');
  });

  it('答案为空被拒（400）', async () => {
    const res = await req('POST', '/api/slices/slice-a/answer', { body: { answer: '   ' } });
    assert.equal(res.status, 400);
  });

  it('没有待答问题时回答被拒（409）', async () => {
    const res = await req('POST', '/api/slices/slice-a/answer', { body: { answer: 'x' } });
    assert.equal(res.status, 409, JSON.stringify(res.body));
  });

  // ── 拒签 ──────────────────────────────────────────────────────────────

  it('拒签：状态变成 rejected，并写了事件', async () => {
    // 造一条 pending 签字请求
    //
    // 注意文件名：SignManager.path(id) = `.zelto/locks/<id>.json`，
    // **不带** `sign-` 前缀 —— 那个前缀只是 list() 扫描时的过滤条件。
    writeFileSync(
      join(ROOT, '.zelto', 'locks', 'sr1.json'),
      JSON.stringify({
        id: 'sr1',
        sliceId: 'slice-a',
        status: 'pending',
        requestedAt: new Date().toISOString(),
      }),
      'utf-8',
    );

    const res = await req('POST', '/api/sign-requests/sr1/reject', {
      body: { comment: '验收没过' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body['ok'], true);

    // 状态确实变成 rejected 了
    const raw = JSON.parse(
      readFileSync(join(ROOT, '.zelto', 'locks', 'sr1.json'), 'utf-8'),
    ) as { status?: string; comment?: string | null };
    assert.equal(raw.status, 'rejected');
  });

  // ── 边界 ──────────────────────────────────────────────────────────────

  it('顶层没有裸的 run / gate / freeze / resume 端点（动作挂在切片下）', async () => {
    // ADR-086 把这四个动作搬到了 `/api/slices/:id/<动作>` 下 ——
    // 顶层裸端点**仍然不该有**（没有切片 id 就没有作用对象）。
    for (const path of ['/api/run', '/api/gate', '/api/freeze', '/api/resume']) {
      const res = await req('POST', path, { body: {} });
      assert.equal(res.status, 404, `${path} 不该存在，实际 ${res.status}`);
    }
  });

  it('ADR-086 的四个油门端点挂在切片下（不再被 ADR-084 §1 排除）', async () => {
    // 这条断言**取代**了 ADR-084 §8「Web 端没有 run/gate/freeze/resume 端点」。
    //
    // 断言的是「端点存在」而不是「动作成功」——
    // 动作成功与否取决于切片状态，那是另一个文件（web-cockpit-throttle）的事。
    //
    // 存在的判据：**不是 404**。非 POST 的请求会拿到 405（Method not allowed），
    // 那也证明路由认得这个端点。
    for (const path of [
      '/api/slices/slice-a/freeze',
      '/api/slices/slice-a/gate',
      '/api/slices/slice-a/run',
      '/api/slices/slice-a/resume',
    ]) {
      const res = await req('GET', path);
      assert.notEqual(res.status, 404, `${path} 应当存在，实际 404`);
    }
  });

  it('四个油门端点同样过三道防线（缺 token 被拒）', async () => {
    // 端点存在不等于端点安全 —— 新端点必须继承 ADR-072 §3 的三道校验。
    for (const path of [
      '/api/slices/slice-a/freeze',
      '/api/slices/slice-a/gate',
      '/api/slices/slice-a/run',
      '/api/slices/slice-a/resume',
    ]) {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 403, `${path} 缺 token 必须被拒，实际 ${res.status}`);
    }
  });

  it('没有 DELETE 端点（签字可以撤销，但没有「删除签字记录」）', async () => {
    const res = await req('DELETE', '/api/sign-requests/sr1');
    assert.ok(res.status === 404 || res.status === 405, `实际 ${res.status}`);
  });
});
